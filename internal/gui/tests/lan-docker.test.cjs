// Run with Node's test runner and Playwright on the module path; see README.md.
// Share on local network in a container (莫 on Discord: magpie in Docker on
// a NAS showed the container's own 172.17.x address): the addresses magpie
// finds for itself there are the container's, which other devices can't
// reach. Served over the network (magpie web), the page offers the host it
// was opened at, on the gateway's port, and says so; opened at localhost it
// keeps the container's addresses but says they are the container's own
// and to set MAGPIE_PUBLIC_URL. Outside a container nothing changes. Said
// on the Gateway card's addresses, where Share on local network is set.
// English and Chinese, Chromium and WebKit; no backend, the API is faked
// here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

function settingsPayload(over) {
  return {
    theme: "light", lang: "en", tray: "panel", quotaLeft: false, currency: "usd",
    dock: false, dockWindow: false, proxy: "", redact: false, redactPersonal: false, redactWords: [],
    codexWarmup: "", claudeWarmup: "", codexWarmAt: "", claudeWarmAt: "", workbuddyCheckin: false, noStats: false,
    trayUsage: "", trayUsageEvery: 3, vision: "", imageGen: "",
    version: "0.1.400", dir: "/config/magpie", gateway: "http://0.0.0.0:3425",
    proxyNow: "none", proxySource: "none", login: false,
    visionModels: [], imageGenModels: [], workbuddyCheckins: [],
    lan: true, lanKey: "sk-magpie-0123456789abcdef", lanURLs: ["http://172.17.0.2:3425"],
    fx: { rate: 7.2, at: new Date().toISOString(), stale: false },
    ...over,
  };
}

function server(lang, web, over) {
  const s = settingsPayload({ lang, ...over });
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:${web}};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" }, fx: s.fx });
    if (url.pathname === "/api/settings") return json(s);
    if (url.pathname === "/api/providers") return json({ providers: [], gateway: { running: true, mine: true, url: "http://127.0.0.1:3425", lan: true, lanURLs: s.lanURLs, calls: [], groups: [] } });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const words = {
  en: {
    lan: "Local network",
    opened: "Where this page was opened, on the gateway’s port; MAGPIE_PUBLIC_URL sets another",
    own: "The container’s own addresses, which other devices can’t reach: set MAGPIE_PUBLIC_URL to the host’s",
  },
  zh: {
    lan: "局域网",
    opened: "打开本页所用的地址，端口为网关端口；可用 MAGPIE_PUBLIC_URL 另设",
    own: "容器自身的地址，其他设备无法访问：请将 MAGPIE_PUBLIC_URL 设为宿主机地址",
  },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(engine + ": in a container, the share address is the host's, not the container's", async (t) => {
    assert(["chromium", "webkit"].includes(engine), "BROWSER must be chromium or webkit");
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    const pages = [];
    t.after(async () => {
      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-lan-docker-${i}.png`) });
      }
      await browser.close();
    });

    const open = async (lang, at, web, over) => {
      const page = await (await browser.newContext({ viewport: { width: 900, height: 360 }, reducedMotion: "reduce" })).newPage();
      pages.push(page);
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", server(lang, web, over));
      await page.goto(at + "/?view=gateway");
      // the card drawn, and drawn again once the settings say whether
      // magpie runs in a container
      await page.locator("#portList .port-row").waitFor();
      await page.waitForFunction(() => !document.querySelector("#view-gateway").classList.contains("loading"));
      return { page, errors };
    };
    // the card's addresses: [label, address] each
    const lines = (page) => page.locator("#gatewayLan .gw-url").evaluateAll((rs) => rs.map((r) => [r.querySelector(".gw-url-label").textContent, r.querySelector("code").textContent]));
    const note = (page) => page.locator("#gatewayLan .gw-url-none");

    for (const lang of ["en", "zh"]) {
      const w = words[lang];
      await t.test(lang, async () => {
        // magpie web, opened at the NAS's address: the gateway there
        {
          const { page, errors } = await open(lang, "http://192.168.1.20:3430", true, { lanContainer: true });
          assert.deepEqual((await lines(page)).slice(1), [[w.lan, "http://192.168.1.20:3425"]]);
          assert.equal((await note(page).textContent()).trim(), w.opened);
          const border = await note(page).evaluate((r) => getComputedStyle(r).borderLeftWidth);
          assert(border === "0px" || border === "", "no left border accent: " + border);
          assert.deepEqual(errors, []);
        }
        // opened at localhost (a tunnel, or on the NAS itself): the
        // container's address stays, said to be the container's own
        {
          const { page, errors } = await open(lang, "http://localhost:3430", true, { lanContainer: true });
          assert.deepEqual((await lines(page)).slice(1), [[w.lan, "http://172.17.0.2:3425"]]);
          assert.equal((await note(page).textContent()).trim(), w.own);
          assert.deepEqual(errors, []);
        }
        // not in a container (or MAGPIE_PUBLIC_URL set): as it was
        {
          const { page, errors } = await open(lang, "http://192.168.1.20:3430", true, { lanURLs: ["http://192.168.1.5:3425"] });
          assert.deepEqual((await lines(page)).slice(1), [[w.lan, "http://192.168.1.5:3425"]]);
          assert.equal(await note(page).count(), 0);
          assert.deepEqual(errors, []);
        }
      });
    }
  });
}
