// Run with Node's test runner and Playwright on the module path; see README.md.
// The gateway's settings are the Gateway page's: its port, model ids
// without the provider, Allowed addresses (while shared), the web pages
// that may call it and Browser access, under the page's Settings, which
// fold away and stay folded. Share on local network is the card's choice
// alone. Settings › Network and sharing keeps Proxy and GitHub, nothing of
// the gateway's, and Settings' search finds none of it there. Every
// language, Chromium and WebKit; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

function server(lang) {
  const s = {
    theme: "light", lang, tray: "panel", quotaLeft: false, currency: "usd", textSize: 100,
    dock: false, dockWindow: false, proxy: "", redact: false, redactPersonal: false, redactWords: [],
    codexWarmup: "", claudeWarmup: "", codexWarmAt: "", claudeWarmAt: "", workbuddyCheckin: false, noStats: false,
    trayUsage: "", trayUsageEvery: 3, vision: "", imageGen: "",
    version: "0.1.900", dir: "/config/magpie", gateway: "http://127.0.0.1:3425",
    proxyNow: "none", proxySource: "none", login: false,
    visionModels: [], imageGenModels: [], workbuddyCheckins: [],
    lan: true, lanURLs: ["http://192.168.1.10:3425"], allowIPs: [], corsOrigins: [], bareModelIDs: false,
    fx: { rate: 7.2, at: new Date().toISOString(), stale: false },
  };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false,textSize:100};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light", textSize: 100 }, fx: s.fx });
    if (url.pathname === "/api/settings") return json(s);
    if (url.pathname === "/api/settings/busy-load") { s.busyLoad = route.request().postDataJSON().at; return json(s); }
    if (url.pathname === "/api/providers") return json({ providers: [], gateway: { running: true, mine: true, url: s.gateway, lan: true, lanURLs: s.lanURLs, calls: [], groups: [] } });
    if (url.pathname === "/api/caller-keys") return json({ keys: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/window/fit") return route.fulfill({ status: 204 });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const MOVED = ["#portList", "#bareIdsRow", "#allowList", "#corsList", "#webPageList"];
const shown = (page, sel) => page.locator(sel).first().evaluate((e) => !!e.getClientRects().length);

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    test(`${engine} ${lang}: the gateway's settings are on the Gateway page, not in Settings`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(6000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", server(lang));
      const tr = (s) => page.evaluate((s) => t(s), s);

      await page.goto("http://magpie.test/?view=gateway");
      await page.locator("#gwSettings #portList .row").waitFor();
      await page.locator("#gwSettings #allowList .row").first().waitFor();
      for (const sel of MOVED) {
        assert.equal(await page.locator(sel).count(), 1, sel + " drawn once");
        assert.equal(await page.locator(sel).evaluate((e) => !!e.closest("#view-gateway #gwSettings")), true, sel + " under the Gateway page's Settings");
      }
      assert.equal(await page.locator("#foldGwSettings .label").textContent(), await tr("Settings"));
      assert.equal(await page.locator("#webPageHead .label").textContent(), await tr("Browser access"));
      // one Share on local network: the card's
      assert.equal(await page.locator("#view-gateway").getByText(await tr("Share on local network"), { exact: true }).count(), 1);
      assert.equal(await page.locator("#gatewayLan .gw-share .opt.on").textContent(), await tr("Local network"));
      // the section sits between Connect and Models
      assert.deepEqual(await page.evaluate(() => {
        const s = document.querySelector("#gwSettings");
        return [s.previousElementSibling.querySelector(".fold")?.id, s.previousElementSibling.previousElementSibling.id];
      }), ["foldGwSettings", "connect"]);

      // folded away, and still folded after a reload
      await page.locator("#foldGwSettings").click();
      assert.equal(await page.locator("#gwSettings").isHidden(), true);
      assert.equal(await page.locator("#foldGwSettings").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#foldGwSettings").getAttribute("title"), await tr("Show the settings"));
      await page.reload();
      await page.locator("#foldGwSettings").waitFor();
      await page.waitForFunction(() => document.querySelector("#portList")?.childElementCount);
      assert.equal(await page.locator("#gwSettings").isHidden(), true, "the fold is remembered");
      await page.locator("#foldGwSettings").click();
      assert.equal(await shown(page, "#gwSettings"), true);
      assert.equal(await page.locator("#foldGwSettings").getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator("#foldGwSettings").getAttribute("title"), await tr("Fold the settings away"));

      // Settings › Network and sharing: Proxy and GitHub only
      await page.goto("http://magpie.test/?view=settings&tab=network");
      await page.locator("#proxySegs .opt").first().waitFor();
      for (const sel of [...MOVED, "#lanList", "#webPageHead"]) assert.equal(await page.locator("#view-settings " + sel).count(), 0, sel + " not in Settings");
      // (its Gateway heading shows only with the page off: gateway-off-settings)
      assert.deepEqual(await page.locator("#setPage-network .row-head .label").evaluateAll((ls) => ls.filter((l) => l.getClientRects().length).map((l) => l.textContent)), ["GitHub"]);
      const words = await page.locator("#setPage-network").textContent();
      for (const s of ["Gateway address", "Share on local network", "Browser access", "Allowed addresses", "Model ids without the provider"]) {
        assert(!words.includes(await tr(s)), s + " not in Settings › Network and sharing");
      }
      // nor does Settings' search find it there
      for (const s of ["Gateway address", "Browser access"]) {
        await page.locator("#setQ").fill(await tr(s));
        await page.waitForTimeout(150);
        const parts = await page.evaluate(() => [...document.querySelectorAll("#view-settings > [role=tabpanel]")]
          .filter((p) => p.getClientRects().length).map((p) => p.id));
        assert(!parts.includes("setPage-network"), s + " found nothing in Network and sharing");
      }
      assert.deepEqual(errors, []);
      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        await page.locator("#setQ").fill("");
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-settings-network.png`) });
      }
    });
  }
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium','webkit'])) {
  test(`${engine}: busy threshold changes redraw the Gateway controls`, async t => {
    const b=await(engine==='webkit'?webkit.launch():chromium.launch({channel:'chromium'}));t.after(()=>b.close());
    const p=await b.newPage({viewport:{width:1100,height:900}});p.setDefaultTimeout(5000);const errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',server('en'));await p.goto('http://magpie.test/?view=gateway');await p.locator('#busyLoadSegs .opt').first().waitFor();
    const choose=p.locator('#busyLoadSegs .opt').filter({hasText:/^Over 70%$/});await choose.dispatchEvent('click');
    await p.waitForFunction(()=>document.querySelector('#busyLoadSegs .opt.on')?.textContent==='Over 70%');
    await p.locator('#busyLoadSegs .opt').filter({hasText:'Custom'}).dispatchEvent('click');
    await p.locator('.busy-load-at').fill('125');await p.locator('#busyLoadSegs button').filter({hasText:/^Apply$/}).dispatchEvent('click');
    await p.waitForFunction(()=>document.querySelector('#busyLoadSegs .opt.on')?.textContent==='Over 125%');
    assert.equal(await p.locator('.busy-load-at').count(),0,'successful save closes the custom editor');assert.deepEqual(errors,[]);
  });
}
