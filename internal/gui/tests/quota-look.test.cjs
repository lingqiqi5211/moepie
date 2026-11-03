// Run with Node's test runner and Playwright on the module path; see README.md.
// The allowances' arrangement and charts. Two picks in their head, kept
// across a reload: wide cards (a card a row, its charts beside the meters,
// under them on a narrow window) or columns, and Summary (one account of a
// card in full, the others' tightest window at the card's foot; columns'
// default) or By account (every account in full; wide cards' default).
// A window's chart is its longest window only, a line over a light area, a
// dashed even pace, a dotted carry at this pace to where it runs out or to
// the reset, labelled in the text's colour; "2 days" draws the shortest
// window's rises and falls. A balance is carried to where it runs out; the
// credits a day are thin bars, today's light, the most and today's figures
// on them and the days' average dashed. Each reading's value is in a strip
// wider than its mark. No readings, no chart, and no room kept for one.
// English and Chinese, light and dark; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const dayKey = (back) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function fixtures(now) {
  const r5 = now + 3 * H, rw = now + 3 * 24 * H;
  const quotas = [
    { provider: "codex", name: "Codex", icon: "openai", plan: "Plus", user: "a@x.com", readAt: iso(now), windows: [
      { name: "5 hours", used: 40, startsAt: iso(r5 - 5 * H), resetsAt: iso(r5) },
      { name: "Weekly", used: 80, startsAt: iso(rw - 168 * H), resetsAt: iso(rw) },
    ] },
    { provider: "codex", name: "Codex", icon: "openai", plan: "Pro", user: "b@x.com", windows: [
      { name: "5 hours", used: 10, resetsAt: iso(r5) },
      { name: "Weekly", used: 85, resetsAt: iso(rw) },
    ] },
    { provider: "kimi", name: "Kimi", icon: "kimi-color", windows: [{ name: "Weekly", used: 10, resetsAt: iso(rw) }] },
    // a top-up to ¥50 two days ago, ¥10 a day spent since
    { provider: "deepseek", name: "DeepSeek", icon: "deepseek", windows: [], balance: "¥30.00", readAt: iso(now),
      balanceTrend: { points: [[96, 5], [72, 3], [48, 50], [36, 45], [24, 40], [12, 35], [0, 30]].map(([h, v]) => ({ at: iso(now - h * H), amount: v })),
        fitFrom: iso(now - 48 * H), fitStart: 50, fitNow: 30, perDay: 10, runsOut: iso(now + 72 * H) } },
    { provider: "moonshot", name: "Moonshot", icon: "moonshot", windows: [], balance: "$12.00", readAt: iso(now), balanceTrend: { points: [{ at: iso(now), amount: 12 }] } },
    { provider: "workbuddy", name: "WorkBuddy", icon: "workbuddy-color", plan: "Free", user: "李雷", windows: [{ name: "Credits", used: 8.9, display: "500.52 / 5600" }],
      daily: { since: dayKey(4), days: [{ day: dayKey(4), used: 30.25 }, { day: dayKey(2), used: 60 }, { day: dayKey(0), used: 12.5 }] } },
  ];
  const pt = (h, left, start, reset) => ({ at: iso(now + h * H), left, start: iso(start), resetsAt: iso(reset) });
  // the 5-hour window before its last reset, then this one: a sawtooth
  const five = [pt(-7, 100, r5 - 10 * H, r5 - 5 * H), pt(-5, 70, r5 - 10 * H, r5 - 5 * H), pt(-3, 40, r5 - 10 * H, r5 - 5 * H),
    pt(-2, 100, r5 - 5 * H, r5), pt(-1, 80, r5 - 5 * H, r5), pt(0, 60, r5 - 5 * H, r5)];
  const week = (lefts) => lefts.map(([h, left]) => pt(h, left, rw - 168 * H, rw));
  const history = [
    // 20 a day from 60: out in a day, two before the reset
    { provider: "codex", user: "a@x.com", lines: [{ name: "5 hours", points: five }, { name: "Weekly", points: week([[-48, 60], [-24, 40], [0, 20]]) }] },
    // 4 a day from 23: lasts to the reset, a little left
    { provider: "codex", user: "b@x.com", lines: [{ name: "Weekly", points: week([[-48, 23], [-24, 19], [0, 15]]) }] },
  ];
  return { quotas, history };
}

function serve(lang, theme, data, store) {
  const settings = { theme, lang, tray: "panel", quotaLeft: false, currency: "usd" };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ json: body });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"${theme}",web:true};` + (store ? `try { ${Object.entries(store).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("")} } catch {}` : "") });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/usage/quotas") return json(data.quotas);
    if (url.pathname === "/api/usage/quotas/history/holds") return json([]);
    if (url.pathname === "/api/usage/quotas/history") return json(data.history);
    if (url.pathname === "/api/usage") return json({ calls: 0, input: 0, output: 0, cost: 0, agents: [], accounts: [], models: [], series: [], days: [] });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

const words = {
  en: { wide: "Wide cards", multi: "Columns", sum: "Summary", acct: "By account", week: "Weekly", five: "5 hours", now: "Now", today: "Today", day7: "7 days",
    cycle: (n) => n + " · this cycle", two: (n) => n + " · last 2 days", runsOut: /^≈ .+ runs out$/, eta: /^Runs out .+ at this pace$/, atReset: /^About \d+% used at the reset$/, used: (n) => n + "% used",
    even: "Even pace", pace: "At this pace", balance: "Balance over time", out: "Runs out", inDays: "Runs out in 3d at this pace", perDay: "about ¥10.00 a day",
    avg: "Daily average 22.56", most: /Most on [^·]+: 60 · /, todays: "12.5 today", bar: /: 60 credits$/, unknown: /: not counted — magpie began counting on / },
  zh: { wide: "宽卡片", multi: "多排卡片", sum: "汇总", acct: "按账号", week: "每周", five: "5 小时", now: "现在", today: "今天", day7: "7 天",
    cycle: (n) => n + " · 本周期", two: (n) => n + " · 最近 2 天", runsOut: /^≈ .+ 用完$/, eta: /^按此速度，预计 .+ 用完$/, atReset: /^重置时约用 \d+%$/, used: (n) => "已用 " + n + "%",
    even: "匀速", pace: "按现在速度", balance: "余额走势", out: "预计用完", inDays: "按此速度，预计 3 天后用完", perDay: "约每天 ¥10.00",
    avg: "日均 22.56", most: /最多 [^·]+：60 · /, todays: "今天 12.5", bar: /：60 积分$/, unknown: /：未统计，magpie 从 .+ 开始统计$/ },
};

// texts: an svg's labels, as laid out, for overlaps and colours
const texts = (loc) => loc.evaluate((g) => [...g.querySelectorAll("text")].map((e) => {
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return { text: e.textContent, cls: e.getAttribute("class") || "", axis: !!e.closest(".qc-axis"), x: r.x, y: r.y, w: r.width, h: r.height, fill: cs.fill, stroke: cs.stroke };
}));
const cssColor = (page, v, prop = "color") => page.evaluate(([v, prop]) => { const s = document.createElement("i"); s.style[prop] = `var(${v})`; document.querySelector(".subscription-card").append(s); const c = getComputedStyle(s)[prop]; s.remove(); return c; }, [v, prop]);
const overlaps = (ls) => ls.flatMap((a, i) => ls.slice(i + 1).filter((b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5).map((b) => a.text + " / " + b.text));
// settled: no packing pending a frame after the last layout, so a card
// measured stays where it was
const settled = (page) => page.evaluate(async () => {
  for (;;) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!usagePackFrame) return;
  }
});
const fits = (page) => page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth,
  cards: [...document.querySelectorAll(".subscription-card")].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.dataset.key + ": " + [...c.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > c.getBoundingClientRect().right + 1).map((e) => e.className.baseVal ?? e.className).slice(0, 4).join(", ")) }));

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    const w = words[lang];
    test(`${engine} ${lang}: the allowances in columns or wide cards, in summary or by account, kept`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await (await browser.newContext({ viewport: { width: 900, height: 900 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang, "light", fixtures(Date.now())));
      await page.goto("http://magpie.test/?view=usage");
      const list = page.locator("#subscriptionUsage"), codex = page.locator('.subscription-card[data-key="codex"]');
      await codex.locator(".quota-curve").first().waitFor();
      const layout = page.locator("#quotaHead #quotaLayout"), stat = page.locator("#quotaHead #quotaStat");
      assert.deepEqual(await layout.locator(".opt").allTextContents(), [w.wide, w.multi]);
      assert.deepEqual(await stat.locator(".opt").allTextContents(), [w.sum, w.acct]);
      // columns and a summary by default
      assert.equal(await layout.locator(".opt.on").textContent(), w.multi);
      assert.equal(await stat.locator(".opt.on").textContent(), w.sum);
      assert.equal(await layout.locator(".opt.on").getAttribute("aria-pressed"), "true");
      assert.ok(await list.evaluate((l) => l.classList.contains("multi") && !l.classList.contains("wide")));
      // one account in full, the other's tightest window at the card's foot
      assert.equal(await codex.locator(".q-body").count(), 1);
      const order = await codex.evaluate((c) => [...c.children].map((e) => e.className.split(" ")[0] + (e.classList.contains("brief") ? ".brief" : "")));
      assert.deepEqual(order.slice(1), ["subscription-account", "q-body", "subscription-account.brief", "quota-windows.brief"]);
      const foot = codex.locator(".quota-windows.brief");
      assert.equal(await foot.locator(".quota").count(), 1, "its tightest window alone");
      assert.match(await foot.locator(".quota-name").textContent(), new RegExp(w.week));
      assert.equal(await foot.locator(".quota").getAttribute("data-used"), "85");
      assert.match(await codex.locator(".subscription-account.brief").textContent(), /b@x\.com/);
      // in columns, the charts under the meters
      const main = await codex.locator(".q-main").boundingBox(), viz = await codex.locator(".q-viz").boundingBox();
      assert.ok(viz.y >= main.y + main.height - 1, "under the meters");
      // a click on one keeps the page where it was
      const y = await page.locator("#view-usage").evaluate((v) => v.scrollTop);

      // By account: every account in full, no fold or button for the rest
      await stat.locator(".opt", { hasText: w.acct }).click();
      await page.waitForFunction(() => document.querySelectorAll('.subscription-card[data-key="codex"] .q-body').length === 2);
      assert.equal(await codex.locator(".brief").count(), 0);
      assert.equal(await codex.locator(".quota-more, .quota-acct-fold").count(), 0);
      assert.equal(await codex.locator(".quota-curve").count(), 2);
      assert.equal(await page.evaluate(() => localStorage.getItem("magpie.quotaStat")), "acct");

      // wide cards: a card a row, the charts beside the meters
      await page.setViewportSize({ width: 1280, height: 900 });
      await layout.locator(".opt", { hasText: w.wide }).click();
      await page.waitForFunction(() => document.querySelector("#subscriptionUsage").classList.contains("wide"));
      assert.equal(await page.evaluate(() => localStorage.getItem("magpie.quotaLayout")), "wide");
      assert.equal(await page.locator("#view-usage").evaluate((v) => v.scrollTop), y, "the picks don't scroll");
      await page.waitForFunction(() => { const l = document.querySelector("#subscriptionUsage"); return [...l.children].every((c) => Math.abs(c.getBoundingClientRect().width - l.clientWidth) < 2); });
      const wm = await codex.locator(".q-main").first().boundingBox(), wv = await codex.locator(".q-viz").first().boundingBox();
      assert.ok(wv.x >= wm.x + wm.width && Math.abs(wv.y - wm.y) < 2, `beside the meters: ${JSON.stringify([wm, wv])}`);
      assert.ok(Math.abs(wv.width - 380) < 30, "the charts' column about 380px: " + wv.width);
      // no chart, no room kept for one
      const kimi = page.locator('.subscription-card[data-key="kimi"]');
      assert.equal(await kimi.locator(".q-viz, .quota-curve").count(), 0);
      assert.equal(await kimi.locator(".q-body.has-viz").count(), 0);
      // a narrow window: the charts under the meters again, nothing past an edge
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForFunction(() => { const c = document.querySelector('.subscription-card[data-key="codex"]'); const m = c.querySelector(".q-main").getBoundingClientRect(), v = c.querySelector(".q-viz").getBoundingClientRect(); return v.y >= m.bottom - 1; });
      assert.deepEqual(await fits(page), { page: false, cards: [] });

      // both kept across a reload
      await page.reload();
      await codex.locator(".quota-curve").first().waitFor();
      assert.equal(await layout.locator(".opt.on").textContent(), w.wide);
      assert.equal(await stat.locator(".opt.on").textContent(), w.acct);
      // back to columns and a summary
      await layout.locator(".opt", { hasText: w.multi }).click();
      await stat.locator(".opt", { hasText: w.sum }).click();
      await page.waitForFunction(() => document.querySelectorAll('.subscription-card[data-key="codex"] .q-body').length === 1);
      assert.deepEqual(await page.evaluate(() => [localStorage.getItem("magpie.quotaLayout"), localStorage.getItem("magpie.quotaStat")]), ["multi", "sum"]);
      assert.deepEqual(errors, []);
    });

    test(`${engine} ${lang}: wide cards show every account in full until a summary is picked`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang, "dark", fixtures(Date.now()), { "magpie.quotaLayout": "wide" }));
      await page.goto("http://magpie.test/?view=usage");
      const codex = page.locator('.subscription-card[data-key="codex"]');
      await codex.locator(".quota-curve").first().waitFor();
      assert.equal(await page.locator("#quotaStat .opt.on").textContent(), w.acct);
      assert.equal(await codex.locator(".q-body").count(), 2);
      // a card with one account has no Summary to pick
      const single = fixtures(Date.now());
      single.quotas = single.quotas.filter((q) => q.user !== "b@x.com");
      const one = await (await browser.newContext({ viewport: { width: 900, height: 900 }, reducedMotion: "reduce" })).newPage();
      await one.route("**/*", serve(lang, "light", single));
      await one.goto("http://magpie.test/?view=usage");
      await one.locator(".quota-curve").first().waitFor();
      assert.equal(await one.locator("#quotaStat").isHidden(), true);
      assert.equal(await one.locator("#quotaLayout").isHidden(), false);
      assert.deepEqual(errors, []);
    });

    test(`${engine} ${lang}: an allowance's chart, its balance and its days, labelled and with values on hover`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const errors = [];
      const strokes = {};
      for (const theme of ["light", "dark"]) {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" })).newPage();
        page.setDefaultTimeout(5000);
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, theme, fixtures(Date.now()), { "magpie.quotaLayout": "wide" }));
        await page.goto("http://magpie.test/?view=usage");
        const codex = page.locator('.subscription-card[data-key="codex"]');
        const [a, b] = [codex.locator(".quota-curve").first(), codex.locator(".quota-curve").nth(1)];
        await b.waitFor();
        // the longest window, this cycle: one line, its even pace, now
        assert.equal(await a.locator(".qc-title").textContent(), w.cycle(w.week));
        assert.equal(await a.locator("path.qc-line").count(), 1);
        assert.equal(await a.locator("path.qc-line").getAttribute("data-name"), "Weekly");
        assert.equal(await a.locator("path.qv-area").count(), 1);
        assert.equal(await a.locator("line.qc-even").count(), 1);
        assert.equal(await a.locator("line.qc-now").count(), 1);
        assert.equal(await a.locator(".qc-legend, .qc-key").count(), 0, "no legend for one line");
        assert.deepEqual(await a.locator(".qv-key").allTextContents(), [w.even, w.pace]);
        // at this pace: out before the reset, and when; the other lasts
        assert.match(await a.locator("text.qv-proj-t").textContent(), w.runsOut);
        assert.equal(await a.locator("path.qv-proj").count(), 1);
        assert.match(await b.locator("text.qv-proj-t").textContent(), w.atReset);
        // said to a screen reader too, the same time as the meter
        assert.equal(await a.locator("svg.qv").getAttribute("role"), "img");
        assert.equal(await a.locator("svg.qv").getAttribute("aria-label"), [w.cycle(w.week), w.used(80), await a.locator("text.qv-proj-t").textContent()].join(" · "));
        assert.equal(await b.locator("svg.qv").getAttribute("aria-label"), [w.cycle(w.week), w.used(85), await b.locator("text.qv-proj-t").textContent()].join(" · "));
        // its axis: the start, now, the reset; now kept
        const axis = await a.locator(".qc-axis text").allTextContents();
        assert.ok(axis.includes(w.now) && axis.length === 3, JSON.stringify(axis));
        assert.equal(await a.locator(".qc-axis text.qv-keep").textContent(), w.now);
        // each reading's value on hover, in strips wider than its dot
        const hits = await a.locator("rect.qv-hit").evaluateAll((rs) => rs.map((r) => ({ tip: r.querySelector("title").textContent, w: +r.getAttribute("width"), h: +r.getAttribute("height") })));
        assert.deepEqual(hits.map((h) => h.tip.split(" · ").at(-1)), [w.used(40), w.used(60), w.used(80)]);
        assert.ok(hits.every((h) => h.w > 8 && h.h > 8), JSON.stringify(hits));
        await settled(page);
        await a.locator("rect.qv-hit").nth(1).hover();
        assert.equal(await a.locator("rect.qv-hit").nth(1).evaluate((r) => r.matches(":hover") && getComputedStyle(r).fillOpacity), "0.05");
        // the meters agree: a pace tick, and the week running out said
        const week = codex.locator(".q-main").first().locator(".quota").nth(1);
        assert.ok(await week.evaluate((q) => q.classList.contains("eta")));
        assert.match(await week.locator(".quota-eta").textContent(), w.eta);
        assert.equal(await codex.locator(".q-main").first().locator(".quota-tick").count(), 2);
        // text in the text's colours, with a halo of the card's; the line in
        // the theme's chart colour
        const fg2 = await cssColor(page, "--fg-2"), card = await cssColor(page, "--card"), c1 = await cssColor(page, "--c1");
        for (const l of await texts(a.locator("svg.qv"))) {
          assert.notEqual(l.fill, c1, "never in the line's colour: " + l.text);
          if (l.cls.includes("qv-v")) assert.deepEqual([l.fill, l.stroke], [fg2, card], l.text);
        }
        strokes[theme] = await a.locator("path.qc-line").evaluate((e) => getComputedStyle(e).stroke);
        assert.equal(strokes[theme], c1);
        for (const c of [a, b]) assert.deepEqual(overlaps(await texts(c.locator("svg.qv"))), [], "no label over another");

        // the balance: carried on to where it runs out
        const bal = page.locator('.subscription-card[data-key="deepseek"] .balance-curve');
        assert.equal(await bal.locator(".qc-title").textContent(), w.balance);
        assert.equal(await bal.locator("text.qv-proj-t").textContent(), w.out);
        assert.equal(await bal.locator(".qc-range").textContent(), w.inDays);
        assert.equal(await bal.locator(".qv-sub").textContent(), w.perDay);
        assert.ok((await bal.locator(".qc-axis text").allTextContents()).includes(w.now));
        const tips = await bal.locator("rect.qv-hit title").allTextContents();
        assert.equal(tips.length, 7);
        assert.match(tips.at(-1), /¥30/);
        assert.deepEqual(overlaps(await texts(bal.locator("svg.qv"))), []);
        assert.equal(await bal.locator("svg.qv").getAttribute("aria-label"), [w.balance, "¥30.00", w.perDay, w.inDays].join(" · "));
        // one reading draws nothing
        assert.equal(await page.locator('.subscription-card[data-key="moonshot"] .balance-curve, .subscription-card[data-key="moonshot"] .q-viz').count(), 0);

        // the credits a day, over 7 days
        await page.locator("#period .opt", { hasText: new RegExp("^" + w.day7 + "$") }).click();
        const days = page.locator('.subscription-card[data-key="workbuddy"] .credit-days');
        await page.waitForFunction(() => document.querySelectorAll('.subscription-card[data-key="workbuddy"] rect.qv-hit').length === 7);
        assert.equal(await days.locator("path.qv-bar").count(), 3);
        assert.equal(await days.locator("path.qv-bar.today").count(), 1);
        assert.equal(await days.locator("line.qv-unknown").count(), 2, "the days before counting began are no zero");
        const bars = await days.locator("path.qv-bar").evaluateAll((ps) => ps.map((p) => p.getBBox().height));
        assert.ok(Math.abs(bars[0] / bars[1] - 30.25 / 60) < 0.02, JSON.stringify(bars));
        assert.deepEqual((await days.locator("text.qv-top").allTextContents()).sort(), ["12.5", "60"], "the most and today's only");
        assert.equal(await days.locator("text.qv-avg-t").textContent(), w.avg);
        assert.equal(await days.locator("line.qv-avg").count(), 1);
        const dayAxis = days.locator(".qc-axis text");
        assert.equal(await dayAxis.last().textContent(), w.today);
        assert.equal(await days.locator(".qc-axis text.qv-keep").textContent(), w.today);
        const dayTips = await days.locator("rect.qv-hit title").allTextContents();
        assert.match(dayTips[4], w.bar);
        assert.match(dayTips[0], w.unknown);
        assert.deepEqual(overlaps(await texts(days.locator("svg.qv"))), []);
        const dayLabel = await days.locator("svg.qv").getAttribute("aria-label");
        assert.ok(dayLabel.endsWith(" · " + w.avg) && dayLabel.includes(" · " + w.todays + " · "), dayLabel);
        assert.match(dayLabel, w.most);
        // the edge bars' outer halves give their values too; scrolled to and
        // read in one go, the cards packed first
        await settled(page);
        const edge = await days.evaluate((box) => {
          box.querySelector("svg.qv").scrollIntoView({ block: "center" });
          const bars = [...box.querySelectorAll("path.qv-bar")].map((p) => p.getBoundingClientRect()), slot = box.querySelector("line.qv-unknown").getBoundingClientRect();
          const at = (x, y) => document.elementFromPoint(x, y)?.closest?.("rect.qv-hit")?.querySelector("title").textContent;
          const last = bars.at(-1);
          return { right: at(last.right - 0.5, last.bottom - 1), left: at(slot.left + 0.5, slot.top), first: box.querySelector("rect.qv-hit title").textContent };
        });
        assert.equal(edge.right, w.todays, JSON.stringify(edge));
        assert.equal(edge.left, edge.first, JSON.stringify(edge));
        assert.deepEqual(await fits(page), { page: false, cards: [] });
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-quota-look-${theme}.png`), fullPage: true });
        }

        if (theme === "light") {
          // 2 days: the 5-hour window's rises and falls, no pace, no carry
          await page.locator("#quotaTrend").click();
          await page.locator(".sess-menu .pm-item").nth(1).click();
          await page.waitForFunction((t) => document.querySelector('.subscription-card[data-key="codex"] .qc-title')?.textContent === t, w.two(w.five));
          assert.equal(await a.locator("path.qc-line").count(), 2, "broken where the window began again");
          assert.equal(await a.locator("line.qc-even, path.qv-proj, .qv-key").count(), 0);
          assert.equal(await a.locator(".qc-axis text.qv-keep").textContent(), w.now);
          assert.equal(await a.locator("rect.qv-hit").count(), 6);
          // Off: no chart and no room for one, the meters as they were
          await page.locator("#quotaTrend").click();
          await page.locator(".sess-menu .pm-item").first().click();
          await page.waitForFunction(() => !document.querySelector(".quota-curve"));
          assert.equal(await codex.locator(".q-viz, .q-body.has-viz").count(), 0);
          assert.equal(await page.locator(".balance-curve").count(), 0, "the balance's goes too");
          assert.equal(await page.locator(".credit-days").count(), 1, "the days' sums are no trend: kept");
          assert.equal(await codex.locator(".q-main .quota").count(), 4);
          await page.locator("#quotaTrend").click();
          await page.locator(".sess-menu .pm-item").nth(2).click();
          await a.locator("svg.qv").waitFor();
        }
      }
      assert.notEqual(strokes.light, strokes.dark, "dark has its own line colour");
      assert.deepEqual(errors, []);
    });
  }

  // two cards on a 1600px window sit side by side, their charts' text near
  // the page's; a tap shows a value; a day's few credits still a bar; a card
  // asked for opens the account in brief
  test(`${engine}: charts capped on a wide window, values on a tap, small days seen, an account asked for opened`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const errors = [];
    const data = fixtures(Date.now());
    data.quotas = data.quotas.filter((q) => q.provider === "codex" || q.provider === "workbuddy");
    // one day's 0.01 beside 60, and over 7 days a single day counted
    data.quotas[2].daily = { since: dayKey(1), days: [{ day: dayKey(1), used: 60 }, { day: dayKey(0), used: 0.01 }] };
    const open = async (opts, store, url = "http://magpie.test/?view=usage") => {
      const page = await (await browser.newContext({ reducedMotion: "reduce", ...opts })).newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve("en", "light", data, store));
      await page.goto(url);
      await page.locator(".quota-curve svg.qv").first().waitFor();
      return page;
    };
    let page = await open({ viewport: { width: 1600, height: 1000 } });
    await page.locator("#period .opt", { hasText: /^7 days$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".credit-days rect.qv-hit").length === 7);
    await settled(page);
    const size = await page.evaluate(() => ({ cards: [...document.querySelectorAll(".subscription-card")].map((c) => c.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, top: r.top })),
      charts: [...document.querySelectorAll("svg.qv")].map((s) => s.getBoundingClientRect().height), multi: document.querySelector("#subscriptionUsage").classList.contains("multi"),
      under: [...document.querySelectorAll(".q-body.has-viz")].every((b) => b.querySelector(".q-viz").getBoundingClientRect().top >= b.querySelector(".q-main").getBoundingClientRect().bottom - 1) }));
    // two cards side by side in one row, not stacked 1200px wide
    const [a, b] = size.cards;
    assert.ok(size.multi && size.cards.length === 2 && Math.abs(a.top - b.top) < 1 && b.left >= a.right && size.under, JSON.stringify(size));
    assert.ok(size.charts.length >= 2 && size.charts.every((h) => h <= (520 * 116) / 360 + 1), JSON.stringify(size));
    // 0.01 beside 60: a bar 2 units tall, not a hairline
    const days = page.locator('.subscription-card[data-key="workbuddy"] .credit-days');
    const bars = await days.locator("path.qv-bar").evaluateAll((ps) => ps.map((p) => p.getBBox().height));
    assert.equal(bars.length, 2, "two days counted, two bars");
    assert.ok(Math.abs(bars[1] - 2) < 0.2, JSON.stringify(bars));
    assert.equal(await days.locator("line.qv-unknown").count(), 5);

    // a tap (no title on a touch screen) shows the value; a press elsewhere hides it
    page = await open({ viewport: { width: 420, height: 900 }, hasTouch: true, isMobile: true });
    const hit = page.locator('.subscription-card[data-key="codex"] .quota-curve rect.qv-hit').last();
    await hit.tap();
    const tip = page.locator(".qv-tip");
    assert.equal(await tip.textContent(), await hit.locator("title").textContent());
    assert.equal(await tip.getAttribute("role"), "tooltip");
    const r = await tip.boundingBox();
    assert.ok(r.x >= 0 && r.x + r.width <= 420, JSON.stringify(r));
    await page.locator('.subscription-card[data-key="codex"] .subscription-head').tap();
    assert.equal(await tip.count(), 0);

    // asked for from the menu bar: the account in brief opened in full, in
    // view; By account leaves the Summary's choice alone
    page = await open({ viewport: { width: 900, height: 500 } }, null, "http://magpie.test/?view=usage&card=" + encodeURIComponent("codex|b@x.com"));
    await page.locator('.subscription-account[data-card="codex|b@x.com"]:not(.brief)').waitFor();
    await page.waitForFunction(() => !quotaFocus);
    assert.equal(await page.locator('.subscription-card[data-key="codex"] .q-body').count(), 2);
    assert.ok(await page.locator('.subscription-account[data-card="codex|b@x.com"]').evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), "scrolled to");
    page = await open({ viewport: { width: 900, height: 500 } }, { "magpie.quotaStat": "acct" }, "http://magpie.test/?view=usage&card=" + encodeURIComponent("codex|b@x.com"));
    await page.waitForFunction(() => !quotaFocus);
    assert.equal(await page.evaluate(() => localStorage.getItem("magpie.usageAccounts")), null);
    assert.deepEqual(errors, []);
  });

  test(`${engine}: a chart with no reset says no pace, and a window with no readings has none`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 900, height: 900 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const now = Date.now(), data = fixtures(now);
    data.quotas = [{ provider: "glm", name: "GLM", icon: "zhipu", windows: [{ name: "Monthly", used: 30 }] }];
    data.history = [{ provider: "glm", user: "", lines: [{ name: "Monthly", points: [{ at: iso(now - 30 * H), left: 90 }, { at: iso(now - 10 * H), left: 80 }, { at: iso(now), left: 70 }] }] }];
    await page.route("**/*", serve("en", "light", data));
    await page.goto("http://magpie.test/?view=usage");
    const card = page.locator('.subscription-card[data-key="glm"]');
    await card.locator(".quota-windows").waitFor();
    // drawn from its readings to now, with nothing made up past it
    await card.locator(".quota-curve svg.qv").waitFor();
    assert.equal(await card.locator("line.qc-even, path.qv-proj, .qv-key").count(), 0);
    assert.ok(!/NaN|Infinity/.test(await card.locator("path.qc-line").first().getAttribute("d")));
    assert.equal(await card.locator("rect.qv-hit").count(), 3);
    assert.equal(await card.locator(".qc-axis text.qv-keep").textContent(), "Now");
    assert.equal(await card.locator(".quota-tick, .quota-eta").count(), 0, "no pace without a reset");
    assert.deepEqual(errors, []);
  });
}
