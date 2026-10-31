// Fixed fictional examples stay readable under Hide accounts, while real
// surrounding text remains protected. Both engines, all five languages.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { open } = require("./masking-demo-helper.cjs");
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    test(`${engine} ${lang}: Hide accounts preserves fictional flow examples`, async (t) => {
      const { browser, page, errors } = await open(engine, lang, 640);
      t.after(() => browser.close());
      await page.evaluate(() => {
        hideAccounts.set(true);
        const outside = document.createElement("div");
        outside.id = "elsewhere";
        outside.textContent = "real.account@example.com";
        outside.title = "real.account@example.com";
        document.querySelector("#maskDemo").before(outside);
      });
      await page.waitForFunction(() => document.querySelector("#elsewhere .pii"));
      assert(!(await page.locator("#elsewhere").getAttribute("title")).includes("real.account"));
      await page.locator("#mdRow").click();
      for (let step = 0; step < 5; step++) {
        await page.locator(".mf-node").nth(step).click();
        assert.equal(await page.locator("#maskDemo .pii").count(), 0);
        // Every value written on this computer's side reads as written.
        assert.deepEqual(await page.locator(".mf-local .mf-req .mf-val").allTextContents(), ["demo@ex.test", "hello demo"]);
        assert.deepEqual(await page.locator(".mf-local .mf-rep .mf-val, .mf-table .mf-val").allTextContents(), ["demo@ex.test", "demo@ex.test", "hello demo"]);
        if (step === 0) assert.match(await page.locator(".mf-local .mf-slot").innerText(), /demo@ex.test[\s\S]*hello demo/);
        if (step > 0) assert.match(await page.locator(".mf-table").innerText(), /demo@ex.test[\s\S]*hello demo/);
        if (step === 4) assert.match(await page.locator(".mf-local .mf-slot").innerText(), /demo@ex.test/);
      }
      await page.locator("#mdRow").click();
      await page.locator("#mdRow").click();
      assert.equal(await page.locator("#maskDemo .pii").count(), 0);
      assert(await page.locator("#elsewhere .pii").count() > 0);
      assert.deepEqual(errors, []);
    });
  }
}
