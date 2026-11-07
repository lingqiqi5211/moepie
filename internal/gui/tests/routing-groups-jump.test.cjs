// Run with Node's test runner and Playwright on the module path; see README.md.
// The routing groups used to sit at the Routing page's foot, below the stage,
// the story and every request: with many models a long scroll down (shihh on
// Discord), and the page's head had a Routing groups beside New group to
// bring them into sight (#944). The page is in two parts now, its live view
// and its groups, picked by the tabs in its head (the Usage page's strip) or,
// in the sidebar's layout, by its rows under Routing there: the head's jump
// went with the tabs, and so did its New group, for the groups' own one is a
// click away. What this holds is what the jump was for: the groups are in
// sight on arrival, the pick is kept, and the page has had no sideways
// scroll. Every language, Chromium and WebKit, wide, a phone's width and a
// narrow window.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(process.env.MAGPIE_ROUTING_ASSETS || path.join(__dirname, "../assets"));
const models = [
  { id: "a/m", name: "m", providerName: "A", icon: "generic" },
  { id: "b/m", name: "m", providerName: "B", icon: "generic" },
];
const info = (ids) => ids.map((id) => ({ id, ready: true }));
const found = { id: "auto-m", name: "Model M", members: ["a/m", "b/m"], auto: true, ready: true, memberInfo: info(["a/m", "b/m"]) };

const words = {
  en: { view: "Live routing", groups: "Routing groups" },
  zh: { view: "路由情况", groups: "路由组" },
  "zh-TW": { view: "路由情況", groups: "路由組" },
  ja: { view: "ルーティングの状況", groups: "ルーティンググループ" },
  de: { view: "Routing im Überblick", groups: "Weiterleitungsgruppen" },
};

// requests enough to have put the groups well below the window's fold, as
// they were when they shared the page with them
const now = Date.now();
const routes = Array.from({ length: 60 }, (_, i) => ({
  id: "r" + i, seq: i + 1, at: new Date(now - i * 60000).toISOString(), agent: "claude", asked: "group/auto-m",
  model: "a/m", provider: "a", status: 200, ms: 900, ttft: 300, in: 100, out: 20, done: true,
}));

function serve(lang, web) {
  const state = { agents: [{ id: "claude", name: "Claude Code", path: "/test/claude", fields: [] }], profiles: [], settings: { lang, theme: "light" } };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:${web}};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.get("wait")) return new Promise(() => {}); // nothing more comes
      return json({ mine: true, now: new Date().toISOString(), seq: routes.length, totals: { requests: routes.length, rerouted: 0, errors: 0 }, routes });
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json({ models, pools: [], deciders: [], found: true, groups: [found] });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file), contentType });
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of Object.keys(words)) {
    for (const { width, web } of [{ width: 1000, web: true }, { width: 480, web: true }, { width: 640, web: false }]) {
      const w = words[lang];
      test(`${engine} ${lang} ${width}px${web ? " web" : " window"}: the Routing page's groups tab shows them in sight`, async (t) => {
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
        const page = await (await browser.newContext({ viewport: { width, height: 600 }, reducedMotion: "reduce" })).newPage();
        t.after(async () => {
          if (process.env.ARTIFACT_DIR) {
            await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-${width}${web ? "-web" : ""}-routing-groups-tab.png`) });
          }
          await browser.close();
        });
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(60000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, web));
        await page.goto("http://magpie.test/?view=routing");
        await page.locator(".rt-reqs > *").first().waitFor({ state: "attached" });
        await page.locator(".rt-group", { hasText: "Model M" }).waitFor({ state: "attached" });

        // the page's two parts are tabs in its head, the groups the second
        const view = page.locator("#view-routing");
        const tabs = view.locator("> .row-head #rtTabs > .opt");
        await tabs.first().waitFor({ state: "attached" });
        assert.equal(await tabs.count(), 2, "two tabs");
        assert.deepEqual((await tabs.allTextContents()).map((s) => s.trim()), [w.view, w.groups]);
        // the head's jump went with the tabs, and its New group with the groups' own
        assert.equal(await page.locator("#rtGoGroups, #rtNewGroup").count(), 0, "no jump or New group in the head");
        await page.evaluate(() => localStorage.removeItem("magpie.routingTab"));

        // the live view first: the requests on it, the groups off screen
        const side = await page.evaluate(() => document.body.classList.contains("side-nav"));
        const gsec = page.locator(".rt-gsec");
        assert.equal(await tabs.first().getAttribute("aria-pressed"), "true", "Live routing picked at the start");
        assert.equal(await page.locator("#rtPaneView").isVisible(), true);
        assert.equal(await page.locator(".rt-reqs > *").first().isVisible(), true, "the requests are on the view's pane");
        assert.equal(await gsec.isVisible(), false, "no groups on screen");
        // whose tab is in the head, or a row under Routing in the sidebar's layout
        let pick;
        if (side) {
          assert.equal(await tabs.first().isVisible(), false, "the strip goes in the sidebar's layout");
          pick = page.locator(".nav-sub:not(.leaving) .nav-s", { hasText: w.groups });
          await pick.waitFor({ state: "visible" });
        } else {
          assert.equal(await tabs.first().isVisible(), true);
          pick = tabs.nth(1);
        }
        // the pick: the groups' pane, its settings, in sight on arrival
        await pick.click();
        await gsec.waitFor({ state: "visible" });
        assert.equal(await page.locator("#rtPaneView").isVisible(), false, "the view's pane went");
        assert.equal(await tabs.nth(1).getAttribute("aria-pressed"), "true", "the tab shows as picked");
        const gb = await gsec.boundingBox();
        assert(gb.y >= 0 && gb.y < 600, "the groups are in sight");
        assert.equal(await view.evaluate((v) => v.scrollTop), 0, "the page opens at its top");
        // ... and stays picked across a reload (as the stage's height and zoom are)
        await page.reload();
        await gsec.waitFor({ state: "visible" });
        assert.equal((await tabs.nth(1).textContent()).trim(), w.groups);
        assert.equal(await tabs.nth(1).getAttribute("aria-pressed"), "true", "the pick is kept");
        // the other tab puts it back
        if (side) {
          await page.locator(".nav-sub:not(.leaving) .nav-s", { hasText: w.view }).click();
        } else {
          await tabs.first().click();
        }
        await page.locator("#rtPaneView").waitFor({ state: "visible" });
        assert.equal(await gsec.isVisible(), false, "the groups went with their pane");
        // the strip's arrow keys walk it, focus with the pick
        if (!side) {
          await tabs.first().focus();
          await page.keyboard.press("ArrowRight");
          await gsec.waitFor({ state: "visible" });
          assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tab), "groups", "ArrowRight picks the groups");
        }
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert(over <= 0, `no sideways scroll (${over}px)`);
        const hb = await page.locator("#view-routing > .row-head").boundingBox();
        assert(hb.width <= width, "the head fits its page");
        assert.deepEqual(errors, []);
      });
    }
  }
}

// a jump to a group from elsewhere — a model's card's New group, a window
// opened on one — picks the groups' page, as if their tab was clicked
test("chromium en: a jump to a group picks the Routing groups' tab", async (t) => {
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 600 }, reducedMotion: "reduce" })).newPage();
  t.after(() => browser.close());
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", serve("en", true));
  await page.goto("http://magpie.test/?view=routing");
  await page.locator(".rt-reqs > *").first().waitFor({ state: "attached" });
  await page.locator(".rt-group", { hasText: "Model M" }).waitFor({ state: "attached" });
  const tabs = page.locator("#view-routing > .row-head #rtTabs > .opt");
  await tabs.first().waitFor({ state: "attached" });
  assert.equal(await page.locator("#rtPaneView").isVisible(), true, "the live view first");
  assert.equal(await page.locator(".rt-gsec").isVisible(), false);

  await page.evaluate(() => window.newGroupWith("a/m", "Model A"));
  await page.locator(".rt-gsec .rt-gedit").waitFor({ state: "visible" });
  assert.equal(await page.locator("#rtPaneGroups").isVisible(), true, "the groups' pane");
  assert.equal(await page.locator("#rtPaneView").isVisible(), false, "the view's pane went");
  assert.equal(await tabs.nth(1).getAttribute("aria-pressed"), "true", "their tab shows as picked");
  assert.equal(await page.evaluate(() => localStorage.getItem("magpie.routingTab")), "groups", "and the pick is kept");
  assert.deepEqual(await page.locator(".rt-gedit .fbrow .n").allTextContents(), ["mA"], "the new group has its model");
  assert.deepEqual(errors, []);
});

// the sidebar's layout: the page's two parts are its rows under Routing, and
// the strip in the head goes
test("chromium en: the sidebar lists the Routing page's two parts under Routing", async (t) => {
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 620 }, reducedMotion: "reduce" })).newPage();
  t.after(() => browser.close());
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem("magpie.navLayout", "side"); } catch {} });
  await page.route("**/*", serve("en", true));
  await page.goto("http://magpie.test/?view=routing");
  await page.locator(".rt-reqs > *").first().waitFor({ state: "attached" });
  await page.locator(".rt-group", { hasText: "Model M" }).waitFor({ state: "attached" });
  assert.equal(await page.evaluate(() => document.body.classList.contains("side-nav")), true, "the sidebar's layout");
  assert.equal(await page.locator("#rtTabs").evaluate((e) => e.offsetParent !== null), false, "the strip in the head goes");

  const rows = page.locator(".nav-sub:not(.leaving) .nav-s");
  await rows.first().waitFor({ state: "visible" });
  assert.deepEqual((await rows.allTextContents()).map((s) => s.trim()), ["Live routing", "Routing groups"]);
  assert.equal(await rows.first().getAttribute("aria-selected"), "true", "the live view first");
  assert.equal(await page.locator("#rtPaneView").isVisible(), true);

  await rows.nth(1).click();
  await page.locator(".rt-gsec").waitFor({ state: "visible" });
  assert.equal(await page.locator("#rtPaneGroups").isVisible(), true);
  assert.equal(await page.locator("#rtPaneView").isVisible(), false);
  assert.equal(await rows.nth(1).getAttribute("aria-selected"), "true", "the row shows as picked");

  await page.reload();
  await page.locator(".rt-gsec").waitFor({ state: "visible" });
  assert.equal(await page.locator("#rtPaneGroups").isVisible(), true, "the pick is kept");
  assert.equal(await page.locator(".nav-sub:not(.leaving) .nav-s[aria-selected='true']").textContent(), "Routing groups");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(over <= 0, `no sideways scroll (${over}px)`);
  assert.deepEqual(errors, []);
});
