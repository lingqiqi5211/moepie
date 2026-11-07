// Run with Node's test runner and Playwright on the module path; see README.md.
// A subscription's windows side by side have their bars at one height when
// one's name wraps and the other's doesn't. The windows were a subgrid of
// three rows of their grid once, the layout that crashed Safari 16's WebKit
// sizing it (#3731, #3955); now each window is a grid of its own and its
// names are as tall as the tallest beside them. No rule of the windows says
// subgrid, and at each width, in both engines and every language, the bars
// of each row of windows start at one y, the names of a window too
// short to wrap still sit above its bar, and a reset line is as far under
// its bar as the subgrid put it. MAGPIE_QUOTA_ASSETS points the
// page at an older asset tree, to watch this go red there.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, process.env.MAGPIE_QUOTA_ASSETS || "../assets");
const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
const later = new Date(Date.now() + 4 * 86400e3).toISOString();
const quotas = [{
  provider: "zcode", name: "ZCode", icon: "zcode", plan: "Pro", user: "a",
  windows: [
    { name: "ZCode 1024 Dev Day · GLM-5.3 and every model it counts", used: 42, resetsAt: soon },
    { name: "5h", used: 12, resetsAt: soon },
    { name: "Week", used: 60, resetsAt: later },
    { name: "Month", used: 7 },
  ],
}];
// a second account of the provider: drawn folded, its pools as small rings
quotas.push({ ...quotas[0], user: "b" });

function serve(lang, quotas) {
  const settings = { lang, theme: "light", quotaLeft: true, currency: "usd" };
  const state = { agents: [], profiles: [], settings };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/gateway/trace") return url.searchParams.get("wait") ? new Promise(() => {}) : json({ mine: true, now: new Date().toISOString(), seq: 0, totals: {}, routes: [] });
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json({ models: [], groups: [], pools: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname === "/api/usage/quotas") return json(quotas);
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await r.fulfill({ body: await fs.readFile(file), contentType }); } catch { await r.fulfill({ status: 404, body: "" }); }
  };
}

test("no rule of the windows says subgrid", async () => {
  const css = await fs.readFile(path.join(assets, "app.css"), "utf8");
  const bad = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\.quota(-windows)?\b/.test(m[1]) && /subgrid/.test(m[2])) bad.push(m[1].trim());
  }
  assert.deepEqual(bad, []);
});

// a folded account's rings: each pool's small dial and its figures in the
// card (an opened account keeps the source's bars)
const ringsOf = (page) => page.evaluate(() => [...document.querySelectorAll(".subscription-card .rg-sm")].map((r) => {
  const card = r.closest(".subscription-card").getBoundingClientRect(), b = r.getBoundingClientRect();
  const d = r.querySelector(".rg-dial")?.getBoundingClientRect();
  const lines = [...r.querySelectorAll(".rg-name, .rg-part")].map((l) => {
    const lb = l.getBoundingClientRect();
    return { text: l.textContent, right: card.right - lb.right, left: lb.left - card.left, cut: l.scrollWidth > l.clientWidth + 1 };
  });
  return { inside: b.left >= card.left - 1 && b.right <= card.right + 1, square: d ? Math.abs(d.width - d.height) < 0.5 : true, size: d ? Math.round(d.width) : 0, lines };
}));

// the frames a resize takes: the windows' observer, then the frame it
// fits them in (quotaFit)
const frames = (page) => page.evaluate(() => new Promise((r) => { let n = 4; const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }));

// one ring a pool, its dial a circle inside the card at every width, the
// windows' lines whole: a long name wraps, it is never cut
async function ringsFit(page) {
  await frames(page);
  const rs = await ringsOf(page);
  assert.ok(rs.length > 0, "no ring was drawn");
  for (const r of rs) {
    assert.ok(r.inside, `a ring past the card: ${JSON.stringify(r)}`);
    assert.ok(r.square, `a dial not a circle: ${JSON.stringify(r)}`);
    for (const l of r.lines) {
      assert.ok(l.left >= -1 && l.right >= -1, `"${l.text}" runs past the card (${l.left}, ${l.right})`);
      assert.equal(l.cut, false, `"${l.text}" is cut`);
    }
  }
  return rs;
}

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    test(`${name} ${lang}: one ring a pool, its dial a circle, its lines whole`, async () => {
      const browser = await engine.launch();
      try {
        const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" })).newPage();
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(60000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, quotas));
        await page.goto("http://magpie.test/?view=usage");
        await page.locator(".subscription-card .rg-dial").nth(1).waitFor();
        let sizes = [];
        for (const width of [1100, 700, 390, 1100]) {
          await page.setViewportSize({ width, height: 900 });
          const rs = await ringsFit(page);
          sizes.push(...new Set(rs.map((r) => r.size)));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, `${width}px: the page scrolls sideways`);
        }
        assert.ok(sizes.length > 0, "a dial's size was read");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
}
