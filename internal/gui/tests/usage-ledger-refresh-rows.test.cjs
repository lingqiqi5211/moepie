// Run with Node's test runner and Playwright on the module path; see README.md.
// Usage > Requests read again while it is looked at keeps the table and the
// rows that didn't change, the same elements where they were: a new request
// comes in at the top and the oldest leaves the foot, and nothing else is
// built or laid out again (a page of rows built anew was ~100 ms a refresh).
// A row whose figures changed is built again. The summary counts requests
// as the source cells do, a try handed on being a row but no request; and a
// source cell picked is pressed at once, its summary dimmed while the read
// is on its way. English and Chinese, Chromium and WebKit; no backend, the
// API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const now = Date.now();
const row = (i) => ({ t: new Date(now - i * 60e3).toISOString(), rid: "r" + i, agent: "codex", agentName: "Codex", provider: "relay", providerName: "Relay",
  model: "gpt-6-sol", in: 1000 + i, out: 100, ms: 900, status: 200, cost: 0.001, priced: true });

function server(lang, st) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/usage/requests") {
      if (st.held) await new Promise((r) => st.waiting.push(r));
      const rows = st.rows.filter((r) => url.searchParams.get("via") !== "direct" || r.source === "log");
      // a try handed on is one more row than requests
      return json({ period: "30d", rows, offset: 0, total: rows.length, calls: Math.max(0, rows.length - 1), errors: 0, input: 1000, output: 100, cost: 0.01,
        agents: [{ id: "codex", name: "Codex" }], providers: [{ id: "relay", name: "Relay" }],
        through: { calls: 5, input: 900 }, direct: { calls: 2, input: 100 }, reported: { calls: 0 } });
    }
    if (url.pathname === "/api/usage") return json({ calls: 1, bucket: "day", series: [], agents: [], models: [] });
    if (url.pathname === "/api/sessions") return json({ sessions: [], dirs: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], models: [], gateway: { running: false } });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: a refresh of Requests keeps the rows that didn't change`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const st = { rows: [1, 2, 3, 4, 5].map(row), held: false, waiting: [] };
      const errors = [];
      const page = await (await browser.newContext({ viewport: { width: 1180, height: 700 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", server(lang, st));
      await page.goto("http://magpie.test/");
      await page.locator('[data-view="usage"]').first().click();
      await page.locator(":is(#usageTab .opt, .nav-s):visible").nth(1).click();
      await page.locator("#ledWrap .led-row").first().waitFor();
      assert.equal(await page.locator("#ledSum").textContent().then((s) => s.split(" · ")[0]),
        await page.evaluate(() => t("{n} requests", { n: 4 })), "the summary counts requests, not rows");

      // a new request at the top, the oldest gone, the third's figures changed
      await page.evaluate(() => { window.__rows = [...document.querySelectorAll("#ledWrap .led-row")]; window.__table = document.querySelector("#ledWrap table"); });
      st.rows = [0, 1, 2, 3, 4].map(row);
      st.rows[3] = { ...st.rows[3], out: 777 };
      await page.evaluate(() => loadLedger(true));
      const kept = await page.evaluate(() => {
        const now = [...document.querySelectorAll("#ledWrap .led-row")];
        return { table: document.querySelector("#ledWrap table") === window.__table, same: now.map((tr) => window.__rows.indexOf(tr)), n: now.length };
      });
      assert.equal(kept.table, true, "the table stays");
      assert.equal(kept.n, 5);
      // 0 is new; 1, 2 and 4 are the same elements; 3 changed and is built again
      assert.deepEqual(kept.same, [-1, 0, 1, -1, 3]);
      assert.match(await page.locator("#ledWrap .led-row").nth(3).textContent(), /777/);

      // a source cell picked is pressed at once, the summary dimmed till its rows come
      st.held = true;
      await page.locator("#ledVia .blk").nth(2).click();
      assert.equal(await page.locator("#ledVia .blk").nth(2).getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#ledVia .blk").nth(0).getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator("#ledSum").evaluate((e) => e.classList.contains("led-pending")), true);
      for (let i = 0; i < 60 && !st.waiting.length; i++) await page.waitForTimeout(25);
      st.held = false;
      for (const r of st.waiting.splice(0)) r();
      await page.waitForFunction(() => !document.querySelector("#ledSum").classList.contains("led-pending"));
      assert.equal(await page.locator("#ledVia .blk").nth(2).getAttribute("aria-pressed"), "true");
      assert.deepEqual(errors, []);
    });
  }
}
