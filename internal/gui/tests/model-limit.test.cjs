// Global vendor-list cap: real settings input and model editor, mocked API only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { strings } = require("./strings.cjs");
const assets = path.resolve(__dirname, "../assets");
const { I18N } = strings();
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    test(`${engine} ${lang}: global default model limit`, async (t) => {
      const tr = (k) => lang === "en" ? k : I18N[lang][k];
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch());
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(5000);
      const errors = [], posts = [];
      page.on("pageerror", e => errors.push(e.message));
      let cur = { lang, theme: "light", tray: "panel", currency: "usd", textSize: 100, trayUsageEvery: 3,
        redactWords: [], workbuddyCheckins: [], visionModels: [], imageGenModels: [], lanURLs: [],
        version: "test", dir: "~/.config/magpie", gateway: "http://127.0.0.1:3425", fx: { rate: 7.2, at: new Date().toISOString() }, effectiveModelLimit: 24 };
      await page.route("**/*", async route => {
        const req = route.request(), url = new URL(req.url());
        const json = data => route.fulfill({ json: data });
        if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs={lang:"${lang}",theme:"light",web:true};` });
        if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
        if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: cur, fx: cur.fx });
        if (url.pathname === "/api/settings") {
          if (req.method() === "POST") { const body = req.postDataJSON(); posts.push(body); cur = { ...cur, ...body, effectiveModelLimit: body.defaultModelLimit ?? 24 }; }
          return json(cur);
        }
        if (url.pathname === "/api/providers") {
          const limit = cur.effectiveModelLimit;
          const models = Array.from({ length: 60 }, (_, i) => ({ id: `model-${String(i).padStart(2, "0")}`, name: `model-${String(i).padStart(2, "0")}`, on: !limit || i < limit }));
          return json({ providers: [{ id: "probe", name: "Limit probe", icon: "generic", host: "probe.example.invalid", chat: "http://127.0.0.1:1/v1", speaks: ["chat"], key: { set: true }, balanceToken: {}, keyList: [], models, modelListLimit: limit, chosen: [], agents: [], fallback: [], headers: {}, fetched: new Date().toISOString() }], presets: [], excluded: [], gateway: { running: true, window: true } });
        }
        if (url.pathname === "/api/plugins") return json({ plugins: [] });
        if (url.pathname === "/api/groups") return json({ groups: [] });
        if (url.pathname.startsWith("/api/")) return json({});
        const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
        return route.fulfill({ body: await fs.readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)] });
      });
      for (const value of ["", "48", "3", "0"]) {
        await page.goto("http://magpie.test/?view=settings&tab=models", { waitUntil: "networkidle" });
        const input = page.locator("#defaultModelLimitRow input");
        await input.waitFor();
        assert.equal(await input.getAttribute("aria-label"), tr("Default model limit"));
        if (value === "") {
          assert.equal(await page.locator("#replyList #defaultModelLimitRow").count(), 0);
          assert.equal(await page.locator("#modelListsList").evaluate(e => e.previousElementSibling.textContent.trim()), tr("Model lists"));
          for (const theme of ["light", "dark"]) {
            await page.evaluate(v => document.documentElement.dataset.theme = v, theme);
            for (const width of [390, 900]) {
              await page.setViewportSize({ width, height: 700 });
              await input.scrollIntoViewIfNeeded();
              const style = await input.evaluate(e => {
                const s = getComputedStyle(e), r = e.getBoundingClientRect();
                return { background: s.backgroundColor, color: s.color, radius: parseFloat(s.borderRadius), height: r.height, left: r.left, right: r.right, viewport: innerWidth };
              });
              assert(style.radius >= 6 && style.height >= 24, "uses the existing rounded settings field");
              assert(style.left >= 0 && style.right <= style.viewport, "field fits a narrow window");
              const channel = Number(style.background.match(/\d+/)[0]);
              assert(theme === "dark" ? channel < 80 : channel > 200, `${theme}: field follows the card palette: ${style.background}`);
              assert.notEqual(style.color, style.background, "text remains visible");
              if (process.env.SCREENSHOT_DIR && lang === "zh") {
                await fs.mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `model-limit-${engine}-${theme}-${width}.png`) });
              }
            }
          }
          await page.setViewportSize({ width: 900, height: 700 });
          await page.evaluate(() => document.documentElement.dataset.theme = "light");
        }
        if (value !== "") {
          const before = posts.length;
          const oldInput = await input.elementHandle();
          await input.fill(value); await input.press("Tab");
          await page.waitForFunction(e => !e.isConnected, oldInput);
          assert.equal(await input.inputValue(), value);
          assert(posts.length > before, "change saved");
          assert.equal(posts.at(-1).defaultModelLimit, Number(value));
        }
        await page.goto("http://magpie.test/?view=providers", { waitUntil: "networkidle" });
        await page.locator(".row.provider", { hasText: "Limit probe" }).click();
        const editor = page.locator("#modal:not([hidden]) .editor");
        await editor.locator(".mchips .mchip").first().waitFor();
        const want = value === "0" ? 60 : Number(value || 24);
        assert.equal(await editor.locator(".mchip.auto").count(), want);
        const list = editor.locator('[data-serves="list"]');
        assert((await list.getAttribute("title")).includes(value === "0" ? tr("Serve all the vendor's models (dashed), models it lists later too") : String(want)));
        await editor.locator('[data-serves="picked"]').click();
        assert.equal(await editor.locator(".mchip.on").count(), want, "Picked only seeds the effective vendor list");
      }
      await page.goto("http://magpie.test/?view=settings&tab=models", { waitUntil: "networkidle" });
      const input = page.locator("#defaultModelLimitRow input");
      const beforeInvalid = posts.length;
      // Assign atomically: WebKit's number spinner may clamp a synthetic fill
      // at min before Playwright reads it. The real onchange still runs.
      for (const bad of ["-1", "1.5"]) {
        const valid = await input.evaluate((e, value) => {
          e.value = value;
          e.dispatchEvent(new Event("change", { bubbles: true }));
          return e.checkValidity();
        }, bad);
        assert.equal(valid, false, bad);
      }
      assert.equal(posts.length, beforeInvalid, "invalid inputs are not saved");
      const oldInput = await input.elementHandle();
      await input.fill(""); await input.press("Tab");
      await page.waitForFunction(e => !e.isConnected, oldInput);
      assert.equal(posts.at(-1).defaultModelLimit, null, "blank restores the legacy default");
      assert.deepEqual(errors, []);
    });
  }
}
