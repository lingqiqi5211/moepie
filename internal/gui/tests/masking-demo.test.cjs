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
      // The stage, step by step: what each side shows (innerText leaves out
      // the cards and token faces turned away), and the steps' three states.
      const said = (sel) => page.locator(sel).innerText();
      const steps = () => page.locator(".mf-step").evaluateAll((items) => items.map((n) => n.classList.contains("mf-current") ? "current" : n.classList.contains("mf-done") ? "done" : "next"));
      const VALUES = /demo@ex\.test|hello demo/;
      const seen = [];
      for (let i = 0; i < 5; i++) {
        await page.locator(".mf-node").nth(i).click();
        assert.deepEqual(await steps(), ["done", "done", "done", "done", "done"].map((s, j) => j < i ? s : j === i ? "current" : "next"));
        const here = await said(".mf-local .mf-slot"), there = await said(".mf-remote .mf-slot"), table = await said(".mf-table");
        seen.push([here, there]);
        // Values never reach the model's side, not even in a face turned away.
        assert.doesNotMatch(await page.locator(".mf-remote").evaluate((n) => n.textContent), VALUES);
        assert.equal(await page.locator(".mf-local .mf-table").count(), 1, "the mapping table stays on this computer");
        assert.equal(await page.locator(".mf-wire.mf-out").count(), i === 2 ? 1 : 0);
        assert.equal(await page.locator(".mf-wire.mf-back").count(), i === 3 ? 1 : 0);
        if (i === 0) {
          assert.match(here, /demo@ex\.test[\s\S]*hello demo/);
          assert.doesNotMatch(here, /\{\{/);
          assert.doesNotMatch(table, /↔/);
          assert.doesNotMatch(there, /\{\{/);
        }
        if (i === 1) {
          assert.match(here, /\{\{EMAIL_1\}\}[\s\S]*\{\{SECRET_1\}\}/);
          assert.doesNotMatch(here, VALUES);
          assert.match(table, /\{\{EMAIL_1\}\}[\s\S]*↔[\s\S]*demo@ex\.test/);
          assert.match(table, /\{\{SECRET_1\}\}[\s\S]*↔[\s\S]*hello demo/);
        }
        if (i === 2) assert.match(there, /\{\{EMAIL_1\}\}[\s\S]*\{\{SECRET_1\}\}/);
        if (i === 3) {
          // The reply is not the request: a sentence naming a placeholder.
          assert.match(there, /\{\{EMAIL_1\}\}/);
          assert.match(here, /\{\{EMAIL_1\}\}/);
          assert.doesNotMatch(here, VALUES);
          assert.notEqual(here, seen[2][0]);
          assert.notEqual(there, seen[2][1]);
        }
        if (i === 4) {
          assert.match(here, /demo@ex\.test/);
          assert.doesNotMatch(here, /\{\{/);
          assert.match(there, /\{\{EMAIL_1\}\}/);
        }
      }
      await page.locator(".mf-control").nth(1).click();
      // Every part stays visible in both themes without scaling text, on the
      // request and on the reply.
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        for (const i of [0, 3]) {
          await page.locator(".mf-node").nth(i).click();
          assert.deepEqual(await page.locator(".mask-flow").evaluate((flow) => {
            return [...flow.querySelectorAll(".mf-step, .mf-node, .mf-caption, .mf-zone, .mf-msg, .mf-table, .mf-face, .mf-wlabel, .mf-control")].flatMap((n) => {
              const r = n.getBoundingClientRect(), style = getComputedStyle(n);
              return r.right > innerWidth + 1 || r.left < 0 || n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1 || parseFloat(style.fontSize) < 12 ? [n.className] : [];
            });
          }), []);
        }
        await page.locator(".mf-control").nth(1).click();
        if (process.env.MASK_SHOTS) {
          await fs.mkdir(process.env.MASK_SHOTS, { recursive: true });
          await page.locator("#maskDemo").screenshot({ path: path.join(process.env.MASK_SHOTS, `flow-${engine}-${lang}-${width}-${theme}.png`) });
          // The narrow page scrolls vertically; capture the steps and each stage in view.
          if (width === 390 && lang === "zh") {
            // The shell preserves reader position; use trusted wheel input to scroll.
            const capture = async (target, name) => {
              const box = await target.boundingBox();
              await page.mouse.move(200, 600);
              await page.mouse.wheel(0, box.y + box.height / 2 - 550);
              await page.waitForTimeout(150);
              await target.screenshot({ path: path.join(process.env.MASK_SHOTS, `flow-${engine}-zh-390-${theme}-${name}.png`) });
            };
            await capture(page.locator(".mf-steps"), "steps");
            for (let i = 0; i < 5; i++) {
              await page.locator(".mf-node").nth(i).click();
              await capture(page.locator(".mf-stage"), `step${i + 1}`);
            }
            await capture(page.locator(".mf-controls"), "controls");
            await page.locator(".mf-control").nth(1).click();
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
  for (const width of [390, 1100]) test(`${engine} ${width}: tokens turn over, packets cross and the bar fills with transform and opacity only`, async (t) => {
    const { browser, page, errors } = await open(engine, "en", width, { motion: true, boot: { noVideo: true } });
    t.after(() => browser.close());
    await page.locator("#mdRow").click();
    await page.waitForFunction(() => document.querySelector(".mask-flow").__state().timer);
    // The current step's bar fills over the timer's own wait, and stops with it.
    const bar = () => page.evaluate(() => document.querySelector(".mf-current .mf-bar i").getAnimations().map((a) => [a.animationName, a.effect.getTiming().duration]));
    assert.deepEqual(await bar(), [[width < 760 ? "mf-fill-y" : "mf-fill", 2200]]);
    await page.locator(".mf-control").first().click();
    assert.equal((await state(page)).timer, false);
    assert.deepEqual(await bar(), []);
    // What moves: every keyframe animates transform or opacity, and the
    // cards, faces, rows and packet transition nothing else.
    const motion = () => page.evaluate(() => {
      const flow = document.querySelector(".mask-flow"), bad = [];
      for (const a of flow.getAnimations({ subtree: true })) {
        if (!a.animationName) continue;
        for (const frame of a.effect.getKeyframes()) for (const k of Object.keys(frame)) if (!["offset", "computedOffset", "easing", "composite", "transform", "opacity"].includes(k)) bad.push(`${a.animationName} ${k}`);
      }
      for (const n of flow.querySelectorAll(".mf-msg, .mf-empty, .mf-face, .mf-row, .mf-dir, .mf-bar i")) {
        for (const p of getComputedStyle(n).transitionProperty.split(", ")) if (!["opacity", "transform", "visibility", "none"].includes(p)) bad.push(`${n.className} ${p}`);
      }
      return { names: flow.getAnimations({ subtree: true }).filter((a) => a.animationName).map((a) => a.animationName), bad };
    });
    const face = (sel) => page.locator(sel).first().evaluate((n) => getComputedStyle(n).visibility);
    await page.locator(".mf-node").nth(1).click();
    let now = await motion();
    assert.deepEqual(now.bad, []);
    assert(now.names.includes("mf-hit"), "the mapping table lights up as it is written");
    // A placeholder turns up where its value was, after the value turns away.
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".mf-local .mf-req .mf-val")).visibility === "hidden");
    assert.equal(await face(".mf-local .mf-req .mf-ph"), "visible");
    await page.locator(".mf-node").nth(2).click();
    now = await motion();
    assert.deepEqual(now.bad, []);
    assert(now.names.includes(width < 760 ? "mf-out-y" : "mf-out"), "a packet crosses to the model");
    await page.locator(".mf-node").nth(3).click();
    now = await motion();
    assert(now.names.includes(width < 760 ? "mf-back-y" : "mf-back"), "a packet crosses back");
    await page.locator(".mf-node").nth(4).click();
    now = await motion();
    assert.deepEqual(now.bad, []);
    assert(now.names.includes("mf-hit"), "the mapping table lights up as it is read");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".mf-local .mf-rep")).visibility === "visible" && getComputedStyle(document.querySelector(".mf-local .mf-rep .mf-ph")).visibility === "hidden");
    assert.equal(await face(".mf-local .mf-rep .mf-val"), "visible");
    // Reduced motion: the states switch, nothing moves.
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const i of [1, 2, 3, 4, 0]) {
      await page.locator(".mf-node").nth(i).click();
      assert.deepEqual(await page.evaluate(() => document.querySelector(".mask-flow").getAnimations({ subtree: true }).length), 0);
    }
    await page.locator(".mf-control").first().click();
    assert.equal((await state(page)).timer, true);
    assert.deepEqual(await bar(), []);
    assert.equal(await page.locator(".mf-local .mf-req .mf-val").first().evaluate((n) => getComputedStyle(n).transitionDuration), "0s");
    assert.deepEqual(errors, []);
  });
}
