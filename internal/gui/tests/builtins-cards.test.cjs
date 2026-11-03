// Run with Node's test runner and Playwright on the module path; see README.md.
// Plugins › Built-in as cards in groups: the API's group puts each plugin
// under Pages, Gateway features or Integrations and automation (one of none
// under Other), in its order there, a card each in a grid as wide as fits. A card in use says
// why and its switch is on and can't be moved; one with settings has them
// behind a Settings button that says whether they are open; a page's
// switched off leaves the sidebar (feature-off as ever), its switch busy
// while it saves; All, On and Off pick which show, and a card they then
// leave out hands its focus to the next in its group that can be
// switched, or the one before, or the list. One column at 420 with nothing sideways, in light and
// dark, the cards on the theme's own card colour. No backend, the API is
// faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

const PLUGINS = [
  { id: "budget", group: "gateway", order: 4, name: "Key limits", sub: "Hold each gateway key to the tokens or estimated cost you set for it", where: ["Models › Gateway"] },
  { id: "gateway", group: "pages", order: 4, name: "Gateway page", sub: "The gateway's state, keys and settings, how to connect a client and its models", where: ["Models › Gateway"], parts: [{ slot: "nav.page", key: "gateway" }] },
  { id: "groups", group: "gateway", order: 3, name: "Routing groups", sub: "Several models agents pick as one: each request goes to the right one, and to the next when one fails", where: ["Models › Routing"], inUse: 2, use: "{n} groups in use" },
  { id: "otel", group: "integrations", order: 1, name: "Observability", sub: "Send each request's traces and metrics to an OpenTelemetry collector, such as Langfuse", where: ["Settings › Observability"], schema: true },
  { id: "redact", group: "gateway", order: 1, name: "Privacy masking", sub: "Secrets, personal data and your own words go to vendors as placeholders, and come back as they were", where: ["Insights › Masking", "Settings › Privacy"] },
  { id: "sessions", group: "pages", order: 1, name: "Sessions", sub: "Your agents' past conversations: read, search, resume and export them", where: ["Work › Sessions"], parts: [{ slot: "nav.page", key: "sessions" }] },
  { id: "warmups", group: "integrations", order: 2, name: "Warm-up and check-in", sub: "Start a subscription's usage window at a time you pick, and claim vendors' daily check-in credits", where: ["Settings › Allowances"], off: true },
  // a plugin of no group the page knows is listed, under Other
  { id: "stray", group: "", name: "Stray", sub: "A plugin of no group" },
];
const SCHEMA = { type: "object", properties: { endpoint: { type: "string", title: "Collector address", default: "" } }, "x-order": ["endpoint"] };

function server(theme, posts) {
  const on = Object.fromEntries(PLUGINS.map((p) => [p.id, !p.off]));
  const config = { endpoint: "http://127.0.0.1:4318" };
  const list = () => PLUGINS.map((p) => {
    const f = { id: p.id, name: p.name, sub: p.sub, group: p.group, order: p.order, where: p.where, parts: p.parts, on: on[p.id] || !!p.inUse, chosen: on[p.id], source: "preset", inUse: p.inUse || 0, use: p.use };
    f.state = f.on ? "active" : "off";
    if (p.schema) Object.assign(f, { schema: SCHEMA, config });
    return f;
  });
  const cur = () => ({ theme, lang: "en", tray: "panel", currency: "usd", textSize: 100, redactWords: [], version: "0.1.400", dir: "/config/home/.config/magpie", gateway: "http://127.0.0.1:3999", proxyNow: "none", proxySource: "none", lanURLs: [], builtins: list() });
  return async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") {
      const off = list().filter((f) => !f.on).map((f) => f.id);
      return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"en",theme:${JSON.stringify(theme)},featuresOff:${JSON.stringify(off)}};` });
    }
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: cur() });
    if (url.pathname === "/api/settings") return json(cur());
    if (url.pathname === "/api/plugins/builtin") {
      if (req.method() !== "POST") return json(list());
      const b = req.postDataJSON();
      posts.push(b);
      await new Promise((r) => setTimeout(r, 150)); // long enough to be seen saving
      if (b.config) Object.assign(config, b.config);
      else on[b.id] = b.on;
      return json(list());
    }
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true }, plugins: [] });
    if (url.pathname === "/api/plugins") return json({ bun: true, bunVersion: "1.4.2", plugins: [], picker: false, movable: [] });
    if (url.pathname === "/api/window/fit") return route.fulfill({ status: 204 });
    if (url.pathname.startsWith("/api/")) return json({});
    if (url.host !== "magpie.test") return route.fulfill({ status: 404, body: "" });
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

const card = (page, id) => page.locator(`#builtinList .feat-row[data-id="${id}"]`);
const groupsOf = (page) => page.evaluate(() => [...document.querySelectorAll("#builtinList .feat-group")].map((g) => [g.dataset.group, document.getElementById(g.getAttribute("aria-labelledby")).textContent, [...g.querySelectorAll(".feat-row")].map((r) => r.dataset.id)]));
// a colour's lightness, 0 to 1
const light = (c) => { const [r, g, b] = c.match(/[\d.]+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine}: Plugins › Built-in, cards in groups`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const cardBg = {};
    for (const theme of ["light", "dark"]) for (const width of [1280, 420]) {
      const where = `${engine} ${theme} ${width}`;
      const context = await browser.newContext({ viewport: { width, height: 760 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [], posts = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => localStorage.setItem("magpie.pluginTab", "builtin"));
      await page.route("**/*", server(theme, posts));
      await page.goto("http://magpie.test/?view=plugins");
      await card(page, "stray").waitFor();

      // the groups and their cards, as the API says them
      assert.deepEqual(await groupsOf(page), [
        ["pages", "Pages", ["sessions", "gateway"]],
        ["gateway", "Gateway features", ["redact", "groups", "budget"]],
        ["integrations", "Integrations and automation", ["otel", "warmups"]],
        ["other", "Other", ["stray"]],
      ], where);
      assert.equal(await card(page, "redact").locator(".feat-where").textContent(), "Insights › Masking · Settings › Privacy", where);
      assert.equal(await card(page, "stray").locator(".feat-where").count(), 0, `${where}: nowhere said`);
      // a page's card has its sidebar icon
      assert.equal(await card(page, "sessions").locator(".feat-ic svg path, .feat-ic svg g").count() > 0, true, where);

      // in use: on, can't be moved, saying why
      const locked = card(page, "groups"), lsw = locked.locator('[role="switch"]');
      assert.deepEqual([await lsw.getAttribute("aria-checked"), await lsw.isDisabled()], ["true", true], `${where}: locked`);
      assert.equal(await locked.locator(".feat-why").textContent(), "2 groups in use", where);
      assert.ok(await locked.locator(".feat-lock").isVisible(), `${where}: the lock says so`);
      assert.equal(await lsw.getAttribute("aria-describedby"), await locked.locator(".feat-lock").getAttribute("id"), `${where}: the switch is described by it`);
      assert.equal(await lsw.getAttribute("aria-label"), "Routing groups", where);
      assert.equal(await card(page, "budget").locator(".feat-lock").count(), 0, `${where}: one not in use has no lock`);

      // settings behind a button that says whether they are open
      const gear = card(page, "otel").locator("button.feat-gear"), sets = card(page, "otel").locator(".feat-sets");
      assert.equal(await gear.getAttribute("aria-expanded"), "false", where);
      assert.equal(await gear.getAttribute("aria-controls"), await sets.getAttribute("id"), where);
      assert.ok(await sets.isHidden(), `${where}: folded`);
      await gear.click();
      assert.equal(await gear.getAttribute("aria-expanded"), "true", where);
      const field = sets.locator('[data-setting="endpoint"] input');
      assert.equal(await field.inputValue(), "http://127.0.0.1:4318", where);
      await field.fill("http://collector:4318");
      await field.press("Tab");
      await page.waitForFunction(() => document.querySelector('#builtinList [data-id="otel"] [data-setting="endpoint"] input')?.value === "http://collector:4318");
      assert.deepEqual(posts.at(-1), { id: "otel", config: { endpoint: "http://collector:4318" } }, `${where}: saved`);
      assert.equal(await gear.getAttribute("aria-expanded"), "true", `${where}: open, drawn again`);
      await gear.click();
      assert.ok(await sets.isHidden(), `${where}: folded again`);
      // none for one off
      assert.equal(await card(page, "warmups").locator(".feat-gear").count(), 0, where);

      // nothing sideways, and one column at 420
      const fits = () => page.evaluate(() => { const v = document.getElementById("view-plugins"); return v.scrollWidth <= v.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; });
      assert.ok(await fits(), `${where}: fits`);
      const lefts = await page.evaluate(() => new Set([...document.querySelectorAll("#builtinList .feat-row")].map((r) => Math.round(r.getBoundingClientRect().left))).size);
      if (width === 420) assert.equal(lefts, 1, `${where}: one column`);
      else assert.ok(lefts > 1, `${where}: side by side`);

      // the theme's card colour
      const bg = await card(page, "budget").evaluate((c) => { const p = document.createElement("div"); p.style.background = "var(--card)"; document.body.append(p); const want = getComputedStyle(p).backgroundColor; p.remove(); return [getComputedStyle(c).backgroundColor, want]; });
      assert.equal(bg[0], bg[1], `${where}: --card`);
      cardBg[theme] = light(bg[0]);

      // Sessions switched off: its card says so, and its page leaves the sidebar
      if (width === 1280) assert.ok(await page.locator('#nav button[data-view="sessions"]').isVisible(), `${where}: Sessions there`);
      const ssw = card(page, "sessions").locator('[role="switch"]');
      await ssw.click();
      const busy = await page.waitForFunction(() => { const b = document.querySelector('#builtinList [data-id="sessions"] [role="switch"][aria-busy="true"]'); return b && getComputedStyle(b).opacity; });
      assert.equal(await busy.jsonValue(), "0.6", `${where}: seen saving`);
      await page.waitForSelector('#builtinList .feat-row.off[data-id="sessions"] [aria-checked="false"]');
      assert.deepEqual(posts.at(-1), { id: "sessions", on: false }, where);
      assert.ok(await page.locator('#nav button[data-view="sessions"]').isHidden(), `${where}: Sessions gone`);
      assert.ok(await page.evaluate(() => document.activeElement?.closest('.feat-row')?.dataset.id === "sessions"), `${where}: the focus kept on its switch`);

      // only those off, only those on, and all
      const shows = page.locator("#view-plugins .pm-shows .opt");
      await shows.nth(2).click();
      assert.deepEqual((await groupsOf(page)).map(([g, , ids]) => [g, ids]), [["pages", ["sessions"]], ["integrations", ["warmups"]]], `${where}: Off`);
      await shows.nth(1).click();
      assert.deepEqual((await groupsOf(page)).flatMap(([, , ids]) => ids), ["gateway", "redact", "groups", "budget", "otel", "stray"], `${where}: On`);
      await shows.nth(0).click();
      assert.equal((await groupsOf(page)).length, 4, `${where}: All`);

      // switched out of the filter: its focus to the next that can be
      // switched in its group (Routing groups is in use), or the one before,
      // or the list
      const focused = () => page.evaluate(() => document.activeElement?.closest(".feat-row")?.dataset.id || document.activeElement?.id);
      const flip = async (id, want) => {
        await card(page, id).locator('[role="switch"]').click();
        await card(page, id).waitFor({ state: "detached" });
        await page.waitForFunction((w) => (document.activeElement?.closest(".feat-row")?.dataset.id || document.activeElement?.id) === w, want).catch(() => {});
        assert.equal(await focused(), want, `${where}: ${id} gone, the focus to ${want}`);
      };
      await shows.nth(1).click();
      await flip("budget", "redact");
      await flip("redact", "builtinList");
      assert.equal(await page.locator("#builtinList").getAttribute("tabindex"), "-1", where);
      await shows.nth(2).click();
      await flip("redact", "budget");
      await shows.nth(0).click();
      assert.ok(await fits(), `${where}: still fits`);
      assert.deepEqual(errors, [], where);
      await context.close();
    }
    assert.ok(cardBg.light > 0.8 && cardBg.dark < 0.25, `cards light and dark: ${JSON.stringify(cardBg)}`);
  });
}
