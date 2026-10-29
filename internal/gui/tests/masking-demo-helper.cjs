// Local fixtures shared by the masking flow browser regressions. No live API.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = process.env.MASK_ASSETS || path.resolve(__dirname, "../assets");
const K = "1792987654321000001";
const record = { key: K, t: new Date(Date.now() - 60e3).toISOString(), route: "messages", what: "chat", agent: "claude", provider: "anthropic", model: "claude-opus-4-1", n: 1,
  values: [{ p: "{{PERSON_bbbb2222}}", k: "PERSON", b: "model", h: "", l: 3, n: 1 }], snips: { "{{PERSON_bbbb2222}}": "ask {{PERSON_bbbb2222}} about it" } };

function serve(lang, theme, fetched, more, boot = {}) {
  const settings = { theme, lang, tray: "panel", currency: "usd", redact: true, redactPersonal: true, ...more };
  return async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = ${JSON.stringify({ lang, theme, web: true, ...boot })};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [{ id: "claude", name: "Claude Code", icon: "claudecode-color", fields: [] }], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/providers") return json({ providers: [{ id: "anthropic", name: "Anthropic", icon: "anthropic", agents: [], models: [] }], presets: [], excluded: [], gateway: { running: true, window: true, mine: true, url: "http://127.0.0.1:3999", models: 0, groups: [], calls: [] } });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/masking/summary") return json({ days: [], requests: 1, n: 1, distinct: 1, blocked: 0, hours: [], kinds: [{ name: "PERSON", n: 1, distinct: 1 }], by: { model: 1 }, agents: [{ name: "claude", n: 1, distinct: 1 }], providers: [{ name: "anthropic", n: 1, distinct: 1 }], values: [] });
    if (url.pathname === "/api/masking/records") return json({ records: [record], more: false });
    if (url.pathname === "/api/masking/record") return json(record);
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname), ext = path.extname(file);
    if (ext === ".webm" || ext === ".jpg") fetched.push(path.basename(file));
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webm": "video/webm" }[ext];
    let body;
    try { body = await fs.readFile(file); } catch { return route.fulfill({ status: 404, body: "" }); }
    await route.fulfill({ body, contentType, headers: {} });
  };
}

async function open(engine, lang, width, opts = {}) {
  const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch());
  const page = await (await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: opts.motion ? "no-preference" : "reduce" })).newPage();
  page.setDefaultTimeout(8000);
  const errors = [], fetched = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", serve(lang, opts.theme || "light", fetched, opts.settings, opts.boot));
  await page.goto("http://magpie.test/?view=masking");
  await page.locator("#mdRow").waitFor();
  return { browser, page, errors, fetched };
}

const state = (page) => page.evaluate(() => document.querySelector(".mask-flow").__state());
module.exports = { open, state, K };
