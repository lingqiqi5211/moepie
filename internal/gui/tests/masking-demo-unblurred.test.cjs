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
        assert.match(await page.locator(".mf-example").first().innerText(), /demo@ex.test\npassword:\nhello demo/);
        assert.match(await page.locator(".mf-example").last().innerText(), /demo@ex.test\npassword:\nhello demo/);
      }
      await page.locator("#mdRow").click();
      await page.locator("#mdRow").click();
      assert.equal(await page.locator("#maskDemo .pii").count(), 0);
      assert(await page.locator("#elsewhere .pii").count() > 0);
      assert.deepEqual(errors, []);
    });
  }
}
