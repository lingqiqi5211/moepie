// Run with Node's test runner and Playwright on the module path; see README.md.
// The context window card: three figures side by side (how full, the cache,
// the session), the parts of the prompt as a bar of them by default or a
// block each, a switch away and the reader's pick; the tags under them, the
// bar's legend, pick one part, as a part of the bar clicked does, and the
// contents show it alone. A part pointed at tells what it holds. Beside the
// contents, the session's prompts request by request: a point pointed at
// says its request, clicked it stays said with a button to open it, and a
// compaction is marked; a live tick leaves the point the reader is on as it
// is, and the points are one tab stop, the arrows going between them. An
// item clicked opens its text, where an image the request sent inline is
// shown. The figures fit their cells. With motion reduced nothing moves. In
// every language, at a desk and a phone's width.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const now = Date.now();
const ago = (m) => new Date(now - m * 60000).toISOString();

const LATEST = {
  window: 272000, tokens: 21400, counted: true, turns: 3,
  parts: [
    { kind: "system", tokens: 5200, items: [{ name: "prompt", tokens: 4900 }, { name: "environment_context", tokens: 300 }] },
    { kind: "tools", tokens: 5000, items: [{ name: "multi_agent_v1", tag: "namespace", n: 5, tokens: 2900 }, { name: "exec_command", tokens: 2100 }] },
    { kind: "skills", tokens: 2600, items: [{ name: "skills", tag: "skills", tokens: 2600 }] },
    { kind: "memory", tokens: 700, items: [{ name: "/work/app/AGENTS.md", tag: "project", tokens: 700 }] },
    { kind: "files", tokens: 5900, items: [{ name: "/work/app/prompt.go", tag: "shell", tokens: 2950 }, { name: "/work/app/context.go", tag: "shell", tokens: 2950 }] },
    { kind: "results", tokens: 1200, items: [{ name: "exec_command", tag: "result", n: 4, tokens: 1200 }] },
    { kind: "chat", tokens: 800, items: [{ name: "turn", tag: "turn", n: 3, tokens: 800 }] },
  ],
};
const context = (days, latest = LATEST) => ({
  days,
  agents: [
    { agent: "codex", requests: 9, sessions: 1, errors: 0, calls: 9, median: 17700, p90: 21400, baseline: 13300, window: 272000, cache: 0.74, growth: 228, peakFill: 0.08, compacts: 0,
      shares: { system: 0.29, tools: 0.28, memory: 0.18, files: 0.18, results: 0.04, chat: 0.03 }, mcp: 0,
      score: 94, scores: [{ key: "cache", points: 29, most: 35 }, { key: "lean", points: 25, most: 25 }, { key: "pace", points: 20, most: 20 }, { key: "reliable", points: 20, most: 20 }],
      tags: [{ key: "lean", tone: "good", value: 13300 }, { key: "memory-heavy", tone: "info", value: 0.18 }],
      models: ["live/codex/gpt-5.6-luna"], latestId: 19, latestTime: ago(4) },
    { agent: "claude", requests: 12, sessions: 2, errors: 3, calls: 15, median: 140000, p90: 180000, baseline: 70000, window: 200000, cache: 0.2, growth: 9000, peakFill: 0.9, compacts: 1,
      shares: { system: 0.1, tools: 0.6, memory: 0.05, files: 0.1, results: 0.1, chat: 0.05 }, mcp: 28000,
      score: 31, scores: [{ key: "cache", points: 8, most: 35 }, { key: "lean", points: 3, most: 25 }, { key: "pace", points: 10, most: 20 }, { key: "reliable", points: 10, most: 20 }],
      tags: [{ key: "cache-misses", tone: "warn", value: 0.2 }, { key: "heavy-start", tone: "warn", value: 70000 }, { key: "mcp-heavy", tone: "info", value: 28000 }],
      models: ["claude-sonnet-5"], latestId: 30, latestTime: ago(9) },
  ],
  sessions: [
    { agent: "codex", key: "01a117b1-aecd-76e2-9b2f-3c1d", title: "Port the parser", model: "live/codex/gpt-5.6-luna", first: ago(12), last: ago(4), requests: 3, peak: 21400, window: 272000,
      latest, latestId: 19, points: [{ id: 17, time: ago(12), tokens: 13000, cache: 0 }, { id: 18, time: ago(8), tokens: 17700, cache: 12000 }, { id: 19, time: ago(4), tokens: 21400, cache: 20900 }] },
    { agent: "claude", key: "ce0c93f6-1111-2222-3333-444444444444", model: "claude-sonnet-5", first: ago(30), last: ago(9), requests: 1, peak: 180000, window: 200000,
      latest: { ...LATEST, window: 200000, tokens: 180000 }, latestId: 30, points: [{ id: 30, time: ago(9), tokens: 180000 }] },
  ],
});

// the text as /api/context/text gives it: request 19's is kept, 30's isn't
// a 2×2 PNG, as the gateway gives an image the request sent inline
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4AWP4z8DwHwyBGBMgEmAAAP0eB/k1J7hZAAAAAElFTkSuQmCC";
const LONG = "You are Codex. ".repeat(20000); // 300,000 characters
const texts = {
  system: [{ name: "prompt", tokens: 4900, pieces: [{ role: "system", text: LONG }] }, { name: "environment_context", tokens: 300, pieces: [{ role: "user", text: "<environment_context>cwd /work/app</environment_context>" }] }],
  tools: [{ name: "multi_agent_v1", tag: "namespace", n: 5, tokens: 2900, pieces: [{ role: "tool", name: "spawn_agent", text: "{\n  \"name\": \"spawn_agent\"\n}" }] },
    { name: "exec_command", tokens: 2100, pieces: [{ role: "tool", name: "exec_command", text: "{\n  \"name\": \"exec_command\",\n  \"description\": \"Runs a command in a PTY\"\n}" }] }],
  files: [{ name: "/work/app/prompt.go", tag: "shell", tokens: 2950, pieces: [{ role: "result", name: "exec_command", text: "package gateway // prompt.go" }] },
    { name: "/work/app/context.go", tag: "shell", tokens: 2950, pieces: [{ role: "result", name: "exec_command", text: "package gui // context.go" }] }],
  skills: [{ name: "skills", tag: "skills", tokens: 2600, pieces: [{ role: "system", text: "## Skills" }] }],
  memory: [{ name: "/work/app/AGENTS.md", tag: "project", tokens: 700, pieces: [{ role: "user", text: "# AGENTS.md" }] }],
  results: [{ name: "exec_command", tag: "result", n: 4, tokens: 1200, pieces: [{ role: "result", name: "exec_command", text: "ok" }] }],
  chat: [{ name: "1", tag: "turn", tokens: 300, pieces: [{ role: "user", text: "port the parser" }, { role: "thinking", text: "", size: 900 }, { role: "call", name: "exec_command", text: "{\"cmd\": \"ls\"}" }] },
    { name: "2", tag: "turn", tokens: 500, pieces: [{ role: "image", src: PNG }, { role: "image" }, { role: "assistant", text: "Done." }] }],
};
function text(url, r) {
  if (url.searchParams.get("id") !== "19") return r.fulfill({ status: 404, body: "not kept" });
  const kind = url.searchParams.get("kind"), item = url.searchParams.get("item");
  const items = (texts[kind] || []).map((it, i) => item !== null && +item === i ? it : { ...it, pieces: undefined });
  return r.fulfill({ json: { id: 19, kind, items, kept: 10 } });
}

function serve(lang, asked, latest) {
  const state = { agents: [{ id: "claude", name: "Claude Code", path: "/test/claude", fields: [] }, { id: "codex", name: "Codex", path: "/test/codex", fields: [] }], profiles: [], settings: { lang, theme: "light" } };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/context") {
      asked.push(url.searchParams.get("days"));
      return json(context(+url.searchParams.get("days"), latest));
    }
    // the text comes a moment after it is asked, as it does under load:
    // the dialog says "Reading…" first, and the test waits past it
    if (url.pathname === "/api/context/text") { await new Promise((ok) => setTimeout(ok, 200)); return text(url, r); }
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.get("wait")) return new Promise(() => {});
      return json({ mine: true, now: new Date().toISOString(), seq: 0, totals: { requests: 0, rerouted: 0, errors: 0 }, routes: [] });
    }
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file).catch(() => ""), contentType, status: 200 });
  };
}

// the reader scrolls (the wheel) until what they'll point at is in view:
// the app puts back a scroll that isn't the reader's, a test's own included
async function wheelTo(page, l) {
  // over the page, not the sidebar beside it
  const v = await page.locator("#view-usage").boundingBox();
  await page.mouse.move(v.x + v.width / 2, 300);
  for (let i = 0; i < 40 && await l.evaluate((b) => b.getBoundingClientRect().bottom > innerHeight - 70); i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(50);
  }
  // a wheel scroll is eased: hovered while it runs, Chromium scrolls the
  // view to the part, the app puts that scroll back, the part moves out
  // from under the pointer and its tip closes again. Wait until the target
  // stops moving.
  // Under load an eased scroll can pause for a frame and go on, so the
  // target has to hold still for three looks in a row.
  for (let last = null, same = 0, i = 0; i < 60 && same < 2; i++) {
    await page.waitForTimeout(100);
    const now = await l.evaluate((b) => { const r = b.getBoundingClientRect(); return r.x + "," + r.y + "," + document.querySelector("#view-usage")?.scrollTop; });
    same = now === last ? same + 1 : 0;
    last = now;
  }
}

const words = {
  en: { tools: "Tools", skills: "Skills", memory: "Memory", files: "Files", all: "All", close: "Close", bar: "Segmented bar", blocks: "By kind", req: "Request 1", open: "Open this request", run: "This session", cut: "Compacted", one: "1 compaction" },
  zh: { tools: "工具", skills: "技能", memory: "记忆", files: "文件", all: "全部", close: "关闭", bar: "分段条", blocks: "按类分块", req: "请求 1", open: "打开这个请求", run: "本会话", cut: "已压缩", one: "压缩 1 次" },
  "zh-TW": { tools: "工具", skills: "技能", memory: "記憶", files: "檔案", all: "全部", close: "關閉", bar: "分段條", blocks: "按類分塊", req: "請求 1", open: "開啟這個請求", run: "本會話", cut: "已壓縮", one: "壓縮 1 次" },
  ja: { tools: "ツール", skills: "スキル", memory: "メモリ", files: "ファイル", all: "すべて", close: "閉じる", bar: "セグメントバー", blocks: "種類別ブロック", req: "リクエスト 1", open: "このリクエストを開く", run: "このセッション", cut: "圧縮", one: "圧縮 1 回" },
  de: { tools: "Tools", skills: "Skills", memory: "Memory", files: "Dateien", all: "Alle", close: "Schließen", bar: "Segmentbalken", blocks: "Nach Art", req: "Anfrage 1", open: "Diese Anfrage öffnen", run: "Diese Sitzung", cut: "Komprimiert", one: "1 Komprimierung" },
};


async function open(page, lang, width, latest) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", serve(lang, [], latest));
  await page.addInitScript(() => { try { if (!sessionStorage.getItem("set")) { localStorage.clear(); localStorage.setItem("magpie.usageTab", "context"); sessionStorage.setItem("set", "1"); } } catch {} });
  await page.goto("http://magpie.test/?view=usage");
  const card = await openSession(page);
  return { errors, card };
}
async function openSession(page) {
  const row = page.locator(".ctx-sess-row", { hasText: "Port the parser" });
  await row.waitFor();
  await wheelTo(page, row);
  await row.click();
  const card = page.locator(".ctx-sess.open .ctx-card");
  await card.waitFor();
  return card;
}
const rowNames = (card) => card.locator(".ctx-contents .ctx-row .ctx-name").allInnerTexts();

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of Object.keys(words)) {
    for (const width of [1100, 420]) {
      const w = words[lang];
      test(`${engine} ${lang} ${width}px: the parts, the tags and the session's curve`, async (t) => {
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
        t.after(() => browser.close());
        const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(60000);
        let { errors, card } = await open(page, lang, width);

        // three figures: how full, the cache, the session
        assert.equal(await card.locator(".ctx-top > .ctx-stat").count(), 3);
        assert.match(await card.locator(".ctx-run").textContent(), new RegExp(w.run));

        // the bar is the default: a part each, named in its label, the
        // blocks hidden
        const bar = card.locator(".ctx-segbar");
        await bar.locator(".ctx-seg.k-tools").waitFor();
        assert.equal(await card.locator(".ctx-viz").getAttribute("data-look"), "bar");
        assert.ok(await card.locator(".ctx-blocks").isHidden(), "the blocks show under the bar");
        assert.equal(await bar.locator(".ctx-seg").count(), 7);
        assert.match(await bar.getAttribute("aria-label"), new RegExp(w.tools));
        assert.equal(await card.locator(".ctx-sec .segs .opt.on").textContent(), w.bar);
        // the tags: All, then each part
        const tags = card.locator(".ctx-legend .ctx-leg");
        assert.equal(await tags.count(), 8);
        assert.equal(await tags.first().getAttribute("aria-pressed"), "true");
        assert.match(await tags.first().textContent(), new RegExp(w.all));
        await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === "running" && a.effect?.target?.closest?.(".ctx-sess.open")));

        // a part pointed at tells what it holds
        const tools = bar.locator(".ctx-seg.k-tools");
        await wheelTo(page, card.locator(".ctx-legend"));
        await tools.hover();
        const tip = card.locator(".ctx-tip");
        await tip.waitFor({ state: "visible" });
        assert.match(await tip.textContent(), new RegExp(w.tools));
        assert.match(await tip.textContent(), /multi_agent_v1/);
        await page.mouse.move(2, 2);
        await tip.waitFor({ state: "hidden" });
        // the skills are their own part, not memory (the owner 10-24: 技能 / 记忆)
        await bar.locator(".ctx-seg.k-skills").hover();
        await tip.waitFor({ state: "visible" });
        const said = await tip.textContent();
        assert.match(said, new RegExp(w.skills));
        assert.doesNotMatch(said, new RegExp(w.memory), "the skills' tip names memory");
        assert.notEqual(await bar.locator(".ctx-seg.k-skills").evaluate((n) => getComputedStyle(n).backgroundColor),
          await bar.locator(".ctx-seg.k-memory").evaluate((n) => getComputedStyle(n).backgroundColor), "the skills are memory's colour");
        await page.mouse.move(2, 2);
        await tip.waitFor({ state: "hidden" });

        // a part clicked shows it alone: the others dimmed, its tag on, the
        // contents its items; clicked again, all of them
        await tools.click();
        assert.equal(await card.locator('.ctx-leg[data-k="tools"]').getAttribute("aria-pressed"), "true");
        assert.equal(await bar.locator(".ctx-seg.dim").count(), 6);
        let names = await rowNames(card);
        assert.ok(names.some((n) => n.includes("multi_agent_v1")) && !names.some((n) => n.includes("prompt.go")), names.join(" | "));
        // the part's text a click away
        await card.locator(".ctx-contents-head .ctx-open").click();
        const view = page.locator("#modal .ctx-view");
        await view.locator(".ctx-vi-head").first().waitFor();
        assert.match(await view.textContent(), /exec_command/);
        await view.locator(".bar button", { hasText: w.close }).click();
        await page.locator("#modal").waitFor({ state: "hidden" });
        await tools.click();
        assert.equal(await bar.locator(".ctx-seg.dim").count(), 0);
        assert.equal(await tags.first().getAttribute("aria-pressed"), "true");

        // a tag picks its part as well, and All them all
        await card.locator('.ctx-leg[data-k="files"]').click();
        names = await rowNames(card);
        assert.ok(names.length === 2 && names.every((n) => /\.go/.test(n)), names.join(" | "));
        assert.match(await card.locator(".ctx-contents-head").textContent(), new RegExp(w.files));
        await tags.first().click();
        assert.ok((await rowNames(card)).length > 2);

        // a refresh with the same window keeps the parts where they are
        const kept = await tools.elementHandle();
        await page.evaluate(() => window.loadContext());
        await page.waitForTimeout(300);
        assert.ok(await kept.evaluate((n) => n.isConnected), "the refresh drew the bar again");

        // clicked, an item opens its text
        await card.locator(".ctx-contents .ctx-row", { hasText: "multi_agent_v1" }).click();
        await view.locator(".ctx-text").first().waitFor();
        await view.locator(".bar button", { hasText: w.close }).click();
        await page.locator("#modal").waitFor({ state: "hidden" });

        // an image the request sent inline is shown in its turn; one it
        // didn't send that way is named
        await page.evaluate(() => window.openCtxText(19, "chat"));
        await view.locator(".ctx-vi-head").nth(1).click();
        const pic = view.locator(".ctx-vi.open .ctx-pic");
        await pic.locator("img").waitFor();
        await page.waitForFunction(() => document.querySelector("#modal .ctx-pic img")?.naturalWidth === 2);
        assert.equal(await view.locator(".ctx-vi.open .ctx-piece-note").count(), 1, "the image not sent inline is named");
        await pic.click();
        assert.equal(await pic.getAttribute("aria-expanded"), "true", "a picture clicked opens larger");
        assert.ok(await page.evaluate(() => { const d = document.querySelector("#modal .dialog").getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth; }), "the dialog fits the window");
        await view.locator(".bar button", { hasText: w.close }).click();
        await page.locator("#modal").waitFor({ state: "hidden" });

        // the session's curve: a point pointed at says its request, the
        // tip at the point; clicked, it stays said, with a button to open it
        const curve = card.locator(".ctx-curve");
        assert.equal(await curve.locator(".ctx-cv-hit").count(), 3);
        assert.ok(await curve.locator(".ctx-cv-y").count() >= 2, "the curve has no ticks");
        assert.equal(await curve.locator("svg .line").evaluate((n) => getComputedStyle(n).strokeWidth), "2px");
        const first = curve.locator(".ctx-cv-hit").first();
        await wheelTo(page, curve.locator(".ctx-cv-read"));
        await first.hover();
        await tip.waitFor({ state: "visible" });
        assert.match(await tip.textContent(), /13K/);
        assert.match(await tip.textContent(), new RegExp(w.req));
        assert.match(await curve.locator(".ctx-cv-read").textContent(), new RegExp(w.req));
        const [tb, db] = [await tip.boundingBox(), await curve.locator(".ctx-cv-dot").boundingBox()];
        assert.ok(tb.x < db.x + db.width && tb.x + tb.width > db.x, "the tip is away from its point");
        await first.click();
        await page.mouse.move(2, 2);
        await tip.waitFor({ state: "hidden" });
        assert.match(await curve.locator(".ctx-cv-read").textContent(), new RegExp(w.req), "the point clicked isn't said");
        const go = curve.locator(".ctx-cv-open");
        assert.equal(await go.textContent(), w.open);
        await page.waitForFunction(() => typeof window.openRoute === "function");
        await page.evaluate(() => { window.__opened = []; window.openRoute = (id) => { window.__opened.push(id); return Promise.resolve(); }; });
        await go.click();
        assert.deepEqual(await page.evaluate(() => window.__opened), [17]);
        // the request drawn has none to open
        await curve.locator(".ctx-cv-hit").last().click();
        assert.ok(await go.isHidden(), "the request drawn can be opened from itself");

        // the blocks a switch away, and still the pick after a reload
        await wheelTo(page, card.locator(".ctx-sec"));
        await card.locator(".ctx-sec .segs .opt", { hasText: w.blocks }).click();
        await page.waitForFunction(() => document.querySelector(".ctx-sess.open .ctx-viz")?.dataset.look === "blocks");
        assert.ok(await bar.isHidden());
        assert.equal(await card.locator(".ctx-blocks .ctx-block").count(), 7);
        assert.equal(await page.evaluate(() => localStorage.getItem("magpie.ctxLook")), "blocks");
        // a block's head picks its part, an item in it opens its text
        await card.locator(".ctx-block.k-files .ctx-block-h").click();
        assert.equal(await card.locator('.ctx-leg[data-k="files"]').getAttribute("aria-pressed"), "true");
        assert.equal(await card.locator(".ctx-block.dim").count(), 6);
        await card.locator(".ctx-block.k-tools .ctx-block-r").first().click();
        await view.locator(".ctx-text").first().waitFor();
        await view.locator(".bar button", { hasText: w.close }).click();
        await page.locator("#modal").waitFor({ state: "hidden" });
        await page.reload();
        card = await openSession(page);
        await card.locator(".ctx-block").first().waitFor();
        assert.equal(await card.locator(".ctx-viz").getAttribute("data-look"), "blocks");
        await wheelTo(page, card.locator(".ctx-sec"));
        await card.locator(".ctx-sec .segs .opt", { hasText: w.bar }).click();
        await card.locator(".ctx-segbar .ctx-seg").first().waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem("magpie.ctxLook")), "bar");

        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways");
        assert.deepEqual(errors, []);
      });
    }

    // a compaction: marked on the curve, counted in the session's figure,
    // said for its point
    test(`${engine} ${lang}: a compaction on the session's curve`, async (t) => {
      const w = words[lang];
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
      page.setDefaultTimeout(5000);
      const { errors } = await open(page, lang);
      await page.evaluate(() => {
        const series = [30000, 60000, 90000, 40000, 50000].map((tokens, i) => ({ id: 50 + i, time: new Date(Date.now() - (5 - i) * 60000).toISOString(), tokens }));
        const prompt = { window: 200000, tokens: 50000, counted: true, parts: [{ kind: "chat", tokens: 50000, items: [{ name: "turn", tag: "turn", n: 4, tokens: 50000 }] }] };
        const c = window.ctxCard({ id: 54, agent: "codex", done: true, prompt }, { series, place: "test" });
        c.id = "cutCard";
        document.querySelector("#view-usage").prepend(c);
      });
      const card = page.locator("#cutCard");
      assert.equal(await card.locator(".ctx-cv-cut").count(), 1);
      assert.match(await card.locator(".ctx-cv-cut").textContent(), new RegExp(w.cut));
      assert.equal(await card.locator(".ctx-plot svg .cut").count(), 1);
      assert.match(await card.locator(".ctx-run .ctx-sub").textContent(), new RegExp(w.one, "i"));
      await card.locator(".ctx-cv-hit").nth(3).focus();
      assert.match(await card.locator(".ctx-cv-read").textContent(), new RegExp(w.cut + ".*50K"));
      assert.deepEqual(errors, []);
    });

    // Figures stay compact: summary rows on phones, three across in
    // medium cards too, without clipping the figures or health words.
    test(`${engine} ${lang}: the figures fit their cells`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
      page.setDefaultTimeout(5000);
      const { errors } = await open(page, lang);
      // the card's own width, inside its padding (22px a side) and border
      for (const width of [320, 420, 560, 640, 760]) {
        await page.evaluate((width) => {
          document.querySelector("#statBox")?.remove();
          const box = document.createElement("div");
          box.id = "statBox";
          box.style.width = width + 46 + "px";
          const series = [180000, 200000, 220000, 240000].map((tokens, i) => ({ id: 60 + i, time: new Date(Date.now() - (4 - i) * 60000).toISOString(), tokens }));
          const prompt = { window: 272000, tokens: 240000, counted: true, parts: [{ kind: "chat", tokens: 240000, items: [{ name: "turn", tag: "turn", n: 4, tokens: 240000 }] }] };
          box.append(window.ctxCard({ id: 63, agent: "codex", done: true, prompt }, { series, cache: { read: 230000, total: 240000 }, place: "stats" + width }));
          document.querySelector("#view-usage").prepend(box);
        }, width);
        await page.waitForFunction((narrow) => document.querySelector("#statBox .ctx-card")?.classList.contains("max720") === narrow, width <= 720);
        const cells = page.locator("#statBox .ctx-top > .ctx-stat");
        assert.equal(await cells.count(), 3);
        const out = await cells.evaluateAll((cs) => cs.flatMap((c) => {
          const bad = [], box = c.getBoundingClientRect();
          if (c.scrollWidth > c.clientWidth) bad.push(c.className + " runs out of its cell");
          for (const e of c.querySelectorAll(".ctx-k, .ctx-big, .ctx-sub")) if (e.scrollWidth > e.clientWidth) bad.push(c.className + " " + e.className + " runs over");
          for (const e of c.querySelectorAll(".ctx-sub")) {
            if (e.scrollHeight > e.clientHeight + 1 || getComputedStyle(e).webkitLineClamp !== "none") bad.push("statistics description is clipped");
          }
          // the figure and the health word are whole, inside the cell
          for (const e of c.querySelectorAll(".ctx-big b, .ctx-health")) if (e.getBoundingClientRect().right > box.right + 0.5) bad.push(c.className + " " + e.tagName + " is cut");
          return bad;
        }));
        assert.deepEqual(out, [], `${width}px`);
        const tops = await cells.evaluateAll((cs) => cs.map((c) => Math.round(c.getBoundingClientRect().top)));
        if (width <= 520) {
          assert.ok(tops[0] < tops[1] && tops[1] < tops[2], `${width}px: the summary rows aren't stacked`);
          const height = await cells.first().evaluate((c) => c.getBoundingClientRect().height);
          assert.ok(height < 105, `${width}px: summary row wastes height (${height}px)`);
        } else assert.ok(tops[0] === tops[1] && tops[1] === tops[2], `${width}px: the figures aren't side by side`);
      }
      assert.deepEqual(errors, []);
    });
  }

  // a card under way, its session's prompts 70 to 74 (or as given), the
  // last one growing: draw(last) draws it, or a tick of it
  const tickCard = (page) => page.evaluate(() => {
    window.__draw = (last, ids = [70, 71, 72, 73, 74]) => {
      const series = ids.map((id, i) => ({ id, time: new Date(Date.now() - (ids.length - i) * 60000).toISOString(), tokens: i === ids.length - 1 ? last : 20000 + i * 10000 }));
      const prompt = { window: 200000, tokens: last, counted: true, parts: [{ kind: "chat", tokens: last, items: [{ name: "turn", tag: "turn", n: ids.length, tokens: last }] }] };
      const r = { id: ids[ids.length - 1], agent: "codex", done: false, prompt };
      const o = { series, place: "tick", onPoint: (x) => (window.__opened ||= []).push(x.id) };
      const had = document.querySelector("#tickCard");
      if (had) return had.ctxUpdate(r, o);
      const c = window.ctxCard(r, o);
      c.id = "tickCard";
      document.querySelector("#view-usage").prepend(c);
    };
    window.__draw(60000);
  });

  // live, the request under way grows on every tick: the point pointed at,
  // focused or pinned stays so, its tip open; a request come draws the
  // points anew, the reader put back on theirs
  test(`${engine}: the session's curve through live ticks`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    page.setDefaultTimeout(5000);
    const { errors } = await open(page, "en");
    await tickCard(page);
    const draw = (last, ids) => page.evaluate(([l, i]) => window.__draw(l, i), [last, ids]);
    const card = page.locator("#tickCard");
    const hits = card.locator(".ctx-cv-hit"), tip = card.locator(".ctx-tip"), read = card.locator(".ctx-cv-read");
    await wheelTo(page, read);

    // pointed at
    const second = await hits.nth(1).elementHandle();
    await hits.nth(1).hover();
    await tip.waitFor({ state: "visible" });
    await draw(61000);
    await draw(62000);
    assert.ok(await second.evaluate((n) => n.isConnected), "a tick drew the points anew");
    assert.ok(await tip.isVisible(), "a tick closed the tip pointed at");
    assert.match(await tip.textContent(), /Request 2/);
    assert.match(await read.textContent(), /Request 2/);
    assert.match(await hits.nth(4).getAttribute("aria-label"), /Request 5: 62K tokens/);
    await page.mouse.move(2, 2);
    await tip.waitFor({ state: "hidden" });

    // focused
    const third = await hits.nth(2).elementHandle();
    await third.focus();
    await tip.waitFor({ state: "visible" });
    await draw(63000);
    assert.ok(await third.evaluate((n) => n === document.activeElement), "a tick took the focus");
    assert.ok(await tip.isVisible(), "a tick closed the focused point's tip");
    assert.match(await read.textContent(), /Request 3/);
    await third.evaluate((n) => n.blur());
    await tip.waitFor({ state: "hidden" });

    // pinned
    await hits.nth(0).click();
    await page.mouse.move(2, 2);
    await tip.waitFor({ state: "hidden" });
    await draw(64000);
    assert.match(await read.textContent(), /Request 1/, "a tick lost the point pinned");
    assert.ok(await card.locator(".ctx-cv-open").isVisible());

    // a request come: the points drawn anew, the focus on the same request
    // and the pin kept
    await hits.nth(1).focus();
    const label = await hits.nth(1).getAttribute("aria-label");
    await draw(66000, [70, 71, 72, 73, 74, 75]);
    assert.equal(await hits.count(), 6);
    assert.equal(await page.evaluate(() => document.activeElement?.closest("#tickCard .ctx-cv-hits") ? document.activeElement.getAttribute("aria-label") : null), label, "the focus left the request");
    assert.equal(await hits.nth(1).getAttribute("tabindex"), "0");
    assert.ok(await tip.isVisible(), "the focused point's tip closed");
    await page.evaluate(() => document.activeElement.blur());
    await tip.waitFor({ state: "hidden" });
    assert.match(await read.textContent(), /Request 1/, "a request come lost the pin");
    assert.deepEqual(errors, []);
  });

  // the points are one tab stop: the arrows, Home and End go between
  // them, Enter pins one, Escape unpins it
  test(`${engine}: the session's curve from the keyboard`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    page.setDefaultTimeout(5000);
    const { errors } = await open(page, "en");
    await tickCard(page);
    const card = page.locator("#tickCard");
    const hits = card.locator(".ctx-cv-hit"), tip = card.locator(".ctx-tip"), read = card.locator(".ctx-cv-read");
    const stops = card.locator('.ctx-cv-hit[tabindex="0"]');
    const on = () => page.evaluate(() => [...document.querySelectorAll("#tickCard .ctx-cv-hit")].indexOf(document.activeElement));
    await wheelTo(page, read);
    await page.mouse.move(2, 2);

    // one stop, on the request drawn; each point labelled
    assert.equal(await stops.count(), 1);
    assert.equal(await hits.nth(4).getAttribute("tabindex"), "0");
    assert.match(await hits.nth(0).getAttribute("aria-label"), /Request 1: 20K tokens/);
    await hits.nth(4).focus();
    for (const [key, to] of [["ArrowLeft", 3], ["Home", 0], ["ArrowLeft", 0], ["ArrowRight", 1], ["End", 4], ["ArrowRight", 4], ["ArrowLeft", 3]]) {
      await page.keyboard.press(key);
      assert.equal(await on(), to, key);
      assert.equal(await stops.count(), 1, key);
      assert.equal(await hits.nth(to).getAttribute("tabindex"), "0", key);
    }
    assert.ok(await tip.isVisible());
    assert.match(await tip.textContent(), /Request 4/);

    // Enter pins it: the line under the plot stays on it
    await page.keyboard.press("Enter");
    if (engine === "chromium") {
      // Tab leaves the points at once, and comes back to the one pinned
      await page.keyboard.press("Tab");
      assert.equal(await on(), -1, "Tab went on to another point");
      await tip.waitFor({ state: "hidden" });
      assert.match(await read.textContent(), /Request 4/, "Enter didn't pin the point");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await on(), 3);
    } else {
      await page.evaluate(() => document.activeElement.blur());
      await tip.waitFor({ state: "hidden" });
      assert.match(await read.textContent(), /Request 4/, "Enter didn't pin the point");
      await hits.nth(3).focus();
    }

    // Escape unpins, back on the request drawn, the tip closed
    await page.keyboard.press("Escape");
    await tip.waitFor({ state: "hidden" });
    assert.match(await read.textContent(), /Request 5 · this one/);
    assert.equal(await on(), 3, "Escape took the focus");
    assert.deepEqual(errors, []);
  });

  // with motion reduced the parts are simply there
  test(`${engine}: the parts hold still with motion reduced`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(60000);
    const { errors, card } = await open(page, "en", 1100);
    await card.locator(".ctx-segbar .ctx-seg").first().waitFor();
    const moving = () => page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.(".ctx-viz")).length);
    assert.equal(await moving(), 0, "a part came in with motion reduced");
    await wheelTo(page, card.locator(".ctx-sec"));
    await card.locator(".ctx-sec .segs .opt", { hasText: "By kind" }).click();
    await card.locator('.ctx-leg[data-k="tools"]').click();
    assert.equal(await moving(), 0, "the switch moved with motion reduced");
    assert.deepEqual(errors, []);
  });
}
