// Run with Node's test runner and Playwright on the module path; see README.md.
// What a call through the gateway sent and got back, while the gateway's last
// calls still hold it, is on Usage › Requests: a row is read from the ring
// (/api/gateway/call?route=) only when it is opened, once, and kept while the
// list is read anew; a failed read can be tried again, one let go of says
// how to keep them, as Routing does, and is asked again when opened again,
// and a try handed on, a session file's call or another computer's asks
// nothing. The Gateway page's Requests row opens there, on the newest
// requests, and is gone with Usage switched off. Five languages; no backend,
// the API is faked.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = process.env.MAGPIE_RECENT_ASSETS || path.resolve(__dirname, "../assets");
const now = Date.now();
const row = (i, more) => ({ t: new Date(now - (i + 1) * 60e3).toISOString(), agent: "codex", agentName: "Codex", icon: "codex-color", provider: "fixture", providerName: "Fixture", req: "m", model: "m", served: "m", in: 10, out: 5, ms: 900, status: 200, rid: "req_" + i, ep: "/v1/responses", route_id: 101 + i, cost: 0, priced: false, ...more });
const ROWS = [
  row(0), // its bodies come late
  row(1), // its first read fails
  row(2), // let go of by the ring
  row(3, { status: 503, err: "busy", handed_on: true }), // a try handed on to the next
  row(4, { source: "log", status: 0 }), // a session file's
  row(5, { computer: "laptop", computerName: "Laptop" }), // another computer's
];
const bodies = { requestBody: '{"messages":[{"role":"user","content":"hello"}]}', responseBody: '{"reply":"world"}', requestTruncated: true, responseTruncated: true };
const words = {
  en: { loading: "Fetching…", retry: "Try again", open: "Open", requests: "Requests", sub: "Each call through the gateway as it comes, with what it sent and got back, on Usage › Requests" },
  zh: { loading: "取回中…", retry: "重试", open: "打开", requests: "请求", sub: "经过网关的每次调用，随到随显，连同发出和收到的内容，都在「用量 › 请求」" },
  "zh-TW": { loading: "取回中…", retry: "重試", open: "開啟", requests: "請求", sub: "經過閘道的每次呼叫，隨到隨顯，連同送出和收到的內容，都在「用量 › 請求」" },
  ja: { loading: "取得中…", retry: "再試行", open: "開く", requests: "リクエスト", sub: "ゲートウェイを通る各呼び出しは、送った内容と返ってきた内容とともに、届いたそばから「使用量 › リクエスト」に表示されます" },
  de: { loading: "Wird abgerufen…", retry: "Erneut versuchen", open: "Öffnen", requests: "Anfragen", sub: "Jeder Aufruf über den Zugangspunkt, sobald er eintrifft, mit dem Gesendeten und Erhaltenen, unter Nutzung › Anfragen" },
};

function server(lang, s) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data, status = 200) => route.fulfill({ json: data, status });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true,featuresOff:${JSON.stringify(s.off || [])}};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/providers") return json({ presets: [], excluded: [], providers: [{ id: "fixture", name: "Fixture", icon: "generic", key: { set: true, masked: "fixture" }, models: [{ id: "m", name: "M", on: true }], agents: [] }], gateway: { running: true, window: true, mine: true, url: "http://127.0.0.1:3999", calls: [], groups: [] } });
    if (url.pathname === "/api/usage/requests") {
      // a refresh that finds the list changed draws it anew
      return json({ rows: ROWS, offset: 0, total: ROWS.length, calls: ROWS.length + s.more, errors: 1, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, cost: 0, unpriced: 0, agents: [{ id: "codex", name: "Codex", icon: "codex-color" }] });
    }
    if (url.pathname === "/api/gateway/call") {
      assert(!url.searchParams.has("id"), "a ledger row asks by its route");
      const id = Number(url.searchParams.get("route"));
      s.seen.push(id);
      if (id === 101) { await s.pending; return json(bodies); }
      if (id === 102 && s.seen.filter((x) => x === id).length === 1) return json({ error: "temporarily unavailable" }, 503);
      if (id === 102) return json({ requestBody: "", responseBody: "" });
      return json({ error: "This request is no longer in the recent calls." }, 404);
    }
    if (url.pathname === "/api/archive") assert.fail("the ring's bodies don't depend on the archive");
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.has("wait")) await new Promise((r) => setTimeout(r, 1000));
      return json({ mine: true, now: new Date(now).toISOString(), seq: 1, totals: {}, routes: [] });
    }
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({ body: await fs.readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)] });
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of Object.keys(words)) {
    test(`${engine} ${lang}: the gateway's recent bodies on Usage › Requests, from the Gateway page's link`, async (t) => {
      const w = words[lang];
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const s = { seen: [], more: 0 };
      let release;
      s.pending = new Promise((resolve) => { release = resolve; });
      await page.route("**/*", server(lang, s));

      // the Gateway page says where its calls went, and takes the reader there
      await page.goto("http://magpie.test/?view=gateway");
      const link = page.locator(".gw-requests");
      await link.waitFor();
      assert.equal(await page.locator("#activity").count(), 0, "no Recent calls on the Gateway page");
      assert.equal((await link.locator(".name").textContent()).trim(), w.requests);
      assert.equal((await link.locator(".sub").textContent()).trim(), w.sub);
      assert.equal((await page.locator("#gwRequests").textContent()).trim(), w.open);
      // whatever tab Usage was left on, and a later page of it
      await page.evaluate(() => { usageTab = "usage"; ledOffset = 50; });
      await page.locator("#gwRequests").click();
      await page.locator("#view-usage").waitFor();
      assert.deepEqual(await page.evaluate(() => [view, usageTab, ledOffset]), ["usage", "requests", 0]);
      const rows = page.locator("#ledWrap .led tbody tr.led-row");
      await rows.first().waitFor();
      assert.equal(await rows.count(), ROWS.length);
      assert.equal(s.seen.length, 0, "the list is metadata only");

      const detail = (i) => rows.nth(i).locator("xpath=following-sibling::tr[1][contains(@class,'led-detail')]");
      const bx = (i) => detail(i).locator(".led-bodies");
      // opened: asked for once, and said to be coming meanwhile
      await rows.nth(0).click();
      await bx(0).getByText(w.loading, { exact: true }).waitFor();
      assert.deepEqual(s.seen, [101]);
      assert.equal(await bx(0).locator(".call-body").count(), 0, "pending is not an empty body");
      await rows.nth(0).click();
      await rows.nth(0).click();
      await bx(0).getByText(w.loading, { exact: true }).waitFor();
      assert.deepEqual(s.seen, [101], "opened again while coming, it isn't asked twice");
      release();
      await bx(0).locator(".call-body pre").first().waitFor();
      const text = await bx(0).innerText();
      assert(text.includes("hello") && text.includes("world"), text);
      assert.equal(await bx(0).locator(".call-body-truncated").count(), 2);
      // the list read anew, and changed, keeps it without asking again
      s.more++;
      await page.evaluate(() => loadLedger(true));
      await page.waitForFunction((n) => ledger.calls === n, ROWS.length + 1);
      await bx(0).locator(".call-body pre").first().waitFor();
      assert.deepEqual(s.seen, [101], "a refresh keeps what came");
      await rows.nth(0).click();
      await rows.nth(0).click();
      await bx(0).locator(".call-body pre").first().waitFor();
      assert.deepEqual(s.seen, [101], "reopened, it is the copy kept");
      await rows.nth(0).click();

      // a failed read says why, and can be tried again
      await rows.nth(1).click();
      await bx(1).getByText("temporarily unavailable", { exact: true }).waitFor();
      await bx(1).getByRole("button", { name: w.retry, exact: true }).click();
      await bx(1).locator(".call-body pre").first().waitFor();
      assert.deepEqual(s.seen, [101, 102, 102]);
      assert.equal(await bx(1).locator(".call-body code.empty").count(), 2);
      await rows.nth(1).click();

      // let go of by the ring: says how to keep them, in the page's
      // language, not an error or an empty body
      const gone = await page.evaluate(() => t("magpie keeps the request and response of only the last 40 requests, until it quits. To keep every request's, turn on Request archive at the top of Usage › Requests."));
      if (lang !== "en") assert(!gone.startsWith("magpie keeps"), gone);
      await rows.nth(2).click();
      await bx(2).getByText(gone, { exact: true }).waitFor();
      assert.deepEqual(s.seen, [101, 102, 102, 103]);
      assert.equal(await bx(2).locator(".call-body, .call-archive-err").count(), 0);
      // the list read anew keeps it without asking; opened again, it asks
      s.more++;
      await page.evaluate(() => loadLedger(true));
      await page.waitForFunction((n) => ledger.calls === n, ROWS.length + 2);
      await bx(2).getByText(gone, { exact: true }).waitFor();
      assert.deepEqual(s.seen, [101, 102, 102, 103]);
      await rows.nth(2).click();
      await rows.nth(2).click();
      await bx(2).getByText(gone, { exact: true }).waitFor();
      assert.deepEqual(s.seen, [101, 102, 102, 103, 103]);
      await rows.nth(2).click();

      // a try handed on, a session file's call and another computer's ask nothing
      for (const i of [3, 4, 5]) {
        await rows.nth(i).click();
        await detail(i).waitFor();
        assert.equal(await bx(i).count(), 0, `row ${i} has no ring bodies`);
        await rows.nth(i).click();
      }
      assert.deepEqual(s.seen, [101, 102, 102, 103, 103]);
      assert.deepEqual(errors, []);
    });
  }

  test(`${engine}: with Usage switched off the Gateway page has no Requests row`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", server("en", { seen: [], more: 0, off: ["usage"] }));
    await page.goto("http://magpie.test/?view=gateway");
    await page.locator("#gwRequests").waitFor({ state: "attached" });
    assert.equal(await page.locator(".gw-requests").isVisible(), false);
    assert.deepEqual(errors, []);
  });
}
