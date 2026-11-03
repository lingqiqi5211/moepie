// Run with Node's test runner and Playwright on the module path; see README.md.
// The Usage page's Requests, grouped and compared: a row's model is the one
// asked for, with a line under it when the reply named another (amber), the
// same model under another name, or the member a group picked, and a card
// on hover or focus, pinned by a click, that sets the three names side by
// side and says why. A switch lists only the mismatches, the server's pick
// over the whole period. Grouped by agent, model or session, each group's
// header sums the whole period, its rows read a page at a time once opened
// and read again in place by a refresh, and "Show only this group" lists it
// alone. Models group by the one asked for; a request turned away is a row
// of its group and in none of its figures. English and Chinese; no backend,
// the API is faked.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const reader = require("./reader.cjs");

const assets = path.resolve(__dirname, "../assets");
const now = Date.now();
const at = (i) => new Date(now - (i + 1) * 60e3).toISOString();

const base = { provider: "relay", providerName: "Relay", host: "team", in: 1000, out: 100, ms: 900, status: 200, cost: 0.001, priced: true };
const ROWS = [
  // another model answered, and the vendor said which provider served it
  { ...base, t: at(0), agent: "codex", agentName: "Codex", icon: "codex-color", req: "sol", model: "gpt-6-sol", served: "gpt-6-luna", served_as: "swapped", swapped: true, upstream: "Azure", session: "s1", ep: "/v1/responses" },
  // the same model under a dated name
  { ...base, t: at(1), agent: "claude", agentName: "Claude Code", icon: "claudecode-color", req: "sonnet", model: "claude-sonnet-5", served: "claude-sonnet-5-20260801", served_as: "renamed", session: "s2", ep: "/v1/messages" },
  // a group's member
  { ...base, t: at(2), agent: "codex", agentName: "Codex", icon: "codex-color", req: "group/fast", model: "glm-fast", served: "glm-fast", served_as: "routed", routed: true, ep: "/v1/chat/completions" },
  // failed, no reply to name a model
  { ...base, t: at(3), agent: "claude", agentName: "Claude Code", icon: "claudecode-color", req: "opus", model: "claude-opus-5", status: 500, err: "overloaded", ep: "/v1/messages" },
  // a session file's, which keeps no served model
  { ...base, t: at(4), agent: "opencode", agentName: "OpenCode", icon: "generic", model: "kimi-k2", source: "log", status: 0 },
];
for (let i = 0; i < 130; i++) ROWS.push({ ...base, t: at(5 + i), agent: "codex", agentName: "Codex", icon: "codex-color", req: "sol", model: "gpt-6-sol", served: "gpt-6-sol", served_as: "same", session: "s1", ep: "/v1/responses" });
// turned away: listed, and in no figure
ROWS.push({ ...base, t: at(135), agent: "claude", agentName: "Claude Code", icon: "claudecode-color", req: "opus", model: "claude-opus-5", status: 429, err: "rate limited", turned: true, ep: "/v1/messages" });

const failed = (r) => r.status >= 400 || !!r.err;
const sum = (all) => { const rows = all.filter((r) => !r.turned); return {
  calls: rows.length, errors: rows.filter(failed).length, swaps: rows.filter((r) => r.swapped).length,
  input: rows.reduce((n, r) => n + r.in, 0), output: rows.reduce((n, r) => n + r.out, 0), cache_read: 0, cache_write: 0, reasoning: 0,
  cost: rows.reduce((n, r) => n + r.cost, 0), unpriced: 0,
}; };
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// the server's page: its filters, the mismatches' pick, and the groups,
// whose sums leave the pick out
function page(q) {
  let rows = ROWS;
  if (q.get("agent")) rows = rows.filter((r) => r.agent === q.get("agent"));
  if (q.get("requested")) rows = rows.filter((r) => (r.req || r.model || "none") === q.get("requested"));
  if (q.get("session")) rows = rows.filter((r) => q.get("session") === "none" ? !r.session : r.session === q.get("session"));
  const whole = rows;
  if (q.get("mismatch") === "1") rows = rows.filter((r) => r.swapped);
  const offset = +q.get("offset") || 0, limit = +q.get("limit") || 100;
  const out = {
    period: q.get("period"), rows: rows.slice(offset, offset + limit), offset, total: rows.length, ...sum(rows), swaps: whole.filter((r) => r.swapped).length,
    agents: [{ id: "codex", name: "Codex", icon: "codex-color" }, { id: "claude", name: "Claude Code", icon: "claudecode-color" }, { id: "opencode", name: "OpenCode", icon: "generic" }],
    providers: [{ id: "relay", name: "Relay" }],
  };
  const by = q.get("group");
  if (by) {
    const key = (r) => by === "agent" ? r.agent : by === "model" ? r.req || r.model || "none" : r.session || "none";
    const ids = uniq(whole.map(key));
    let groups = ids.map((id) => {
      const g = whole.filter((r) => key(r) === id);
      return { id, ...sum(g), rows: g.length, agents: uniq(g.map((r) => r.agent)), providers: uniq(g.map((r) => r.provider)), models: uniq(g.map((r) => r.model)), first: g.at(-1).t, last: g[0].t };
    });
    if (q.get("mismatch") === "1") groups = groups.filter((g) => g.swaps);
    // sessions the latest first, the one of none last; the rest the most requests first
    groups.sort((a, b) => by !== "session" ? b.calls - a.calls : (a.id === "none") - (b.id === "none") || (b.last > a.last) - (b.last < a.last));
    out.groups = groups;
    out.groupCount = groups.length;
  }
  return out;
}

function server(lang, asked) {
  return async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" }, fx: { rate: 7.2, at: new Date().toISOString() } });
    if (url.pathname === "/api/usage/requests") { asked.push(url.searchParams); return json(page(url.searchParams)); }
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/usage") return json({ calls: ROWS.length, errors: 1, input: 1, output: 1, reasoning: 0, unpriced: 0, cost: 0.1, bucket: "day", series: [], agents: [], models: [], path: "" });
    if (url.pathname === "/api/sessions") return json({ sessions: [], dirs: [] });
    if (url.pathname === "/api/sessions/stats") return json({ from: "", to: "", days: [], agents: {} });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const L = {
  en: {
    groups: ["No grouping", "Agents", "Models", "Sessions"], sum: "1 served-model mismatch", mis: "⚠ Only served-model mismatches 1",
    lines: [["swapped", "⚠ Served model:gpt-6-luna"], ["renamed", "Reply named:claude-sonnet-5-20260801"], ["routed", "Group picked:glm-fast"]],
    head: "⚠ Served model: gpt-6-luna", dts: ["Model requested", "Upstream request model", "Served model", "Actual provider"],
    why: "The model name the upstream returned doesn't match the upstream request model, under any spelling magpie recognizes. An alias or a dated version can also differ, so this warning alone doesn't prove the model was replaced.",
    rule: ["The served model is read from the reply's response.model (Responses).", "Not counted as a mismatch: only a date or version suffix, a vendor's own serving name, a relay's renaming, an alias listed in the provider's model list, the member a magpie group picked, auto."],
    none: "No served model", failed: "The request failed with no response body, so there is no served model.",
    local: "This one was imported from OpenCode's local session, whose record has no served model.",
    legend: ["3 groups listed", "Header figures are totals for the whole period; an opened group loads its rows a page at a time"],
    foot: "132 requests in this group, 100 shown", more: "Load 32 more", all: "132 requests in this group, 132 shown", only: "Show only this group",
    misFoot: "1 mismatch in this group, 1 shown", noSess: "Without a session ID", noSessSub: "These requests carried no session ID and aren't counted as one conversation",
    fresh: "133 requests in this group, 132 shown", noneFoot: ["4 requests in this group, 4 shown", "1 of them, turned away or a probe, isn't counted in the figures above"],
  },
  zh: {
    groups: ["不分组", "Agent", "模型", "会话"], sum: "响应模型不一致 1", mis: "⚠ 只看响应模型不一致 1",
    lines: [["swapped", "⚠ 响应模型：gpt-6-luna"], ["renamed", "响应：claude-sonnet-5-20260801"], ["routed", "分组挑中：glm-fast"]],
    head: "⚠ 响应模型：gpt-6-luna", dts: ["请求模型", "上游请求模型", "响应模型", "实际供应商"],
    why: "上游返回的模型名与上游请求模型不一致（magpie 能识别的写法差异已排除）。别名或日期版本也可能导致差异，不能仅凭此警示认定模型被替换。",
    rule: ["响应模型取自响应里的 response.model（Responses）。", "不算不一致：只差日期或版本后缀、厂商自己的服务名、中转站改名、供应商模型列表里登记的别名、magpie 分组挑中的成员、auto。"],
    none: "没有拿到响应模型", failed: "请求失败，没有响应体，拿不到响应模型。",
    local: "这条是从 OpenCode 本地会话导入的，本地记录里没有响应模型。",
    legend: ["3 组", "组头数字是整个时间段的合计；展开后按组分页加载"],
    foot: "本组 132 个请求，已显示 100 个", more: "再加载 32 个", all: "本组 132 个请求，已显示 132 个", only: "只看这一组",
    misFoot: "本组 1 个不一致，已显示 1 个", noSess: "无会话 ID", noSessSub: "这些请求没有带会话 ID，不当作一次对话",
    fresh: "本组 133 个请求，已显示 132 个", noneFoot: ["本组 4 个请求，已显示 4 个", "其中 1 条为被拒绝或探测请求，不计入上方数字"],
  },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(engine + ": the Requests grouped, and the served model compared", async (t) => {
    assert(["chromium", "webkit"].includes(engine), "BROWSER must be chromium or webkit");
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    for (const lang of ["en", "zh"]) {
      const w = L[lang];
      await t.test(lang, async () => {
        const errors = [], asked = [];
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
        t.after(() => ctx.close());
        const p = await ctx.newPage();
        p.setDefaultTimeout(5000);
        p.on("pageerror", (e) => errors.push(e.message));
        await p.addInitScript(() => localStorage.setItem('magpie.ledGroup', ''));
        await p.route("**/*", server(lang, asked));
        await p.goto("http://magpie.test/");
        await p.locator('[data-view="usage"]').first().click();
        await p.locator(":is(#usageTab .opt, .nav-s):visible").nth(1).click();
        await p.locator("#ledWrap .led tbody tr").first().waitFor();
        await p.waitForTimeout(200);
        // the last read of the list (a group's own read aside), once it is so
        const last = async (want, msg) => {
          for (let i = 0; i < 80 && !(asked.length && want(asked.at(-1))); i++) await p.waitForTimeout(25);
          assert(asked.length && want(asked.at(-1)), (msg || "asked") + ": " + asked.at(-1));
          await p.waitForTimeout(150);
        };
        // pressed where it is, brought into sight by the wheel as a reader
        // would: reach goes further down than click's own 1,600px, which an
        // opened group's 100 rows outrun
        const press = async (loc) => { await reader.reach(p, loc); await reader.click(p, loc); };
        const rows = p.locator("#ledWrap .led tbody tr.led-row");

        // the toolbar: the grouping, the mismatches' switch, and the sum's count
        const segs = await p.locator("#ledGroup .opt").allTextContents();
        assert.deepEqual(segs, w.groups);
        assert.equal(await p.locator("#ledGroup .opt.on").count(), 1);
        assert.equal(await p.locator("#ledGroup .opt").first().getAttribute("aria-pressed"), "true", "not grouped to begin with");
        assert.equal((await p.locator("#ledSum .mis").textContent()).trim(), w.sum);
        assert.equal((await p.locator("#ledMis").textContent()).trim(), w.mis);
        assert.equal(await p.locator("#ledMis").isEnabled(), true);

        // the model column: the one asked for, a line under it as the reply named it
        for (const [i, [as, text]] of w.lines.entries()) {
          const line = rows.nth(i).locator("td.model .led-sv");
          assert.equal(await line.getAttribute("class"), "led-sv " + as);
          assert.equal((await line.textContent()).trim(), text);
        }
        assert.equal(await rows.nth(0).locator(".led-mn").textContent(), "sol");
        assert.equal(await rows.nth(3).locator(".led-sv").count(), 0, "a failure: no line");
        assert.equal(await rows.nth(5).locator(".led-sv").count(), 0, "the same model: no line");
        assert.equal(await p.locator(".led .led-sv.swapped").count(), 1);
        const amber = await rows.nth(0).locator(".led-sv").evaluate((e) => getComputedStyle(e).color);
        assert.notEqual(amber, await rows.nth(1).locator(".led-sv").evaluate((e) => getComputedStyle(e).color), "the mismatch's line reads apart");

        // the card: on hover, gone when the pointer leaves
        const pop = p.locator("#ledPop");
        const pill = (i) => rows.nth(i).locator(".led-mp");
        await reader.reach(p, pill(0));
        await pill(0).hover();
        await pop.waitFor();
        assert.equal((await pop.locator("h4").textContent()).trim(), w.head);
        assert.deepEqual(await pop.locator("dt").allTextContents(), w.dts);
        assert.deepEqual(await pop.locator("dd").allTextContents(), ["sol", "gpt-6-sol", "gpt-6-luna", "Azure"]);
        assert.deepEqual(await pop.locator("p:not(.rule)").allTextContents(), [w.why]);
        assert.deepEqual(await pop.locator("p.rule").allTextContents(), w.rule);
        assert.equal(await pill(0).getAttribute("aria-expanded"), "true");
        await p.mouse.move(5, 890);
        await pop.waitFor({ state: "hidden" });
        assert.equal(await pill(0).getAttribute("aria-expanded"), "false");
        // pinned by a click, which doesn't open the row; let go by a click elsewhere
        await press(pill(0));
        await pop.waitFor();
        assert(await pop.evaluate((e) => e.classList.contains("pin")));
        await p.mouse.move(5, 890);
        await p.waitForTimeout(300);
        assert(await pop.isVisible(), "a pinned card stays");
        assert.equal(await p.locator(".led tbody tr.led-detail").count(), 0, "the pill's click doesn't open the row");
        await press(p.locator("#ledSum"));
        await pop.waitFor({ state: "hidden" });
        // no reply to name a model: why, for a failure and for a session file's
        for (const [i, why] of [[3, w.failed], [4, w.local]]) {
          await reader.reach(p, pill(i));
          await pill(i).focus();
          await pop.waitFor();
          assert.equal((await pop.locator("h4").textContent()).trim(), w.none);
          assert.equal((await pop.locator("p:not(.rule)").first().textContent()).trim(), why);
          await p.keyboard.press("Escape");
          await pop.waitFor({ state: "hidden" });
          await pill(i).blur();
        }

        // only the mismatches: the server's pick, over the whole period
        await press(p.locator("#ledMis"));
        await last((q) => q.get("mismatch") === "1" && !q.has("group"), "the switch asks the server");
        await p.waitForFunction(() => document.querySelectorAll("#ledWrap .led tbody tr.led-row").length === 1);
        assert.equal(await p.locator("#ledMis").getAttribute("aria-pressed"), "true");
        await press(p.locator("#ledMis"));
        await last((q) => !q.has("mismatch"));
        await p.waitForFunction(() => document.querySelectorAll("#ledWrap .led tbody tr.led-row").length === 100);

        // by agent: a header each, the whole period's sums, the most requests first
        await press(p.locator("#ledGroup .opt").nth(1));
        await last((q) => q.get("group") === "agent" && q.get("limit") === "1");
        await p.locator(".led-gh").first().waitFor();
        assert.deepEqual(await p.locator(".led-legend span").allTextContents(), w.legend);
        assert.equal(await p.locator(".led-gh").count(), 3);
        const head = p.locator(".led-gh").first();
        assert.equal(await head.getAttribute("aria-expanded"), "false");
        assert.equal((await head.locator(".led-gn b").textContent()).trim(), "Codex");
        const stats = await head.locator(".led-gs b").allTextContents();
        assert.equal(stats.length, 7);
        assert.equal(stats[0], "132", "the group's requests");
        assert.equal(stats[5], "1", "and its mismatches");
        assert.equal(await head.locator(".led-gs").nth(5).evaluate((e) => e.classList.contains("mis")), true);
        assert.equal(await p.locator(".led-gh").nth(1).locator(".led-gs").nth(5).evaluate((e) => e.classList.contains("zero")), true);
        assert.match(await head.locator(".led-share").getAttribute("title"), /98/);
        assert.equal(await p.evaluate(() => localStorage.getItem("magpie.ledGroup")), "agent", "kept for the next time");
        // opened: its rows, a page at a time
        await press(head);
        await last((q) => q.get("agent") === "codex" && q.get("offset") === "0" && q.get("limit") === "100" && !q.has("group"), "the group's rows");
        const foot = p.locator(".led-grp").first().locator(".led-gfoot");
        await foot.waitFor();
        assert.equal(await head.getAttribute("aria-expanded"), "true");
        assert.equal(await p.locator(".led-grp").first().locator("tbody tr.led-row").count(), 100);
        assert.equal((await foot.locator("span").first().textContent()).trim(), w.foot);
        assert.deepEqual(await foot.locator("button").allTextContents(), [w.more, w.only]);
        await press(foot.locator("button").first());
        await last((q) => q.get("agent") === "codex" && q.get("offset") === "100");
        await p.waitForFunction(() => document.querySelector(".led-grp tbody").querySelectorAll("tr.led-row").length === 132);
        assert.equal((await foot.locator("span").first().textContent()).trim(), w.all);
        assert.deepEqual(await foot.locator("button").allTextContents(), [w.only]);
        // a refresh with a request come in: the group read again in place, as
        // many as were shown, its rows the same elements, no "Loading", the
        // pinned card still on its row
        const grp = p.locator(".led-grp").first();
        await press(grp.locator("tbody tr.led-row").nth(5).locator(".led-mp"));
        await pop.waitFor();
        await p.evaluate(() => { window.__kept = document.querySelectorAll(".led-grp tbody tr.led-row")[5]; window.__loading = 0;
          new MutationObserver(() => { if (document.querySelector(".led-grp .led-gbody > .led-none")) window.__loading++; }).observe(document.querySelector(".led-groups"), { childList: true, subtree: true }); });
        const y = await p.evaluate(() => scrollY);
        ROWS.unshift({ ...ROWS[5], t: new Date().toISOString() });
        await p.evaluate(() => loadLedger(true));
        await last((q) => q.get("agent") === "codex" && q.get("offset") === "0" && q.get("limit") === "132", "read again as many as shown");
        await p.waitForFunction(() => document.querySelector(".led-grp .led-gfoot span")?.textContent.includes("133"));
        assert.equal((await foot.locator("span").first().textContent()).trim(), w.fresh);
        assert.equal((await grp.locator(".led-gs b").first().textContent()), "133");
        assert.equal(await p.evaluate(() => window.__kept.isConnected && document.querySelectorAll(".led-grp tbody tr.led-row")[6] === window.__kept), true, "the row kept, one down");
        assert.equal(await p.evaluate(() => window.__loading), 0, "no Loading shown");
        assert(Math.abs(await p.evaluate(() => scrollY) - y) < 2, "not scrolled");
        assert(await pop.isVisible(), "the pinned card stays");
        await press(p.locator("#ledSum"));
        await pop.waitFor({ state: "hidden" });
        ROWS.shift();
        await p.evaluate(() => loadLedger(true));
        await p.waitForFunction(() => document.querySelector(".led-grp .led-gs b")?.textContent === "132" && document.querySelectorAll(".led-grp tbody tr.led-row").length === 132);
        // with only the mismatches: the groups that have any, their headers whole
        await press(p.locator("#ledMis"));
        await last((q) => q.get("mismatch") === "1" && q.get("agent") === "codex", "the open group read again");
        await p.waitForFunction(() => document.querySelectorAll(".led-gh").length === 1);
        assert.equal(await p.locator(".led-gh").first().locator(".led-gs b").first().textContent(), "132", "a header sums all of its group");
        await p.locator(".led-grp .led-gfoot").waitFor();
        assert.equal((await p.locator(".led-grp .led-gfoot span").first().textContent()).trim(), w.misFoot);
        await press(p.locator("#ledMis"));
        await last((q) => !q.has("mismatch"));

        // by model: the one asked for, a group's rows read by it
        await press(p.locator("#ledGroup .opt").nth(2));
        await last((q) => q.get("group") === "model");
        await p.waitForFunction(() => document.querySelectorAll(".led-gh").length === 5);
        assert.equal((await p.locator(".led-gh").first().locator(".led-gn b").textContent()).trim(), "sol");
        await press(p.locator(".led-gh").first());
        await last((q) => q.get("requested") === "sol" && q.get("offset") === "0" && !q.has("model"), "read by the model asked for");
        await press(p.locator(".led-gh").first());

        // by session: the calls with none are a group of their own
        await press(p.locator("#ledGroup .opt").nth(3));
        await last((q) => q.get("group") === "session");
        await p.waitForFunction(() => [...document.querySelectorAll(".led-gh")].length === 3);
        const none = p.locator(".led-gh").filter({ hasText: w.noSess });
        assert.equal((await none.locator(".led-gn b").textContent()).trim(), w.noSess);
        assert.equal((await none.locator(".led-gn small").textContent()).trim(), w.noSessSub);
        await press(none);
        await last((q) => q.get("session") === "none" && q.has("offset"));
        await p.locator(".led-grp.open .led-gfoot").waitFor();
        assert.equal((await none.locator(".led-gs b").first().textContent()), "3", "the one turned away isn't in the header");
        assert.deepEqual((await p.locator(".led-grp.open .led-gfoot > span:not(.grow)").allTextContents()).map((x) => x.trim()), w.noneFoot);
        const only = p.locator(".led-grp.open .led-gfoot button").filter({ hasText: w.only });
        await press(only);
        await last((q) => q.get("session") === "none" && !q.has("group"), "only this group");
        await p.waitForFunction(() => document.querySelectorAll("#ledWrap .led tbody tr.led-row").length === 4);
        assert(await p.locator("#ledSess").isVisible());
        assert.equal((await p.locator("#ledSessLabel").textContent()).trim(), w.noSess);
        assert.equal(await p.locator("#ledGroup .opt").first().getAttribute("aria-pressed"), "true", "listed ungrouped");
        await press(p.locator("#ledSessClear"));
        await last((q) => !q.has("session") && !q.has("group"));
        assert(await p.locator("#ledSess").isHidden());

        assert.deepEqual(errors, []);
      });
    }
  });
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium','webkit'])) {
  test(`${engine}: Requests starts with categories and retains an explicit flat view`, async t => {
    const b=await(engine==='webkit'?webkit.launch():chromium.launch({channel:'chromium'}));t.after(()=>b.close());
    const p=await b.newPage({viewport:{width:1280,height:1000}}), asked=[],errors=[];p.setDefaultTimeout(5000);p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',server('en',asked));await p.goto('http://magpie.test/');
    await p.locator('[data-view="usage"]').first().click();await p.locator(':is(#usageTab .opt, .nav-s):visible').nth(1).click();
    await p.locator('.led-grp').first().waitFor();
    assert.equal(await p.locator('#ledGroup .opt.on').textContent(),'Agents');
    assert(asked.some(q=>q.get('group')==='agent'),'fresh request page asks for whole-period Agent groups');
    const primary=await p.evaluate(()=>{const pane=document.querySelector('#ledgerPane'),tabs=pane.querySelector('.led-explorer'),rows=pane.querySelector('.led-table'),trend=pane.querySelector('#ledDash'),heat=pane.querySelector('#ledHeat');return {beforeRows:tabs.nextElementSibling===rows,trendBefore:!!(trend.compareDocumentPosition(tabs)&Node.DOCUMENT_POSITION_FOLLOWING),heatBefore:!!(heat.compareDocumentPosition(tabs)&Node.DOCUMENT_POSITION_FOLLOWING)}});
    assert(primary.beforeRows&&primary.trendBefore&&primary.heatBefore,'charts stay above, category controls sit immediately before request groups');
    await p.locator('#ledGroup .opt').filter({hasText:/^Sessions$/}).click();
    await p.waitForFunction(()=>document.querySelector('.led-groups')?.dataset.by==='session');
    assert(await p.locator('.led-gh',{hasText:'Without a session ID'}).isVisible());
    await p.setViewportSize({width:420,height:900});await p.waitForTimeout(150);
    assert(await p.locator('#ledGroup').isVisible());
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
    await p.locator('#ledGroup .opt').filter({hasText:/^No grouping$/}).click();
    await p.locator('#ledWrap .led-row').first().waitFor();
    assert.equal(await p.evaluate(()=>localStorage.getItem('magpie.ledGroup')),'');
    await p.reload();await p.locator('#ledGroup .opt.on').waitFor();
    assert.equal(await p.locator('#ledGroup .opt.on').textContent(),'No grouping','explicit flat preference survives reload');
    assert.deepEqual(errors,[]);
  });
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium','webkit'])) {
  test(`${engine}: group metrics fit without truncating speed or overlapping labels`, async t => {
    const b=await(engine==='webkit'?webkit.launch():chromium.launch({channel:'chromium'}));t.after(()=>b.close());
    for(const lang of ['en','zh','de']){
      const p=await b.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(5000);
      await p.route('**/*',server(lang,[]));
      await p.route('**/api/usage/requests?**',route=>{const d=page(new URL(route.request().url()).searchParams);for(const g of d.groups||[])Object.assign(g,{decode_ms:1000,decode_out:14,decode_n:22869});return route.fulfill({json:d});});
      await p.goto('http://magpie.test/');await p.locator('[data-view="usage"]').first().click();await p.locator(':is(#usageTab .opt, .nav-s):visible').nth(1).click();await p.locator('.led-gh .speed').first().waitFor();
      const expected=(100*sum(ROWS.filter(r=>r.agent==='codex')).calls/sum(ROWS).calls).toFixed(1)+'%';
      assert.equal(await p.locator('.led-gh .led-share-value').first().textContent(),expected,'the visible percentage uses the whole-period request count');
      assert((await p.locator('.led-gh .led-share').first().getAttribute('title')).includes(expected.slice(0,-1)),'tooltip uses the same percentage with localized spacing');
      for(const width of [1440,1000,760,420,320]){
        await p.setViewportSize({width,height:1000});await p.waitForTimeout(120);
        const dims=await p.locator('.led-gh').first().evaluate(e=>{const metrics=[...e.querySelectorAll('.led-gs')],speed=e.querySelector('.speed'),r=e.getBoundingClientRect();const boxes=metrics.map(x=>x.getBoundingClientRect());return {shareCut:[...e.querySelectorAll('.led-share small,.led-share-value')].some(x=>x.scrollWidth>x.clientWidth+1),speed:speed.querySelector('b').textContent,tip:speed.title,cut:metrics.flatMap(x=>[...x.children]).filter(x=>x.scrollWidth>x.clientWidth+1).map(x=>x.textContent),outside:boxes.some(b=>b.right>r.right+.5||b.left<r.left-.5),overlap:boxes.some((a,i)=>boxes.some((b,j)=>j>i&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5))};});
        assert.equal(dims.shareCut,false,'share label and percentage fit');assert.match(dims.speed,/14/);assert(!dims.speed.includes('869'),'sample count stays in tooltip');assert(dims.tip.includes('869'),'full sample count remains available');assert.deepEqual(dims.cut,[],`${lang} ${width} clipped metric`);assert.equal(dims.outside,false);assert.equal(dims.overlap,false);
      }
      await p.close();
    }
  });
}
