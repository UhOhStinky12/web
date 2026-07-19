# Smart Web Search — SillyTavern extension

Gives your character live web results, injected straight into the prompt
context, without touching your model or connection settings.

## What it does

- Adds a settings panel under **Extensions → Smart Web Search**.
- Two modes:
  - **Always** — searches the web using your latest message every turn.
  - **Smart** — only searches when your message looks like it needs
    current/real-world info (keyword + date heuristics, with an optional
    "ask the model" double-check for ambiguous cases).
- Results get spliced into the chat as a small system note right before
  your message, so the model sees them as context for its reply.
- A manual `/websearch <query>` slash command if you want to force one.
- Response caching (10 min by default) so regenerating/swiping doesn't
  re-search identical queries.

## Requirements

This extension needs a search **backend**. It does not talk to Google
or SerpAPI directly by default — see the companion `server-plugin` and
`searxng-docker` packages. The short version:

1. Run a local SearXNG instance (free, unlimited, fast — see `searxng-docker/`).
2. Install the `smart-web-search-proxy` server plugin (see `server-plugin/`)
   so the browser extension can reach SearXNG without CORS issues and
   without exposing any keys client-side.

You *can* skip the server plugin and point the extension directly at
SearXNG or SerpAPI, but you'll likely hit CORS blocks from the browser,
and SerpAPI's free tier is capped at 100 searches/month. The plugin path
is the fastest and the only one with no artificial limits.

## Installing this extension

Pick ONE of the following:

**Option A — via SillyTavern's UI (recommended)**
Push this folder to a public GitHub repo, then in SillyTavern go to
Extensions → Install Extension, and paste your repo URL.

**Option B — manual copy**
Copy this entire folder into:

```
SillyTavern\data\default-user\extensions\smart-web-search
```

(replace `default-user` if you use a different SillyTavern user handle)
then restart SillyTavern (or refresh + re-enable it in the Extensions panel).

## Setting your model's cutoff

Llama-3.1-8B's training cutoff is December 2023. In the settings panel,
set "Knowledge cutoff year" to `2023` — Smart mode uses this to flag any
message mentioning a later year as needing a search.

## Notes

- The SerpAPI backend option stores your key in browser-visible extension
  settings — fine for quick testing, not recommended long-term. Use the
  server plugin instead if you want a paid-API fallback.
