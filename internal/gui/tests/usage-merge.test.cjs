// A provider's accounts together (CryptoSarom on X: how much of a model is
// left matters more than which account holds it). mergeQuotas, the shipped
// function, puts together only what reads alike: counted windows of one
// name and unit add their amounts and limits, wallets their balances, and a
// window said only as a share is the mean of accounts on one plan. A share
// is never added to a count, two units never meet, two plans' shares
// never meet, and an account whose reading failed is unknown, not 0 or
// 100. A window an earlier reading stands in for, past its reset, is left
// out and counted. Needs no browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(process.env.MAGPIE_APP_JS || path.resolve(__dirname, "../assets/app.js"), "utf8").replace(/\r\n/g, "\n");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `missing ${start}`);
  return source.slice(a, b);
}
// quotaall.js, which app.js loads once a provider has two accounts
const merging = fs.readFileSync(path.resolve(__dirname, "../assets/quotaall.js"), "utf8").replace(/\r\n/g, "\n");
const ctx = vm.createContext({});
ctx.window = ctx;
vm.runInContext(`
  ${section("function to100(", "\n")}
  ${merging}
`, ctx);
const merge = (subs, now) => JSON.parse(JSON.stringify(ctx.mergeQuotas(JSON.parse(JSON.stringify(subs)), now)));
const H = 3600e3, now = Date.parse("2026-11-01T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const acct = (user, windows, extra) => ({ provider: "workbuddy-ai", name: "WorkBuddy AI", user, plan: "Pro", windows, ...extra });
const by = (r, name) => r.windows.filter((w) => w.name === name);

test("counted windows of one unit add up; the share is of the sum", () => {
  const r = merge([
    acct("a", [{ name: "Credits", amount: 100, limit: 500, unit: "credits", used: 20 }]),
    acct("b", [{ name: "Credits", amount: 250, limit: 500, unit: "credits", used: 50 }]),
    acct("c", [{ name: "Credits", amount: 5, limit: 500, unit: "credits", used: 1 }]),
  ], now);
  assert.equal(r.accounts, 3);
  assert.equal(r.unknown, 0);
  const [w] = by(r, "Credits");
  assert.equal(w.amount, 355);
  assert.equal(w.limit, 1500);
  assert.ok(Math.abs(w.used - (100 * 355) / 1500) < 1e-9);
  assert.equal(w.accounts, 3);
  assert.equal(w.how, "c");
});

test("a share is never added to a count, nor one unit to another", () => {
  const r = merge([
    acct("a", [{ name: "Monthly", amount: 100, limit: 500, unit: "credits" }, { name: "Tokens", amount: 1, limit: 10, unit: "M tokens" }]),
    acct("b", [{ name: "Monthly", used: 40 }, { name: "Tokens", amount: 3, limit: 10, unit: "requests" }]),
  ], now);
  // each kind has one account only: nothing goes together
  assert.deepEqual(r.windows, []);
});

test("an account whose reading failed is unknown, left out of the figure", () => {
  const r = merge([
    acct("a", [{ name: "5 hours", used: 20, resetsAt: iso(now + H) }]),
    acct("b", [{ name: "5 hours", used: 60, resetsAt: iso(now + 2 * H) }]),
    acct("c", [], { error: "401 Unauthorized" }),
  ], now);
  assert.equal(r.accounts, 2);
  assert.equal(r.unknown, 1);
  const [w] = by(r, "5 hours");
  assert.equal(w.used, 40, "the mean of the two read, the failed one neither 0 nor 100");
  assert.equal(w.accounts, 2);
  assert.equal(w.firstReset, iso(now + H));
  assert.equal(w.resetsAt, undefined, "no single reset is claimed for the whole");
});

test("shares are averaged within a plan only", () => {
  const r = merge([
    acct("a", [{ name: "5 hours", used: 10 }], { plan: "Plus" }),
    acct("b", [{ name: "5 hours", used: 30 }], { plan: "Plus" }),
    acct("c", [{ name: "5 hours", used: 90 }], { plan: "Pro" }),
  ], now);
  const ws = by(r, "5 hours");
  assert.equal(ws.length, 1, "the Pro account alone is not merged into the Plus mean");
  assert.equal(ws[0].used, 20);
  assert.equal(ws[0].plan, "Plus", "named with its plan when the accounts have several");
  const one = merge([acct("a", [{ name: "5 hours", used: 10 }], { plan: "Plus" }), acct("b", [{ name: "5 hours", used: 30 }], { plan: "Pro" })], now);
  assert.deepEqual(one.windows, []);
});

test("a stale window past its reset is left out and counted", () => {
  const r = merge([
    acct("a", [{ name: "Daily", used: 10, resetsAt: iso(now + H) }]),
    acct("b", [{ name: "Daily", used: 50, resetsAt: iso(now + H) }]),
    acct("c", [{ name: "Daily", used: 99, resetsAt: iso(now - H) }], { asOf: iso(now - 3 * H) }),
  ], now);
  const [w] = by(r, "Daily");
  assert.equal(w.used, 30);
  assert.equal(w.unknown, 1);
});

test("balances add up; unlimited only when every account is; text is left out", () => {
  const r = merge([
    acct("a", [{ name: "Wallet", balance: 12.5, unit: "USD" }, { name: "Chat", unlimited: true }, { name: "Overages", text: true, used: 100 }]),
    acct("b", [{ name: "Wallet", balance: 7.5, unit: "USD" }, { name: "Chat", unlimited: true }, { name: "Overages", text: true, used: 100 }]),
    acct("c", [{ name: "Wallet", balance: 1, unit: "credits" }, { name: "Chat", used: 30 }]),
  ], now);
  assert.deepEqual(by(r, "Wallet").map((w) => [w.balance, w.unit]), [[20, "USD"]]);
  assert.deepEqual(by(r, "Chat").filter((w) => w.unlimited), [], "one account has a limit");
  assert.deepEqual(by(r, "Overages"), []);
});

test("windows keep their family and pool, apart by them", () => {
  const r = merge([
    acct("a", [{ name: "5 hours", pool: "Gemini", used: 10 }, { name: "5 hours", pool: "Claude & GPT", used: 70 }]),
    acct("b", [{ name: "5 hours", pool: "Gemini", used: 30 }, { name: "5 hours", pool: "Claude & GPT", used: 90 }]),
  ], now);
  assert.deepEqual(r.windows.map((w) => [w.pool, w.used]), [["Gemini", 20], ["Claude & GPT", 80]]);
});
