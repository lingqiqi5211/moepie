// Real app + local API fixtures in Chromium and WebKit, all five languages.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { open, state, K } = require("./masking-demo-helper.cjs");
const engines = process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"];
const labels = {
  en: ["Original request", "Replace locally", "Send masked request", "Receive the reply", "Restore locally"],
  zh: ["原始请求", "本机替换", "发给模型", "收到回复", "本机还原"],
  "zh-TW": ["原始請求", "本機替換", "傳給模型", "收到回覆", "本機還原"],
  ja: ["元のリクエスト", "ローカルで置換", "モデルに送信", "応答を受信", "ローカルで復元"],
  de: ["Ursprüngliche Anfrage", "Lokal ersetzen", "An das Modell senden", "Antwort empfangen", "Lokal wiederherstellen"],
};
for (const engine of engines) {
  for (const lang of Object.keys(labels)) for (const width of [390, 1100]) {
    test(`${engine} ${lang} ${width}: readable five-step flow, folding, keyboard and themes`, async (t) => {
      const { browser, page, errors, fetched } = await open(engine, lang, width);
      t.after(() => browser.close());
      assert.equal(await page.locator("#mdRow").getAttribute("aria-expanded"), "false");
      assert(await page.locator("#mdBody").isHidden());
      assert.equal(await page.locator("#mdRow .md-thumb, #mdRow .md-len").count(), 0);
      await page.locator("#mdRow").click();
      await page.locator(".mask-flow").waitFor();
      assert.deepEqual(await page.locator(".mf-title").allTextContents(), labels[lang]);
      assert.deepEqual(await state(page), { step: 0, playing: false, timer: false });
      assert.equal(await page.locator(".mf-example").count(), 5);
      assert.match(await page.locator(".mf-example").nth(0).innerText(), /demo@ex.test/);
      assert.match(await page.locator(".mf-example").nth(1).innerText(), /↔/);
      assert(!/demo@ex.test|hello demo/.test(await page.locator(".mf-example").nth(2).innerText()));
      assert.match(await page.locator(".mf-example").nth(4).innerText(), /demo@ex.test/);
      // Every node and example stays visible in both themes without scaling text.
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        assert.deepEqual(await page.locator(".mask-flow").evaluate((flow) => {
          return [...flow.querySelectorAll(".mf-step, .mf-example, .mf-node, .mf-control")].flatMap((n) => {
            const r = n.getBoundingClientRect(), style = getComputedStyle(n);
            return r.right > innerWidth + 1 || r.left < 0 || n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1 || parseFloat(style.fontSize) < 12 ? [n.className] : [];
          });
        }), []);
        if (process.env.MASK_SHOTS) {
          await fs.mkdir(process.env.MASK_SHOTS, { recursive: true });
          await page.locator("#maskDemo").screenshot({ path: path.join(process.env.MASK_SHOTS, `flow-${engine}-${lang}-${width}-${theme}.png`) });
          // The narrow page scrolls vertically; capture each complete node in view.
          if (width === 390 && lang === "zh") {
            // The shell preserves reader position; use trusted wheel input to scroll.
            const capture = async (target, name) => {
              const box = await target.boundingBox();
              await page.mouse.move(200, 600);
              await page.mouse.wheel(0, box.y + box.height / 2 - 550);
              await page.waitForTimeout(150);
              await target.screenshot({ path: path.join(process.env.MASK_SHOTS, `flow-${engine}-zh-390-${theme}-${name}.png`) });
            };
            for (let i = 0; i < 5; i++) await capture(page.locator(".mf-step").nth(i), `step${i + 1}`);
            await capture(page.locator(".mf-controls"), "controls");
            await page.mouse.wheel(0, -10000);
            await page.waitForTimeout(150);
          }
        }
      }
      for (let i = 0; i < 5; i++) {
        await page.locator(".mf-node").nth(i).focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator(".mf-node").nth(i).getAttribute("aria-current"), "step");
        assert.equal((await state(page)).timer, false);
      }
      await page.locator(".mf-control").nth(1).click();
      assert.deepEqual(await state(page), { step: 0, playing: false, timer: false });
      // Changing language updates dynamic controls and status, too.
      await page.evaluate(() => { setLocale("de"); });
      assert.equal(await page.locator(".mf-control").first().innerText(), "Ablauf abspielen");
      assert.match(await page.locator(".mf-status").innerText(), /Ursprüngliche Anfrage/);
      await page.locator("#mdRow").click();
      assert(await page.locator("#mdBody").isHidden());
      await page.locator("#mdRow").click();
      assert.equal((await state(page)).step, 0);
      assert.equal(await page.locator("#maskDemo video, #maskDemo img").count(), 0);
      assert.deepEqual(fetched, [], "the flow fetched a character asset");
      assert.deepEqual(errors, []);
    });
  }
  test(`${engine}: playback, pause, fold, hidden page/request, removal and reduced motion`, async (t) => {
    const { browser, page, errors } = await open(engine, "en", 1100, { motion: true, boot: { noVideo: true } });
    t.after(() => browser.close());
    await page.clock.install();
    await page.locator("#mdRow").click();
    await page.waitForFunction(() => document.querySelector(".mask-flow").__state().timer);
    await page.clock.runFor(2300);
    assert.equal((await state(page)).step, 1);
    await page.locator(".mf-control").first().click();
    assert.equal((await state(page)).timer, false);
    await page.clock.runFor(5000);
    assert.equal((await state(page)).step, 1);
    await page.locator(".mf-control").first().click();
    await page.locator("#mdRow").click();
    assert.equal((await state(page)).timer, false);
    await page.clock.runFor(5000);
    assert.equal((await state(page)).step, 1);
    await page.locator("#mdRow").click();
    await page.waitForFunction(() => document.querySelector(".mask-flow").__state().timer);
    await page.evaluate((k) => maskOneOpen(k), K);
    await page.waitForFunction(() => !document.querySelector(".mask-flow").__state().timer);
    await page.clock.runFor(5000);
    assert.equal((await state(page)).step, 1);
    await page.evaluate(() => maskOneClose());
    await page.waitForFunction(() => document.querySelector(".mask-flow").__state().timer);
    // The tab visibility event is dispatched by the browser in real use.
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
    assert.equal((await state(page)).timer, false);
    await page.clock.runFor(5000);
    assert.equal((await state(page)).step, 1);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
    await page.clock.runFor(10000);
    assert.deepEqual(await state(page), { step: 4, playing: false, timer: false });
    await page.locator(".mf-control").nth(1).click();
    await page.waitForFunction(() => document.querySelector(".mask-flow").__state().timer);
    assert.equal((await state(page)).step, 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => !document.querySelector(".mask-flow").__state().playing);
    assert.equal((await state(page)).timer, false);
    await page.locator(".mf-node").last().click();
    assert.equal((await state(page)).step, 4);
    await page.locator(".mf-control").nth(1).click();
    assert.deepEqual(await state(page), { step: 0, playing: false, timer: false });
    // Removed UI drops its owned timer and observers even while folded.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(".mf-control").first().click();
    await page.evaluate(() => { window.removedFlow = document.querySelector(".mask-flow"); removedFlow.remove(); });
    assert.equal(await page.evaluate(() => removedFlow.__state().timer), false);
    assert.deepEqual(errors, []);
  });
}
