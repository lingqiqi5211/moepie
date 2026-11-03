// The LAN address picker lives on Gateway after settings move there.
// Its choice still updates the sidebar immediately and survives reload.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { fixture } = require("./fixtures/caller-keys.cjs");
const { reach } = require("./reader.cjs");
const LOCAL = "http://127.0.0.1:3999";
const lanURLs = ["http://192.168.1.10:3999", "http://10.0.0.10:3999"];
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    test(`${engine} ${lang}: the sidebar's gateway names the address shared on the local network`, async t => {
      const b = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => b.close());
      const p = await b.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce" });
      p.setDefaultTimeout(6000);
      const errors = []; p.on("pageerror", e => errors.push(e.message));
      await p.route("**/*", fixture(lang, "light", [], { lan: true, lanURLs, bootGateway: true }));
      const line = () => p.locator("#sideGw span").textContent();
      const tip = () => p.locator("#sideGw").getAttribute("title");
      const says = host => p.waitForFunction(h => document.querySelector("#sideGw span")?.textContent.includes(h), host);
      await p.goto("http://magpie.test/?view=settings");
      await p.locator("#sideGw").waitFor();
      assert.match(await line(), /192\.168\.1\.10:3999/);
      assert.doesNotMatch(await line(), /127\.0\.0\.1/);
      assert.match(await tip(), /192\.168\.1\.10:3999/);
      assert.match(await tip(), /127\.0\.0\.1:3999/);
      await p.goto("http://magpie.test/?view=gateway");
      const picker = p.locator("#gatewayLan .lan-interface");
      await picker.waitFor();
      await reach(p, picker); await picker.click();
      await p.locator(".proto-menu .pm-item", { hasText: "10.0.0.10" }).click();
      await says("10.0.0.10:3999");
      await p.reload(); await p.locator("#sideGw").waitFor();
      assert.match(await line(), /10\.0\.0\.10:3999/);
      const share = p.locator("#gatewayLan .gw-share .segs");
      await share.locator(".opt").nth(0).click();
      await p.locator("#gatewayLan .lan-address-row").waitFor({ state: "detached" });
      await says("127.0.0.1:3999");
      assert.doesNotMatch(await tip(), /192\.168|10\.0\.0/);
      assert.match(await tip(), new RegExp(LOCAL.replace(/\./g, "\\.") + "$"));
      await share.locator(".opt").nth(1).click();
      await p.locator("#gatewayLan .lan-address-row").waitFor();
      await says("10.0.0.10:3999");
      assert.deepEqual(errors, []);
    });
  }
  test(`${engine}: not shared, the sidebar's gateway is this computer's`, async t => {
    const b = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => b.close());
    const p = await b.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce" });
    const errors = []; p.on("pageerror", e => errors.push(e.message));
    await p.route("**/*", fixture("en", "light", [], { lanURLs, bootGateway: true }));
    const read = p.waitForResponse(r => r.url().endsWith("/api/providers"));
    await p.goto("http://magpie.test/?view=settings"); await p.locator("#sideGw").waitFor(); await read;
    await p.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await p.locator("#sideGw span").textContent(), "Gateway 127.0.0.1:3999");
    assert.equal(await p.locator("#sideGw").getAttribute("title"), "Gateway " + LOCAL);
    assert.deepEqual(errors, []);
  });
}
