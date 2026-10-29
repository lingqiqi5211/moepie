// Run with Node's test runner and Playwright on the module path; see README.md.
// Out of sight, the Routing page asks for no trace — and that holds when
// the gateway can't be reached either. Its first ask failed before it had
// heard anything, and it asked again every 3 s for as long as the page was
// hidden. It asks once, and again only when back in sight. The window's
// hidden state is faked, as headless pages are never hidden.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

function serve() {
  const state = { agents: [], profiles: [], settings: { lang: "en", theme: "light" } };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"en",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    // the gateway is down
    if (url.pathname === "/api/gateway/trace") return r.abort("connectionrefused");
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], gateway: { running: false, window: true } });
    if (url.pathname.startsWith("/api/window/")) return r.fulfill({ status: 204 });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const ways = {
  "another page picked": { view: "agents", hid: false, show: (page) => page.locator('#nav button[data-view="routing"]').click() },
  "the window hidden": { view: "routing", hid: true, show: (page) => page.evaluate(() => window.__hide(false)) },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const [way, how] of Object.entries(ways)) {
    test(`${engine}: out of sight (${way}), a gateway that's down is asked once`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      await ctx.addInitScript((hid) => {
        window.__hid = hid;
        Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => window.__hid });
        Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (window.__hid ? "hidden" : "visible") });
        window.__hide = (h) => { window.__hid = h; document.dispatchEvent(new Event("visibilitychange")); };
      }, how.hid);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let asked = 0;
      page.on("request", (q) => { if (q.url().includes("/api/gateway/trace")) asked++; });
      await page.route("**/*", serve());
      await page.goto(`http://magpie.test/?view=${how.view}`);
      // the 3 s retry would have asked twice more by now
      await page.waitForTimeout(7500);
      assert.equal(asked, 1, `the trace was asked ${asked} times out of sight`);

      // back in sight, it asks again
      await how.show(page);
      await page.waitForTimeout(500);
      assert(asked >= 2, "back in sight, the trace wasn't asked again");
      assert.deepEqual(errors, []);
    });
  }
}
