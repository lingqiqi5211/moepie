// Fork regression: even a stale backend list must not advertise partners.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = process.env.MAGPIE_PARTNER_ASSETS || path.resolve(__dirname, "../assets");

const partner = (id, name, extra = {}) => ({ id, name, icon: "generic", kind: "partner", sponsored: true, chat: `https://api.${id}.example.com/v1`, ...extra });
const partners = [
  partner("acme", "Acme AI", { notes: { en: "Fast relay", zh: "快速中转", ja: "高速な中継" },
    // its pages are /go links, named by the host they send the browser to
    website: "https://usemagpie.ai/go/acme/site", siteHost: "www.acme.example",
    regions: [
      { id: "cn", name: "China", chat: "https://api.acme.example.com/v1", website: "https://usemagpie.ai/go/acme/site/cn", siteHost: "cn.acme.example" },
      { id: "global", name: "Global", chat: "https://global.acme.example.com/v1", website: "https://usemagpie.ai/go/acme/site/global", siteHost: "global.acme.example" },
    ], splitAccounts: true }),
  partner("zhonly", "China Only", { langs: ["zh"], notes: { en: "Mainland relay", zh: "国内中转" } }),
  partner("taken", "Taken", { added: true }),
];
const presets = [
  { id: "openai", name: "OpenAI", icon: "openai", kind: "vendor", chat: "https://api.openai.example.com/v1" },
  { id: "openrouter", name: "OpenRouter", icon: "openai", kind: "relay", chat: "https://openrouter.example.com/v1", sponsored: true },
];
const providers = [{ id: "taken", name: "Taken", icon: "generic", preset: "taken", models: [], agents: [], key: { set: true, masked: "sk-…ab12" } }];

function server(lang, list, counted) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/api/partner") { counted?.push(route.request().postDataJSON()); return route.fulfill({ status: 204, body: "" }); }
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    // a partner the sheet showed is new no more, as provider.NoticePartners keeps
    const shown = new Set((counted || []).filter((c) => c.what === "shown").flatMap((c) => c.ids));
    if (url.pathname === "/api/providers") return json({ providers, presets: [...list.map((p) => (shown.has(p.id) ? { ...p, new: false } : p)), ...presets], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/groups") return json({ groups: [], pools: [] });
    if (url.pathname === "/api/gateway/trace") return json({ routes: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(engine + ": fork hides partner discovery and notifications", async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch());
    t.after(() => browser.close());
    for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) for (const width of [900, 440]) {
      await t.test(lang + " " + width, async () => {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        const page = await context.newPage();
        const errors = [], counted = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", server(lang, partners.map((p) => ({ ...p, new: true })), counted));
        await page.goto("http://magpie.test/?view=providers");
        const add = page.locator("#addProvider");
        await add.waitFor();
        assert.equal(await add.evaluate((b) => b.classList.contains("has-new")), false);
        assert.equal(await page.locator('#nav button[data-view="providers"]').evaluate((b) => b.classList.contains("has-dot")), false);
        await add.click();
        const sheet = page.locator("#addSheet");
        await sheet.locator('.tile[data-pick="OpenAI"]').waitFor();
        const names = await sheet.locator(".tile .n").allTextContents();
        for (const p of partners) assert(!names.includes(p.name), p.name + " remains discoverable");
        assert.equal(await sheet.locator(".shine, .new-dot").count(), 0);
        assert.deepEqual(counted, []);
        assert.deepEqual(errors, []);
        if (process.env.ARTIFACT_DIR && lang === "zh" && width === 900) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "partners-removed-" + engine + ".png") });
        }
        await context.close();
      });
    }
  });
}
