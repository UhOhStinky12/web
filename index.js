// Smart Web Search — SillyTavern extension
// Gives your local model live web results, either on every message or only
// when a message looks like it needs current/real-world info.

const MODULE_NAME = 'smart_web_search';

const defaultSettings = Object.freeze({
    enabled: true,
    mode: 'smart',              // 'always' | 'smart'
    backend: 'plugin',          // 'plugin' | 'searxng' | 'serpapi'
    pluginRoute: '/api/plugins/smart-web-search/search',
    searxngUrl: 'http://localhost:8080',
    serpapiKey: '',             // only used if backend === 'serpapi' (NOT recommended, see README)
    resultCount: 4,
    knowledgeCutoffYear: 2023,  // set this to your model's training cutoff year
    aiAssist: false,            // ask the local model to judge ambiguous messages (slower, more accurate)
    timeoutMs: 6000,
    cacheMinutes: 10,
    debug: false,
});

const TIME_KEYWORDS = [
    'today', 'currently', 'current', 'latest', 'recent', 'recently',
    'this week', 'this month', 'this year', 'right now', 'nowadays',
    'up to date', 'breaking news', 'just announced', 'just released',
    'still alive', 'still the', 'net worth', 'richest', 'world record',
    'release date', 'new version', 'newest', 'update me on', 'news about',
    'who is the current', 'who is the ceo', 'who is the president',
    'election', 'score', 'stock price', 'exchange rate', 'weather in',
];

const searchCache = new Map(); // query -> { text, ts }

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function log(...args) {
    const s = getSettings();
    if (s.debug) console.log(`[${MODULE_NAME}]`, ...args);
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
        const { generateQuietPrompt } = SillyTavern.getContext();
        const prompt =
            `Message: "${text}"\n\n` +
            `Would answering this message accurately require current/real-world information that could have changed recently ` +
            `(news, prices, who currently holds a position, recent releases, dates after your training, etc.)? ` +
            `Reply with exactly one word: YES or NO.`;
        const result = await generateQuietPrompt({ quietPrompt: prompt });
        return /^\s*yes/i.test(result ?? '');
    } catch (e) {
        log('aiAssist classification failed, falling back to heuristic', e);
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
    const url = `${settings.searxngUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
    const res = await fetchWithTimeout(url, {}, settings.timeoutMs);
    if (!res.ok) throw new Error(`SearXNG search failed: ${res.status}`);
    const data = await res.json();
    const results = (data.results ?? []).slice(0, settings.resultCount).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? '',
    }));
    return { results };
}

async function searchViaSerpapi(query, settings) {
    if (!settings.serpapiKey) throw new Error('No SerpAPI key configured');
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${settings.serpapiKey}&num=${settings.resultCount}`;
    const res = await fetchWithTimeout(url, {}, settings.timeoutMs);
    if (!res.ok) throw new Error(`SerpAPI search failed: ${res.status}`);
    const data = await res.json();
    const results = (data.organic_results ?? []).slice(0, settings.resultCount).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet ?? '',
    }));
    return { results };
}

async function performSearch(query, settings) {
    const cacheKey = query.trim().toLowerCase();
    const cached = searchCache.get(cacheKey);
    const ttlMs = settings.cacheMinutes * 60 * 1000;
    if (cached && (Date.now() - cached.ts) < ttlMs) {
        log('cache hit for', query);
        return cached.text;
    }

    let data;
    if (settings.backend === 'plugin') data = await searchViaPlugin(query, settings);
    else if (settings.backend === 'searxng') data = await searchViaSearxng(query, settings);
    else data = await searchViaSerpapi(query, settings);

    const results = data.results ?? [];
    if (results.length === 0) return null;

    const lines = results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet} (${r.url})`);
    const text = `[Live web search results for: "${query}"]\n${lines.join('\n')}\n` +
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
    if (!settings.enabled || settings.mode === 'off') return;
    if (type === 'quiet' || type === 'impersonate') return; // don't recurse into our own or background calls

    const found = findLastUserMessage(chat);
    if (!found) return;
    const text = found.message.mes ?? '';
    if (!text.trim()) return;

    let shouldSearch = false;
    if (settings.mode === 'always') {
        shouldSearch = true;
    } else {
        if (settings.aiAssist) {
            const aiResult = await aiAssistNeedsSearch(text);
            shouldSearch = aiResult === null ? heuristicNeedsSearch(text, settings) : aiResult;
        } else {
            shouldSearch = heuristicNeedsSearch(text, settings);
        }
    }

    if (!shouldSearch) {
        log('skipping search for:', text);
        return;
    }

    try {
        const resultText = await performSearch(text, settings);
        if (!resultText) return;

        const note = {
            is_user: false,
            is_system: true,
            name: 'Web Search',
            send_date: Date.now(),
            mes: resultText,
            extra: { isSmallSys: true },
        };
        chat.splice(chat.length - 1, 0, note);
        log('injected search results for:', text);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] search failed, continuing without it:`, e);
    }
};

// --- Manual slash command ------------------------------------------------------

function registerSlashCommand() {
    try {
        const query = 'SlashCommandParser' in globalThis ? globalThis.SlashCommandParser : undefined;
        if (!query || !globalThis.SlashCommand || !globalThis.SlashCommandArgument) return;
        globalThis.SlashCommandParser.addCommandObject(globalThis.SlashCommand.fromProps({
            name: 'websearch',
            callback: async (_args, unnamedArgs) => {
                const settings = getSettings();
                const q = unnamedArgs.toString();
                if (!q) return 'Usage: /websearch <query>';
                const result = await performSearch(q, settings);
                return result ?? 'No results found.';
            },
            returns: 'search results as text',
            unnamedArgumentList: [
                globalThis.SlashCommandArgument.fromProps({
                    description: 'search query',
                    typeList: globalThis.ARGUMENT_TYPE.STRING,
                    isRequired: true,
                }),
            ],
            helpString: 'Manually run a web search and print the results (does not inject into chat).',
        }));
    } catch (e) {
        log('slash command registration skipped:', e);
    }
}

// --- Settings UI ---------------------------------------------------------------

async function renderSettingsUi() {
    const { renderExtensionTemplateAsync, saveSettingsDebounced } = SillyTavern.getContext();
    const settings = getSettings();

    const html = await renderExtensionTemplateAsync('third-party/smart-web-search', 'settings', settings);
    $('#extensions_settings2').append(html);

    const root = $('#smart_web_search_settings');

    root.find('#sws_enabled').prop('checked', settings.enabled);
    root.find(`#sws_mode_${settings.mode}`).prop('checked', true);
    root.find('#sws_backend').val(settings.backend);
    root.find('#sws_plugin_route').val(settings.pluginRoute);
    root.find('#sws_searxng_url').val(settings.searxngUrl);
    root.find('#sws_serpapi_key').val(settings.serpapiKey);
    root.find('#sws_result_count').val(settings.resultCount);
    root.find('#sws_cutoff_year').val(settings.knowledgeCutoffYear);
    root.find('#sws_ai_assist').prop('checked', settings.aiAssist);
    root.find('#sws_debug').prop('checked', settings.debug);

    root.find('#sws_enabled').on('change', function () {
        settings.enabled = $(this).is(':checked');
        saveSettingsDebounced();
    });
    root.find('input[name="sws_mode"]').on('change', function () {
        settings.mode = $(this).val();
        saveSettingsDebounced();
    });
    root.find('#sws_backend').on('change', function () {
        settings.backend = $(this).val();
        saveSettingsDebounced();
    });
    root.find('#sws_plugin_route').on('input', function () {
        settings.pluginRoute = $(this).val();
        saveSettingsDebounced();
    });
    root.find('#sws_searxng_url').on('input', function () {
        settings.searxngUrl = $(this).val();
        saveSettingsDebounced();
    });
    root.find('#sws_serpapi_key').on('input', function () {
        settings.serpapiKey = $(this).val();
        saveSettingsDebounced();
    });
    root.find('#sws_result_count').on('input', function () {
        settings.resultCount = Number($(this).val()) || defaultSettings.resultCount;
        saveSettingsDebounced();
    });
    root.find('#sws_cutoff_year').on('input', function () {
        settings.knowledgeCutoffYear = Number($(this).val()) || defaultSettings.knowledgeCutoffYear;
        saveSettingsDebounced();
    });
    root.find('#sws_ai_assist').on('change', function () {
        settings.aiAssist = $(this).is(':checked');
        saveSettingsDebounced();
    });
    root.find('#sws_debug').on('change', function () {
        settings.debug = $(this).is(':checked');
        saveSettingsDebounced();
    });
    root.find('#sws_test_search').on('click', async function () {
        const q = root.find('#sws_test_query').val() || 'today\'s date';
        root.find('#sws_test_output').text('Searching...');
        try {
            const result = await performSearch(q, getSettings());
            root.find('#sws_test_output').text(result ?? 'No results.');
        } catch (e) {
            root.find('#sws_test_output').text('Error: ' + e.message);
        }
    });
}

// --- Init ------------------------------------------------------------------

export async function onActivate() {
    getSettings();
    registerSlashCommand();
    await renderSettingsUi();
    console.log(`[${MODULE_NAME}] loaded`);
}
