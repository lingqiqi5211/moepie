// Run with Node's test runner and Playwright on the module path; see README.md.
// The request archive (Jorben on Discord): its switch sits at the top right
// of the Usage page's summary card, between the requests' sum and the trend
// toggle, off unless turned on; with sync not set up with an s3:// bucket
// it turns on all the same and keeps calls on this computer, its tooltip the folder and the size
// they are kept under (CyberCaius on Discord), with one its tooltip says the
// bucket; a failed upload, or a failed save on this computer, is said
// beside it. The Gateway page has no switch
// any more, nor names the archive. A request the archive kept is read back
// from it (request-archive-usage.test.cjs), not from the gateway's recent
// calls, which show one it didn't keep. No click moves the page. In English
// and Chinese, Chromium and WebKit.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const reader = require("./reader.cjs");

const assets = path.resolve(__dirname, "../assets");
const now = Date.now();
const DATE = new Date(now).toISOString().slice(0, 10);
const KEPT = `${DATE}/101500-0123456789abcdef`;
const row = (i, model, archive) => ({
  t: new Date(now - (i + 1) * 3600e3).toISOString(), agent: "claude", agentName: "Claude Code", icon: "claudecode-color", provider: "relay", providerName: "Relay",
  req: model, model, served: model, in: 300, out: 40, ms: 2000, status: 200, rid: "req_" + i, ep: "/v1/messages", route_id: i + 1, cost: 0.01, priced: true, ...(archive ? { archive } : {}),
});
const ROWS = [row(0, "kept", KEPT), row(1, "plain")];

function serve(lang, seen) {
  const where = "bkt/team on https://s3.example.com";
  const here = { folder: "~/.config/magpie/request-archive", cap: 1 << 30 };
  const gateway = { running: true, window: true, mine: true, url: "http://127.0.0.1:3999", groups: [], archive: { on: false, ...here }, calls: [] };
  const providers = { providers: [{ id: "fixture", name: "Fixture", icon: "generic", models: [{ id: "kept", name: "Kept", on: true }], agents: [] }], gateway };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/providers") return json(providers);
    // an opened row's bodies, while the gateway's recent calls hold them (#1521)
    if (url.pathname === "/api/gateway/call") {
      seen.ring.push(Number(url.searchParams.get("route")));
      return json({ requestBody: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), responseBody: JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "hello" }] }) });
    }
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.get("wait")) await new Promise((r) => setTimeout(r, 20e3));
      return json({ mine: true, now: new Date(now).toISOString(), seq: 1, totals: { requests: 0, rerouted: 0, errors: 0 }, routes: [] });
    }
    if (url.pathname === "/api/settings/archive") {
      const body = route.request().postDataJSON();
      seen.push(["switch", body]);
      await new Promise((r) => setTimeout(r, 80));
      gateway.archive = { on: body.on, ...(seen.bucket ? { bucket: where } : here), ...(body.on && seen.failing ? { error: seen.bucket ? "HTTP 403" : "disk full" } : {}) };
      return json(gateway.archive);
    }
    if (url.pathname === "/api/archive") {
      seen.push(["fetch", `${url.searchParams.get("date")}/${url.searchParams.get("id")}`]);
      return json({ error: "not asked for here" }, 400);
    }
    if (url.pathname === "/api/usage/requests") return json({ period: url.searchParams.get("period"), rows: ROWS, offset: 0, total: 2, calls: 2, errors: 0, input: 600, output: 80, cache_read: 0, cache_write: 0, reasoning: 0, cost: 0.02, unpriced: 0, agents: [{ id: "claude", name: "Claude Code", icon: "claudecode-color" }] });
    if (url.pathname === "/api/usage/requests/content") return json({ found: false, why: "read" });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/usage") return json({ calls: 2, errors: 0, input: 600, output: 80, cache_read: 0, cache_write: 0, reasoning: 0, unpriced: 0, cost: 0.02, bucket: "day", series: [], agents: [], models: [], path: "~/.config/magpie/usage.jsonl" });
    if (url.pathname === "/api/sessions") return json({ sessions: [], dirs: [] });
    if (url.pathname === "/api/sessions/stats") return json({ from: "", to: "", days: [], agents: {} });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const words = {
  en: {
    name: "Request archive", fetch: "Fetch from archive", failed: "Upload failed", failedWhy: "Last upload failed: HTTP 403",
    notSaved: "Not saved", notSavedWhy: "Last save failed: disk full",
    local: "Keeps each call’s headers and bodies, secrets taken out, on this computer in ~/.config/magpie/request-archive, the oldest removed past 1.1 GB",
    bucket: "Keeps each call’s headers and bodies, secrets taken out, in bkt/team on https://s3.example.com",
  },
  zh: {
    name: "请求存档", fetch: "从存档取回", failed: "上传失败", failedWhy: "上次上传失败：HTTP 403",
    notSaved: "未保存", notSavedWhy: "上次保存失败：disk full",
    local: "每次调用的请求/响应头和正文去除密钥后存到本机的 ~/.config/magpie/request-archive，超过 1.1 GB 时先删除最早的",
    bucket: "每次调用的请求/响应头和正文去除密钥后存到 bkt/team on https://s3.example.com",
  },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: the request archive's switch over the Usage page's requests, none on the Gateway page`, async (t) => {
      const w = words[lang];
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const page = await (await browser.newContext({ viewport: { width: 1000, height: 760 }, reducedMotion: "reduce" })).newPage();
      t.after(() => browser.close());
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const seen = [];
      seen.ring = [];
      await page.route("**/*", serve(lang, seen));
      // the requests ungrouped: the archive is a request row's
      await page.addInitScript(() => localStorage.setItem("magpie.ledGroup", ""));
      // brought into view by the wheel, as the reader would; the click itself
      // must not move the page
      const press = async (loc, view) => {
        await reader.inView(page, loc);
        const at = await page.locator(view).evaluate((v) => v.scrollTop);
        await loc.click();
        await page.waitForTimeout(250);
        assert.equal(await page.locator(view).evaluate((v) => v.scrollTop), at, "a click moved the page");
      };
      const wait = async (n) => { for (let i = 0; i < 60 && seen.length < n; i++) await page.waitForTimeout(50); };

      // the Gateway page: no switch, nor the archive named
      await page.goto("http://magpie.test/?view=gateway");
      await page.locator("#view-gateway .gw-requests").waitFor();
      assert.equal(await page.locator("#archiveList, #view-gateway [role=switch]").count(), 0, "no archive switch on the Gateway page");
      assert.equal(await page.locator("#view-gateway").getByRole("button", { name: w.fetch }).count(), 0, "no Fetch from archive on the Gateway page");
      assert(!(await page.locator("#view-gateway").innerText()).includes(w.name), "the Gateway page doesn't name the archive");

      // the Usage page's requests: the switch at the top right of their list
      await page.locator('[data-view="usage"]').first().click();
      await page.locator(":is(#usageTab .opt, .nav-s):visible").nth(1).click();
      await page.locator(".led tbody tr.led-row").first().waitFor();
      const sw = page.locator("#ledArchive .led-arch-sw");
      await sw.waitFor();
      assert.equal(await sw.getAttribute("role"), "switch");
      assert.equal(await sw.innerText(), w.name);
      assert.equal(await sw.getAttribute("aria-checked"), "false", "off unless turned on");
      assert.equal(await sw.getAttribute("title"), w.local, "no bucket: kept on this computer");
      // The summary card shares the list's width; its header keeps the
      // archive between the total and the trend toggle, within its padding.
      const head = page.locator("#ledSumCard .fx-sum-head");
      const trend = page.locator("#ledTrendToggle");
      const [swBox, sumBox, trendBox, cardBox, listBox] = await Promise.all([
        sw, page.locator("#ledSum"), trend, page.locator("#ledSumCard"), page.locator("#ledWrap"),
      ].map((l) => l.boundingBox()));
      assert.equal(await head.locator("#ledArchive, #ledTrendToggle").count(), 2, "both controls belong to the summary header");
      assert(Math.abs(cardBox.x - listBox.x) <= 2 && Math.abs(cardBox.x + cardBox.width - (listBox.x + listBox.width)) <= 2, "the summary card and list share their edges");
      assert(sumBox.x + sumBox.width <= swBox.x && swBox.x + swBox.width <= trendBox.x, "total, archive and trend do not overlap and keep their order");
      const headerRight = await head.evaluate((e) => e.getBoundingClientRect().right - parseFloat(getComputedStyle(e).paddingRight));
      assert(Math.abs(trendBox.x + trendBox.width - headerRight) <= 2, "the trend toggle ends at the header's padded right edge");
      assert(swBox.y + swBox.height <= listBox.y, "the switch is over the list");
      assert(Math.abs(swBox.y + swBox.height / 2 - (sumBox.y + sumBox.height / 2)) <= 3, "on the line of the requests' sum");
      assert(Math.abs(swBox.y + swBox.height / 2 - (trendBox.y + trendBox.height / 2)) <= 3, "both controls share the summary's line");

      for (const width of [640, 390]) {
        await page.setViewportSize({ width, height: 760 });
        const [card, ...boxes] = await Promise.all([page.locator("#ledSumCard"), sw, trend].map((l) => l.boundingBox()));
        for (const box of boxes) {
          assert(box.x >= card.x && box.x + box.width <= card.x + card.width && box.y >= card.y && box.y + box.height <= card.y + card.height, `controls stay inside the summary at ${width}px`);
        }
        const [a, b] = boxes;
        assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `controls do not overlap at ${width}px`);
      }
      await page.setViewportSize({ width: 1000, height: 760 });

      // no bucket: on all the same, kept on this computer, and off again
      await press(sw, "#view-usage");
      await wait(1);
      assert.deepEqual(seen[0], ["switch", { on: true }]);
      const onHere = page.locator('#ledArchive .led-arch-sw[aria-checked="true"]:not([disabled])');
      await onHere.waitFor();
      assert.equal(await onHere.getAttribute("title"), w.local);
      assert.equal(await page.locator("#ledArchive .led-arch-err").count(), 0);
      await press(onHere, "#view-usage");
      await wait(2);
      assert.deepEqual(seen[1], ["switch", { on: false }]);
      await page.locator('#ledArchive .led-arch-sw[aria-checked="false"]:not([disabled])').waitFor();
      // with one: on, the bucket in its tooltip
      seen.bucket = true;
      await press(page.locator("#ledArchive .led-arch-sw"), "#view-usage");
      await wait(3);
      assert.deepEqual(seen[2], ["switch", { on: true }]);
      const on = page.locator('#ledArchive .led-arch-sw[aria-checked="true"]');
      await on.waitFor();
      assert.equal(await on.getAttribute("title"), w.bucket);
      assert.equal(await page.locator("#ledArchive .led-arch-err").count(), 0);
      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        const head = await page.locator(".led-head").boundingBox();
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-archive-switch.png`), clip: { x: head.x - 16, y: head.y - 60, width: head.width + 32, height: head.height + 170 } });
      }

      // turned off again
      await press(on, "#view-usage");
      await wait(4);
      assert.deepEqual(seen[3], ["switch", { on: false }]);
      await page.locator('#ledArchive .led-arch-sw[aria-checked="false"]:not([disabled])').waitFor();

      // an upload that failed is said beside it, why in its tooltip
      seen.failing = true;
      await press(page.locator("#ledArchive .led-arch-sw"), "#view-usage");
      await wait(5);
      const err = page.locator("#ledArchive .led-arch-err");
      await err.waitFor();
      assert.equal(await err.innerText(), w.failed);
      assert.equal(await err.getAttribute("title"), w.failedWhy);

      // and a save on this computer that failed says so in its own words
      seen.bucket = false;
      await press(page.locator("#ledArchive .led-arch-sw"), "#view-usage");
      await wait(6);
      assert.deepEqual(seen[5], ["switch", { on: false }]);
      await page.locator('#ledArchive .led-arch-sw[aria-checked="false"]:not([disabled])').waitFor();
      await press(page.locator("#ledArchive .led-arch-sw"), "#view-usage");
      await wait(7);
      assert.deepEqual(seen[6], ["switch", { on: true }]);
      await page.waitForFunction((s) => document.querySelector("#ledArchive .led-arch-err")?.textContent === s, w.notSaved);
      assert.equal(await page.locator("#ledArchive .led-arch-err").getAttribute("title"), w.notSavedWhy);
      // a request the archive kept says so, and isn't asked of the gateway's
      // recent calls; one it didn't keep shows them
      const rows = page.locator(".led tbody tr.led-row");
      const box = (i) => rows.nth(i).locator("xpath=following-sibling::tr[1]");
      await press(rows.nth(0).locator("td").nth(1), "#view-usage");
      await box(0).locator(".led-archive").waitFor();
      assert.equal(await box(0).locator(".led-bodies").count(), 0, "no recent bodies under an archived request");
      await press(rows.nth(1).locator("td").nth(1), "#view-usage");
      await box(1).locator(".led-bodies .call-body").nth(1).waitFor();
      assert.deepEqual(seen.ring, [2], "only the request the archive didn't keep is asked for");
      assert.equal(seen.filter(([k]) => k === "fetch").length, 0, "nothing was read from the archive");

      // The trend arrow uses transparent side borders to draw a triangle;
      // those do not paint a left-border accent.
      const border = await page.evaluate(() => [...document.querySelectorAll(".led-head, .led-head *")]
        .map((e) => getComputedStyle(e))
        .filter((s) => parseFloat(s.borderLeftWidth) > 1 && s.borderLeftColor !== "rgba(0, 0, 0, 0)")
        .map((s) => s.borderLeftWidth));
      assert.deepEqual(border, [], "no left-border accent");
      const missing = await page.evaluate(() => [
        "Request archive", "Upload failed", "Last upload failed: {e}", "Not saved", "Last save failed: {e}",
        "Keeps each call’s headers and bodies, secrets taken out, in {where}",
        "Keeps each call’s headers and bodies, secrets taken out, on this computer in {where}, the oldest removed past {size}",
        "Not in the archive on this computer: it is saved just after the call, the oldest are removed past the archive's size, or the save failed (magpie's log says why)",
      ].flatMap((k) => ["zh", "zh-TW", "ja", "de"].filter((l) => !I18N[l][k]).map((l) => l + " " + k)));
      assert.deepEqual(missing, [], "every string has its Chinese, Japanese and German");
      assert.deepEqual(errors, []);
    });
  }
}
