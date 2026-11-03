// Run with Node's test runner and Playwright on the module path; see README.md.
// With the Gateway page turned off in Plugins › Built-in (boot.js's
// featuresOff has "gateway", and a read of the settings keeps it off),
// Settings › Network and sharing says where the gateway's settings went,
// Settings' search finds the row, and its button opens Plugins › Built-in,
// where the page is turned back on. With the page on, nothing of the
// gateway's shows there. Every language; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { watchSettingsReads, settingsDrawn } = require("./reader.cjs");

const assets = path.resolve(__dirname, "../assets");

function serve(lang, gatewayOn) {
  const builtins = [
    { id: "gateway", name: "Gateway", sub: "The gateway's state, keys and settings", on: gatewayOn, chosen: gatewayOn, source: "preset", state: gatewayOn ? "active" : "off", inUse: 0 },
    { id: "usage", name: "Usage", sub: "What each call cost", on: true, chosen: true, source: "preset", state: "active", inUse: 0 },
  ];
  const settings = { theme: "light", lang, tray: "panel", currency: "usd", textSize: 100, redactWords: [], proxyNow: "none", proxySource: "none",
    gateway: "http://127.0.0.1:3425", lanURLs: [], allowIPs: [], corsOrigins: [], builtins };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:${JSON.stringify(lang)},theme:"light",featuresOff:${JSON.stringify(gatewayOn ? [] : ["gateway"])}};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: settings.gateway } });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ bun: true, plugins: [], picker: false, movable: [] });
    if (url.pathname === "/api/plugins/listings") return json({ listings: [] });
    if (url.pathname === "/api/plugins/github") return json({ repos: [] });
    if (url.pathname === "/api/plugins/builtin") return json(builtins);
    if (url.pathname === "/api/window/fit") return route.fulfill({ status: 204 });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

const visibleHeads = (page) => page.locator("#setPage-network .row-head .label").evaluateAll((ls) => ls.filter((l) => l.getClientRects().length).map((l) => l.textContent));

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    test(`${engine} ${lang}: with the Gateway page off, Network and sharing says where its settings went`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const errors = [];
      const open = async (gatewayOn) => {
        const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, reducedMotion: "reduce" });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, gatewayOn));
        await watchSettingsReads(page);
        await page.goto("http://magpie.test/?view=settings&tab=network");
        await settingsDrawn(page);
        return { context, page };
      };

      // off: the row, under its heading, and found by the search
      {
        const { context, page } = await open(false);
        const tr = (s) => page.evaluate((s) => t(s), s);
        assert.equal(await page.evaluate(() => featuresOff.has("gateway")), true, "still off after the settings read");
        assert.equal(await page.locator('#nav button[data-view="gateway"]').isVisible(), false, "no Gateway in the nav");
        const row = page.locator("#gwOffRow");
        assert.equal(await row.isVisible(), true);
        assert.deepEqual(await visibleHeads(page), ["GitHub", await tr("Gateway")]);
        assert.equal(await row.locator(".name").textContent(), await tr("The gateway's settings"));
        await page.locator("#setQ").fill(await tr("Browser access"));
        await page.waitForFunction(() => document.querySelector("#gwOffRow")?.getClientRects().length && !document.querySelector("#setPage-network").hidden);
        await page.locator("#setQ").fill("");

        // its button opens Plugins › Built-in, the Gateway's switch in it
        await row.getByRole("button", { name: await tr("Open Built-in"), exact: true }).click();
        await page.locator('#builtinList [data-id="gateway"]').waitFor();
        assert.equal(await page.evaluate(() => view), "plugins");
        assert.equal((await page.locator("#view-plugins .lib-tabs .opt.on").textContent()).trim(), await tr("Built-in") + " · 2", "Built-in, with its count");
        await context.close();
      }

      // on: nothing of the gateway's in Network and sharing
      {
        const { context, page } = await open(true);
        assert.equal(await page.evaluate(() => featuresOff.has("gateway")), false);
        assert.equal(await page.locator("#gwOffRow").count(), 0, "no row drawn");
        assert.equal(await page.locator("#gwOffList").isVisible(), false);
        assert.deepEqual(await visibleHeads(page), ["GitHub"]);
        await context.close();
      }
      assert.deepEqual(errors, []);
    });
  }
}
