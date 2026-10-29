// Run with Node's test runner and Playwright on the module path; see README.md.
// What is loading pulses, and nothing else moves: the bird that hopped over
// a slow page's skeletons, a frame of script each, is gone (10-30), and
// the bars' sheen, painted again each frame, is an opacity pulse. With
// reduced motion the bars stand still.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const listings = [{ package: "opencode-copilot-auth", name: "GitHub Copilot", icon: "githubcopilot", providers: ["github-copilot"],
  summary: { en: "Your GitHub Copilot plan." }, npm: { version: "0.0.9", weekly: 48213, publisher: "thdxr" } }];

function server(market) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"en",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang: "en", theme: "light" } });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true }, plugins: [] });
    if (url.pathname === "/api/groups") return json({ groups: [], pools: [] });
    const state = { bun: true, bunVersion: "1.3.0", plugins: [] };
    if (url.pathname === "/api/plugins/market") { await market(); return json({ listings, state }); }
    if (url.pathname === "/api/plugins") return json(state);
    if (url.pathname === "/api/plugins/listings") { await market(); return json({ listings }); }
    if (url.pathname.startsWith("/api/")) return json({});
    if (!/^\/[\w./-]*$/.test(url.pathname) || url.host !== "magpie.test") return route.fulfill({ status: 404, body: "" });
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

async function open(browser, reduced, market) {
  const page = await (await browser.newContext({ viewport: { width: 980, height: 820 }, reducedMotion: reduced ? "reduce" : "no-preference" })).newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    // every bird that came
    window.seen = { birds: 0 };
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("sk-bird")) seen.birds++; })
      .observe(document, { childList: true, subtree: true });
  });
  await page.route("**/*", server(market));
  await page.goto("http://magpie.test/?view=plugins");
  return { page, errors };
}

// what the bars' animations change, each named once
const moving = (page) => page.evaluate(() => [...new Set(document.getAnimations()
  .filter((a) => a.effect?.target?.matches?.(".skeleton, .pm-card.ghost .sk"))
  .flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p)))))].sort());

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  const launch = () => (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));

  test(engine + ": a slow page's skeletons pulse, and no bird comes", async (t) => {
    const browser = await launch();
    t.after(() => browser.close());
    let release;
    const held = new Promise((r) => { release = r; });
    const { page, errors } = await open(browser, false, () => held);
    await page.locator("#view-plugins .pm-card.ghost").first().waitFor();
    await page.waitForTimeout(1200);
    assert.deepEqual(await moving(page), ["opacity"]);
    assert.equal(await page.evaluate(() => seen.birds), 0, "no bird came");
    release();
    await page.waitForFunction(() => !document.querySelector("#view-plugins .pm-card.ghost"));
    assert.deepEqual(errors, []);
  });

  test(engine + ": with reduced motion no bar moves", async (t) => {
    const browser = await launch();
    t.after(() => browser.close());
    let release;
    const held = new Promise((r) => { release = r; });
    const { page, errors } = await open(browser, true, () => held);
    await page.locator("#view-plugins .pm-card.ghost").first().waitFor();
    await page.waitForTimeout(600);
    assert.deepEqual(await moving(page), []);
    release();
    await page.waitForFunction(() => !document.querySelector("#view-plugins .pm-card.ghost"));
    assert.deepEqual(errors, []);
  });
}
