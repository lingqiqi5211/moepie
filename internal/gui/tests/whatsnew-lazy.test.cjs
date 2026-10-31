// Run with Node's test runner and Playwright on the module path; see README.md.
// Release dialogs import their code only when opened; all requests use local fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

const words = {
  en: { pill: "Update", restart: "Restart to update", later: "Later", head: "Update to v0.1.402", newer: "Update to v0.1.403", since: "What changed since v0.1.400", span: "2 releases · v0.1.401 – v0.1.402", span3: "3 releases · v0.1.401 – v0.1.403", version: "Version" },
  zh: { pill: "更新", restart: "重启以更新", later: "稍后", head: "更新到 v0.1.402", newer: "更新到 v0.1.403", since: "自 v0.1.400 以来的更新内容", span: "2 个版本 · v0.1.401 – v0.1.402", span3: "3 个版本 · v0.1.401 – v0.1.403", version: "版本" },
};

function server(lang, ctl) {
  return async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    const settings = { theme: "light", lang, version: "0.1.400", dir: "~/.config/magpie", gateway: "http://127.0.0.1:3425", fx: { rate: 7.2, at: new Date().toISOString() } };
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/update") return json({ state: "ready", current: "0.1.400", latest: "0.1.402", notes: "- Two: the pill asks first", url: "https://example.test/v0.1.402" });
    if (url.pathname === "/api/update/notes") {
      ctl.asked.push(url.searchParams.get("lang"));
      await new Promise((r) => setTimeout(r, 200));
      // #910: the feed asked again names a release out since the download
      // a line two releases both carry is said once, at the newest
      if (ctl.newer) return json({ latest: "0.1.403", releases: [{ version: "0.1.403", notes: "- Three: out since\n- One: a fix" }, { version: "0.1.402", notes: "- Two: the pill asks first" }, { version: "0.1.401", notes: "- One: a fix" }] });
      if (ctl.one) return json({ latest: "0.1.402", releases: [{ version: "0.1.402", notes: "- Two: the pill asks first" }] });
      return json({ latest: "0.1.402", releases: [{ version: "0.1.402", notes: "- Two: the pill asks first" }, { version: "0.1.401", notes: "- One: a fix" }] });
    }
    if (url.pathname === "/api/update/install") {
      ctl.installs.push(req.postDataJSON() || {});
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}


for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: notes load on demand and retain fork links`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await browser.newPage({ reducedMotion: "reduce" });
      page.setDefaultTimeout(5000);
      const ctl = { installs: [], asked: [] }, imports = [], opened = [];
      await page.route("**/*", server(lang, ctl));
      await page.route("**/api/open", (route) => { opened.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
      page.on("request", (req) => { if (new URL(req.url()).pathname === "/whatsnew.js") imports.push(req.url()); });
      await page.goto("http://magpie.test/?view=agents");
      await page.locator("#update").waitFor({ state: "visible" });
      assert.equal(imports.length, 0, "startup fetches no release dialog code");
      await page.evaluate(() => showWhatsNew([{ version: "0.1.402", notes: "- Fix #42 [release](https://github.com/lingqiqi5211/moepie/releases/tag/v0.1.402)" }], false));
      const sheet = page.locator("#modal .whatsnew");
      await sheet.waitFor();
      assert.equal(imports.length, 1);
      const issue = sheet.locator("a.wn-link", { hasText: "#42" });
      assert.equal(await issue.getAttribute("href"), "https://github.com/yetone/magpie/issues/42");
      assert.equal(await sheet.locator("a.wn-link", { hasText: "release" }).getAttribute("href"), "https://github.com/lingqiqi5211/moepie/releases/tag/v0.1.402");
      await issue.click();
      assert.equal(opened[0].url, "https://github.com/yetone/magpie/issues/42");
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      await page.locator("#update").click();
      const ask = page.locator("#modal .update-ask");
      await ask.waitFor();
      await ask.locator(".wn-merged").waitFor();
      assert.equal(imports.length, 1, "the imported module serves both dialogs");
      assert.deepEqual(ctl.asked, [lang], "fork language selection reaches the existing notes API");
    });

    test(`${engine} ${lang}: unavailable dialog script still permits update`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await browser.newPage({ reducedMotion: "reduce" });
      page.setDefaultTimeout(5000);
      const ctl = { installs: [], asked: [] };
      await page.route("**/*", server(lang, ctl));
      await page.route("**/whatsnew.js*", (route) => route.abort());
      await page.goto("http://magpie.test/?view=agents");
      await page.locator("#update").waitFor({ state: "visible" });
      await page.locator("#update").click();
      for (let i = 0; i < 50 && !ctl.installs.length; i++) await page.waitForTimeout(20);
      assert.equal(ctl.installs.length, 1, "a missing optional script must not strand a downloaded update");
      assert.equal(await page.locator("#modal .update-ask").count(), 0);
    });
  }
}
