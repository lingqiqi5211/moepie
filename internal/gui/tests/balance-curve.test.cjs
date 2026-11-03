// Run with Node's test runner and Playwright on the module path; see README.md.
// A key's balance over time (TJHHHH on Discord): under a balance's figure on
// the Usage page, its readings as a line over a light area, dotted on at
// its fitted pace from the last reading to zero, labelled "Runs out", when
// that is within twice what is shown, and "Runs out in 3d at this pace" in
// the chart's head with what is spent a day; each reading's figure on
// hover. A key of one reading has no chart, and the allowances' "Off" takes
// it away too.
// English and Chinese, light and dark; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

function fixtures(now) {
  // a top-up to ¥50 two days ago, ¥10 a day spent since
  const points = [[96, 5], [72, 3], [48, 50], [36, 45], [24, 40], [12, 35], [0, 30]].map(([h, v]) => ({ at: iso(now - h * H), amount: v }));
  return [
    { provider: "deepseek", name: "DeepSeek", icon: "deepseek", windows: [], balance: "¥30.00", readAt: iso(now),
      balanceTrend: { points, fitFrom: iso(now - 48 * H), fitStart: 50, fitNow: 30, perDay: 10, runsOut: iso(now + 72 * H) } },
    { provider: "moonshot", name: "Moonshot", icon: "moonshot", windows: [], balance: "$12.00", readAt: iso(now),
      balanceTrend: { points: [{ at: iso(now), amount: 12 }] } },
  ];
}

function serve(lang, theme, quotas, colorblind = false) {
  const settings = { theme, lang, tray: "panel", quotaLeft: false, currency: "usd", colorblind };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ json: body });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"${theme}",web:true,colorblind:${colorblind}};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/usage/quotas") return json(quotas);
    if (url.pathname === "/api/usage/quotas/history") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

const words = {
  en: { head: "Balance over time", out: "Runs out in 3d at this pace", end: "Runs out", now: "Now", pace: "about ¥10.00 a day" },
  zh: { head: "余额走势", out: "按此速度，预计 3 天后用完", end: "预计用完", now: "现在", pace: "约每天 ¥10.00" },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    const w = words[lang];
    test(`${engine} ${lang}: a balance's card draws it over time and says when it runs out`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const pages = [];
      t.after(async () => {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          for (const [name, p] of pages) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-balance-curve-${name}.png`), fullPage: true });
        }
        await browser.close();
      });
      const errors = [];
      const open = async (name, theme, range) => {
        const page = await (await browser.newContext({ viewport: { width: 900, height: 520 }, reducedMotion: "reduce" })).newPage();
        pages.push([name, page]);
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(60000);
        page.on("pageerror", (e) => errors.push(e.message));
        if (range) await page.addInitScript((r) => localStorage.setItem("magpie.quotaRange", r), range);
        await page.route("**/*", serve(lang, theme, fixtures(Date.now())));
        await page.goto("http://magpie.test/?view=usage");
        return page;
      };

      for (const theme of ["light", "dark"]) {
        const page = await open(theme, theme);
        const card = page.locator(".subscription-card", { hasText: "DeepSeek" });
        const curve = card.locator(".balance-curve");
        await curve.waitFor();
        assert.equal(await curve.locator(".qc-title").textContent(), w.head);
        assert.equal(await curve.locator(".qc-range").textContent(), w.out);
        assert.equal(await curve.locator(".qv-sub").textContent(), w.pace);
        assert.equal(await curve.locator(".qc-legend, .qc-key").count(), 0, "no legend for one line");
        assert.equal(await curve.locator("path.qc-line").count(), 1);
        assert.equal(await curve.locator("line.qc-now").count(), 1, "now, with the dots carried past it");
        // carried on from the last reading to zero, at the plot's right edge
        const proj = curve.locator("path.qv-proj");
        assert.equal(await proj.count(), 1);
        const line = await curve.locator("path.qc-line").getAttribute("d");
        const [x1, y1, x2, y2] = (await proj.getAttribute("d")).match(/-?\d+(\.\d+)?/g).map(Number);
        assert.ok(line.endsWith(`${x1.toFixed(1)} ${y1.toFixed(1)}`), `from the last reading: ${line} / ${x1},${y1}`);
        assert.ok(Math.abs(x2 - 354) < 0.5 && Math.abs(y2 - 96) < 0.5, `to zero on the right: ${x2},${y2}`);
        assert.equal(await curve.locator("text.qv-proj-t").textContent(), w.end);
        assert.ok((await curve.locator(".qc-axis text").allTextContents()).includes(w.now));
        // each reading's figure on hover
        const tips = await curve.locator("rect.qv-hit title").allTextContents();
        assert.equal(tips.length, 7);
        assert.ok(tips.at(-1).endsWith("¥30.00") && tips[2].endsWith("¥50.00"), JSON.stringify(tips));
        assert.ok(await page.locator("#quotaHead #quotaTrend").isVisible(), "the range pick is there for balances alone too");
        assert.equal(await page.locator(".subscription-card", { hasText: "Moonshot" }).locator(".balance-curve").count(), 0, "one reading, no curve");
        assert.equal(await page.locator(".quota-curve select, .quota-curve button").count(), 0, "no control on the card");
        const left = await curve.evaluate((e) => [...e.querySelectorAll("*")].filter((x) => parseFloat(getComputedStyle(x).borderLeftWidth) > 0).length);
        assert.equal(left, 0, "no left borders");
        const stroke = await curve.locator("path.qc-line").evaluate((e) => getComputedStyle(e).stroke);
        const c1 = await page.evaluate(() => { const s = document.createElement("i"); s.style.color = "var(--c1)"; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; });
        assert.equal(stroke, c1, "the theme's chart colour");
        const box = await card.boundingBox(), pb = await curve.locator("svg.qv").boundingBox();
        assert.ok(pb.x >= box.x && pb.x + pb.width <= box.x + box.width + 0.5, "the plot fits its card");
      }

      // the allowances' Off takes the balance's curve away too
      const off = await open("off", "light", "off");
      await off.locator(".subscription-card", { hasText: "DeepSeek" }).locator(".quota-balance").waitFor();
      assert.equal(await off.locator(".balance-curve").count(), 0);
      assert.ok(await off.locator("#quotaHead #quotaTrend").isVisible(), "and can be turned on again");
      assert.deepEqual(errors, []);
    });
  }
}

// Colorblind mode (#2073) dashes the tray's quota lines by their place; the
// balance chart has one line, kept solid beside its dotted carry.
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine}: colorblind mode leaves the balance chart's solid line and dotted carry as they were`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const errors = [];
    const read = async (theme, colorblind) => {
      const page = await (await browser.newContext({ viewport: { width: 900, height: 520 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(60000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve("en", theme, fixtures(Date.now()), colorblind));
      await page.goto("http://magpie.test/?view=usage");
      const curve = page.locator(".subscription-card", { hasText: "DeepSeek" }).locator(".balance-curve");
      await curve.waitFor();
      const got = await curve.evaluate((c) => {
        const line = getComputedStyle(c.querySelector("path.qc-line")), fit = getComputedStyle(c.querySelector("path.qv-proj"));
        return { cb: document.documentElement.dataset.colorblind || "", line: line.strokeDasharray, stroke: line.stroke, fit: fit.strokeDasharray, fitStroke: fit.stroke,
          label: c.querySelector("svg.qv").getAttribute("aria-label") };
      });
      await page.context().close();
      return got;
    };
    for (const theme of ["light", "dark"]) {
      const plain = await read(theme, false), cb = await read(theme, true);
      assert.equal(cb.cb, "1");
      assert.equal(cb.line, "none", `the balance stays solid: ${JSON.stringify(cb)}`);
      assert.equal(cb.fit, plain.fit, "its carry keeps its dots");
      assert.notEqual(cb.fit, "none");
      assert.equal(cb.fitStroke, cb.stroke, `the carry is the line's colour: ${JSON.stringify(cb)}`);
      assert.equal(cb.label, plain.label, "it says the same to a screen reader");
    }
    assert.deepEqual(errors, []);
  });
}
