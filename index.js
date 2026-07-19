// Smart Web Search - SillyTavern extension
// Gives your local model live web results, either on every message or only
// when a message looks like it needs current/real-world info OR references
// something the model likely doesn't know well (not just "recent" things).

import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, generateQuietPrompt } from "../../../../script.js";

const extensionName = "smart-web-search";

const defaultSettings = {
    enabled: true,
    mode: "smart",              // "always" | "smart"
    backend: "plugin",          // "plugin" | "searxng" | "serpapi"
    pluginRoute: "/api/plugins/smart-web-search/search",
    searxngUrl: "http://localhost:8080",
    serpapiKey: "",              // only used if backend === "serpapi" (NOT recommended, see README)
    resultCount: 4,
    knowledgeCutoffYear: 2023,   // set this to your model's training cutoff year
    // AI-assist now does two jobs: (1) catches things the keyword list misses,
    // like niche topics/entities that aren't about "recency" at all, and
    // (2) is used to produce a clean search query when it fires. Recommended on.
    aiAssist: true,
    timeoutMs: 6000,
    cacheMinutes: 10,
    debug: false,
};

const TIME_KEYWORDS = [
    "today", "currently", "current", "latest", "recent", "recently",
    "this week", "this month", "this year", "right now", "nowadays",
    "up to date", "breaking news", "just announced", "just released",
    "still alive", "still the", "net worth", "richest", "world record",
    "release date", "new version", "newest", "update me on", "news about",
    "who is the current", "who is the ceo", "who is the president",
    "election", "score", "stock price", "exchange rate", "weather in",
];

// Used only to clean up a query for the FAST heuristic path (no extra LLM
// call). The AI-assist path does its own, smarter query extraction.
const FILLER_PREFIXES = [
    /^(bro|dude|yo+|hey|hi|so|okay|ok|um+|uh+|hmm+|man|listen|look|well)[,!.]?\s+/i,
];
const WRAPPER_PHRASES = [
    /\bhave you heard about\b/gi,
    /\bdo you know about\b/gi,
    /\bwhat do you know about\b/gi,
    /\bcan you tell me about\b/gi,
    /\btell me about\b/gi,
];

function cleanQueryHeuristic(text) {
    let q = text.trim();
    let prev;
    do {
        prev = q;
        for (const re of FILLER_PREFIXES) q = q.replace(re, "");
    } while (q !== prev);
    q = q.replace(/\([^)]*\)/g, " ");                 // drop parentheticals
    for (const re of WRAPPER_PHRASES) q = q.replace(re, " ");
    q = q.replace(/\s+/g, " ").trim();
    q = q.replace(/[?!.,]+$/g, "").trim();
    return q || text.trim();
}

const searchCache = new Map(); // query -> { text, ts }

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const s = extension_settings[extensionName];
    for (const key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = defaultSettings[key];
        }
    }
    return s;
}

function saveSettings() {
    saveSettingsDebounced();
}

function log(...args) {
    if (getSettings().debug) console.log(`[${extensionName}]`, ...args);
}

// --- Fast heuristic: obviously time-sensitive stuff, no LLM call needed ----

function heuristicNeedsSearch(text, settings) {
    if (!text) return false;
    const lower = text.toLowerCase();

    const yearMatches = lower.match(/\b(19|20)\d{2}\b/g);
    if (yearMatches) {
        for (const y of yearMatches) {
            if (parseInt(y, 10) > settings.knowledgeCutoffYear) return true;
        }
    }

    for (const kw of TIME_KEYWORDS) {
        if (lower.includes(kw)) return true;
    }

    return false;
}

// --- AI-assist: catches everything the keyword list can't, because it's
// not about recency at all - it's "do I actually know this topic well?"
// Also doubles as query extraction so we don't need a second LLM call. -----

async function aiAnalyzeMessage(text) {
    const prompt =
        `User message: "${text}"\n\n` +
        `Decide whether answering this well would require looking something up - ` +
        `specific facts, named people/places/brands/products, media titles, niche or ` +
        `obscure topics, or anything you might only partially know or could get wrong. ` +
        `This includes long-standing niche topics you might know imprecisely, not just recent events.\n\n` +
        `If yes, also write a short, focused web search query: 2-8 words, just the core ` +
        `topic/entity, no filler words, no "bro"/"uh"/greetings, no meta-commentary like ` +
        `"(just testing you)".\n\n` +
        `Respond in EXACTLY this format and nothing else:\n` +
        `SEARCH: yes or no\n` +
        `QUERY: <short search query, or NONE if SEARCH is no>`;

    try {
        const result = await generateQuietPrompt({ quietPrompt: prompt });
        const searchMatch = /SEARCH:\s*(yes|no)/i.exec(result ?? "");
        const queryMatch = /QUERY:\s*(.+)/i.exec(result ?? "");
        const shouldSearch = searchMatch ? /yes/i.test(searchMatch[1]) : null;
        let query = queryMatch ? queryMatch[1].trim().replace(/^["']|["']$/g, "") : null;
        if (query && /^none$/i.test(query)) query = null;
        return { shouldSearch, query };
    } catch (e) {
        log("aiAssist analysis failed, falling back to heuristic-only", e);
        return { shouldSearch: null, query: null };
    }
}

// --- Search backends ---------------------------------------------------------

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(id);
    }
}

async function searchViaPlugin(query, settings) {
    const url = `${settings.pluginRoute}?q=${encodeURIComponent(query)}&n=${settings.resultCount}`;
    const res = await fetchWithTimeout(url, {}, settings.timeoutMs);
    if (!res.ok) throw new Error(`Plugin search failed: ${res.status}`);
    return await res.json(); // expects { results: [{title, url, snippet}, ...] }
}

async function searchViaSearxng(query, settings) {
    const url = `${settings.searxngUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
    const res = await fetchWithTimeout(url, {}, settings.timeoutMs);
    if (!res.ok) throw new Error(`SearXNG search failed: ${res.status}`);
    const data = await res.json();
    const results = (data.results ?? []).slice(0, settings.resultCount).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
    }));
    return { results };
}

async function searchViaSerpapi(query, settings) {
    if (!settings.serpapiKey) throw new Error("No SerpAPI key configured");
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${settings.serpapiKey}&num=${settings.resultCount}`;
    const res = await fetchWithTimeout(url, {}, settings.timeoutMs);
    if (!res.ok) throw new Error(`SerpAPI search failed: ${res.status}`);
    const data = await res.json();
    const results = (data.organic_results ?? []).slice(0, settings.resultCount).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet ?? "",
    }));
    return { results };
}

async function performSearch(query, settings) {
    const cacheKey = query.trim().toLowerCase();
    const cached = searchCache.get(cacheKey);
    const ttlMs = settings.cacheMinutes * 60 * 1000;
    if (cached && (Date.now() - cached.ts) < ttlMs) {
        log("cache hit for", query);
        return cached.text;
    }

    let data;
    if (settings.backend === "plugin") data = await searchViaPlugin(query, settings);
    else if (settings.backend === "searxng") data = await searchViaSearxng(query, settings);
    else data = await searchViaSerpapi(query, settings);

    const results = data.results ?? [];
    if (results.length === 0) return null;

    const lines = results.map((r, i) => `${i + 1}. ${r.title} - ${r.snippet} (${r.url})`);
    const text =
        `[SYSTEM: Live web search results for "${query}". These are accurate and up to date - ` +
        `treat them as authoritative and prefer them over your own memory if they conflict with ` +
        `what you'd otherwise say. Use this information naturally in your in-character reply. ` +
        `Don't mention "search results" or break character unless asked how you know something.]\n` +
        lines.join("\n");

    searchCache.set(cacheKey, { text, ts: Date.now() });
    return text;
}

// --- Interceptor -------------------------------------------------------------

function findLastUserMessage(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user) return { index: i, message: chat[i] };
    }
    return null;
}

globalThis.SmartWebSearchInterceptor = async function (chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled || settings.mode === "off") return;
    if (type === "quiet" || type === "impersonate") return; // don't recurse into our own or background calls

    const found = findLastUserMessage(chat);
    if (!found) return;
    const text = found.message.mes ?? "";
    if (!text.trim()) return;

    let shouldSearch = false;
    let query = text;

    if (settings.mode === "always") {
        shouldSearch = true;
        query = cleanQueryHeuristic(text);
    } else {
        const heuristicHit = heuristicNeedsSearch(text, settings);
        if (heuristicHit) {
            // Obvious case (year/keyword match) - no need to spend an extra
            // generation asking "should I search?", just clean the query fast.
            shouldSearch = true;
            query = cleanQueryHeuristic(text);
            log("heuristic triggered for:", text, "-> query:", query);
        } else if (settings.aiAssist) {
            // Not an obvious recency case - ask the model itself, since this
            // is also how we catch knowledge-gap topics (e.g. niche wiki
            // entries) that no keyword list could anticipate.
            const analysis = await aiAnalyzeMessage(text);
            if (analysis.shouldSearch === true) {
                shouldSearch = true;
                query = analysis.query || cleanQueryHeuristic(text);
                log("aiAssist triggered for:", text, "-> query:", query);
            } else {
                log("aiAssist declined to search for:", text);
            }
        }
    }

    if (!shouldSearch) {
        log("skipping search for:", text);
        return;
    }

    try {
        const resultText = await performSearch(query, settings);
        if (!resultText) return;

        const note = {
            is_user: false,
            is_system: true,
            name: "Web Search",
            send_date: Date.now(),
            mes: resultText,
            extra: { isSmallSys: true },
        };
        chat.splice(chat.length - 1, 0, note);
        log("injected search results, query was:", query);
    } catch (e) {
        console.warn(`[${extensionName}] search failed, continuing without it:`, e);
    }
};

// --- Settings panel -----------------------------------------------------------

function buildSettingsPanel() {
    const settings = getSettings();

    const html = `
    <div id="smart_web_search_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Smart Web Search</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <label class="checkbox_label">
                    <input id="sws_enabled" type="checkbox" />
                    <span>Enabled</span>
                </label>

                <div class="sws_row">
                    <label><input type="radio" name="sws_mode" id="sws_mode_always" value="always" /> Always search (every message)</label>
                    <label><input type="radio" name="sws_mode" id="sws_mode_smart" value="smart" /> Smart (only when needed)</label>
                </div>

                <hr>

                <label>Search backend</label>
                <select id="sws_backend" class="text_pole">
                    <option value="plugin">Server plugin (recommended, fastest, no CORS issues)</option>
                    <option value="searxng">Direct to local SearXNG (will hit CORS errors)</option>
                    <option value="serpapi">SerpAPI (rate limited, key stored in browser)</option>
                </select>

                <label>Plugin route</label>
                <input id="sws_plugin_route" type="text" class="text_pole" />

                <label>SearXNG URL (direct mode)</label>
                <input id="sws_searxng_url" type="text" class="text_pole" />

                <label>SerpAPI key (not recommended - use the plugin backend instead)</label>
                <input id="sws_serpapi_key" type="password" class="text_pole" />

                <hr>

                <label>Number of results to inject</label>
                <input id="sws_result_count" type="number" min="1" max="10" class="text_pole" />

                <label>Model's knowledge cutoff year (fast-path heuristic only)</label>
                <input id="sws_cutoff_year" type="number" min="2000" max="2100" class="text_pole" />

                <label class="checkbox_label">
                    <input id="sws_ai_assist" type="checkbox" />
                    <span>AI-assist (recommended): catches niche/obscure topics the keyword list misses, and writes a clean search query instead of using your raw message. Adds one quick extra generation, only when the fast heuristic didn't already decide to search.</span>
                </label>

                <label class="checkbox_label">
                    <input id="sws_debug" type="checkbox" />
                    <span>Debug logging (console)</span>
                </label>

                <hr>

                <label>Test a search</label>
                <input id="sws_test_query" type="text" class="text_pole" placeholder="e.g. who is the current CEO of Netflix" />
                <button id="sws_test_search" class="menu_button">Run test search</button>
                <pre id="sws_test_output" style="white-space: pre-wrap;"></pre>

            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(html);

    $("#sws_enabled").prop("checked", settings.enabled);
    $(`#sws_mode_${settings.mode}`).prop("checked", true);
    $("#sws_backend").val(settings.backend);
    $("#sws_plugin_route").val(settings.pluginRoute);
    $("#sws_searxng_url").val(settings.searxngUrl);
    $("#sws_serpapi_key").val(settings.serpapiKey);
    $("#sws_result_count").val(settings.resultCount);
    $("#sws_cutoff_year").val(settings.knowledgeCutoffYear);
    $("#sws_ai_assist").prop("checked", settings.aiAssist);
    $("#sws_debug").prop("checked", settings.debug);

    $("#sws_enabled").on("change", function () {
        settings.enabled = $(this).prop("checked");
        saveSettings();
    });
    $('input[name="sws_mode"]').on("change", function () {
        settings.mode = $(this).val();
        saveSettings();
    });
    $("#sws_backend").on("change", function () {
        settings.backend = $(this).val();
        saveSettings();
    });
    $("#sws_plugin_route").on("change", function () {
        settings.pluginRoute = $(this).val().trim();
        saveSettings();
    });
    $("#sws_searxng_url").on("change", function () {
        settings.searxngUrl = $(this).val().trim();
        saveSettings();
    });
    $("#sws_serpapi_key").on("change", function () {
        settings.serpapiKey = $(this).val().trim();
        saveSettings();
    });
    $("#sws_result_count").on("change", function () {
        settings.resultCount = Math.max(1, Number($(this).val()) || defaultSettings.resultCount);
        saveSettings();
    });
    $("#sws_cutoff_year").on("change", function () {
        settings.knowledgeCutoffYear = Number($(this).val()) || defaultSettings.knowledgeCutoffYear;
        saveSettings();
    });
    $("#sws_ai_assist").on("change", function () {
        settings.aiAssist = $(this).prop("checked");
        saveSettings();
    });
    $("#sws_debug").on("change", function () {
        settings.debug = $(this).prop("checked");
        saveSettings();
    });
    $("#sws_test_search").on("click", async function () {
        const q = $("#sws_test_query").val() || "today's date";
        $("#sws_test_output").text("Searching...");
        try {
            const result = await performSearch(q, getSettings());
            $("#sws_test_output").text(result ?? "No results.");
        } catch (e) {
            $("#sws_test_output").text("Error: " + e.message);
        }
    });
}

// --- Init --------------------------------------------------------------------

jQuery(async () => {
    getSettings();
    buildSettingsPanel();
    console.log(`[${extensionName}] loaded`);
});
