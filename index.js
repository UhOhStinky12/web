// Smart Web Search - SillyTavern extension
// Gives your local model live web results, either on every message or only
// when a message looks like it needs current/real-world info.

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
    aiAssist: false,             // ask the local model to judge ambiguous messages (slower, more accurate)
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

// --- Heuristic "does this need a search" check -----------------------------

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

async function aiAssistNeedsSearch(text) {
    try {
        const prompt =
            `Message: "${text}"\n\n` +
            `Would answering this message accurately require current/real-world information that could have changed recently ` +
            `(news, prices, who currently holds a position, recent releases, dates after your training, etc.)? ` +
            `Reply with exactly one word: YES or NO.`;
        const result = await generateQuietPrompt({ quietPrompt: prompt });
        return /^\s*yes/i.test(result ?? "");
    } catch (e) {
        log("aiAssist classification failed, falling back to heuristic", e);
        return null; // signal "unknown" so caller can fall back
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
    const text = `[Live web search results for: "${query}"]\n${lines.join("\n")}\n` +
        `Use this information naturally to inform your reply if it's relevant. Don't mention "search results" unless asked how you know something.`;

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
    if (settings.mode === "always") {
        shouldSearch = true;
    } else if (settings.aiAssist) {
        const aiResult = await aiAssistNeedsSearch(text);
        shouldSearch = aiResult === null ? heuristicNeedsSearch(text, settings) : aiResult;
    } else {
        shouldSearch = heuristicNeedsSearch(text, settings);
    }

    if (!shouldSearch) {
        log("skipping search for:", text);
        return;
    }

    try {
        const resultText = await performSearch(text, settings);
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
        log("injected search results for:", text);
    } catch (e) {
        console.warn(`[${extensionName}] search failed, continuing without it:`, e);
    }
};

// --- Settings panel (built inline, matches the "always visible in the
// Extensions tab" pattern) ---------------------------------------------------

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
                    <option value="searxng">Direct to local SearXNG</option>
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

                <label>Model's knowledge cutoff year (used by Smart mode)</label>
                <input id="sws_cutoff_year" type="number" min="2000" max="2100" class="text_pole" />

                <label class="checkbox_label">
                    <input id="sws_ai_assist" type="checkbox" />
                    <span>Use the model itself to judge ambiguous messages (slower, more accurate than keyword-only Smart mode)</span>
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
// Same pattern as the LM Studio Log Viewer extension: run directly on jQuery
// ready instead of relying on a manifest "hooks.activate" entry, so the panel
// reliably shows up under Extensions regardless of ST version quirks.

jQuery(async () => {
    getSettings();
    buildSettingsPanel();
    console.log(`[${extensionName}] loaded`);
});
