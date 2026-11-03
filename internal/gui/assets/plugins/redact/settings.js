// Settings › Privacy: built-in masking controls and local model settings.
// Loaded after app.js and before start.js; the route row below wraps the
// complete renderer so the upstream routing option remains available.

// REDACT_KINDS are redact.Categories as Settings lists them: id, name,
// what it finds, and whether it is masked until the user chooses (a Go test
// holds the ids and the defaults to redact's). The ones in nearly every
// coding request (the agent's folder, logs, configs) are off.
const REDACT_KINDS = [
  ["ssn", "Social Security numbers", "US SSNs, in the ranges that are given out", true],
  ["passport", "Passport numbers", "After the word passport, 护照 or パスポート", true],
  ["iban", "IBANs", "Bank account numbers whose checksum adds up", true],
  ["birthday", "Birthdays", "A date after birthday, DOB, born or 生日; a date alone stays", true],
  ["mac", "MAC addresses", "A network card's hardware address", true],
  ["serial", "Serial numbers", "After S/N, Serial or 序列号", true],
  ["home", "User name in home folders", "The name in /Users/name, /home/name and C:\\Users\\name. Off by default: agents send their folder with every request", false],
  ["userhost", "User and computer names", "user@host in a shell prompt or an ssh command, and hostname or user lines", false],
  ["ip", "Public IP addresses", "Private, local and documentation addresses stay. Off by default: logs and configs are full of them", false],
  ["bucket", "Cloud storage buckets", "The bucket in s3://, gs://, oss://, cos:// and storage URLs; the path in it stays", false],
];

// renderRedact: what the gateway masks before a request goes to a vendor —
// secrets, personal data, the user's own words — and puts back in what the
// vendor answers. The page says it in three parts under what masking did
// (Insights › Masking): how it is found (the local model first, then the
// rules), what to mask, what is shared.
function renderRedact(s, keep) {
  const box = $("#redactList"), find = $("#findList"), share = $("#shareList");
  box.replaceChildren();
  find.replaceChildren();
  share.replaceChildren();
  const rowIn = (into, name, sub, ...tools) => {
    const r = el("div", "row pref");
    const who = el("div", "who");
    who.append(el("div", "name", name), el("div", "sub", sub));
    const val = el("div", "val");
    val.append(...tools);
    r.append(who, val);
    into.append(r);
    return r;
  };
  const row = (...a) => rowIn(box, ...a);
  const onOff = (on, fn) => segs([["off", t("Off")], ["on", t("On")]], on ? "on" : "off", (v) => fn(v === "on"));
  row(t("Mask secrets"), t("API keys, private keys, tokens and passwords go to vendors as placeholders, and come back as they were"),
    onOff(s.redact, (redact) => savePrefs({ ...keep, redact })));
  if (s.redact) row(t("Keep a key's form"), t("A key goes as a made-up one of the same form (sk_… stays sk_…), not a placeholder, and comes back as it was"),
    onOff(s.redactShape, (redactShape) => savePrefs({ ...keep, redactShape }))).id = "redactShapeRow";
  row(t("Mask personal data"), t("Emails, phone numbers, ID and bank card numbers too"),
    onOff(s.redactPersonal, (redactPersonal) => {
      // turned on, the accounts on screen are hidden too
      if (redactPersonal) window.hideAccounts?.set(true, true);
      savePrefs({ ...keep, redactPersonal });
    }));
  // each other kind of personal data, on or off of its own while personal
  // data is masked; only the user's choices are kept (redactKinds)
  if (s.redactPersonal) for (const [id, name, sub, on] of REDACT_KINDS) {
    const kinds = s.redactKinds || {};
    const r = el("div", "row pref redact-kind");
    r.dataset.redact = id;
    const who = el("div", "who");
    who.append(el("div", "name", t(name)), el("div", "sub", t(sub)));
    const val = el("div", "val");
    val.append(onOff(kinds[id] ?? on, (v) => savePrefs({ ...keep, redactKinds: { ...kinds, [id]: v } })));
    r.append(who, val);
    box.append(r);
  }
  const words = (s.redactWords || []).join(", ");
  const i = input(words, t("names, codenames, hosts"));
  i.className = "words";
  const save = () => {
    const v = i.value.split(/[,，\n]/).map((w) => w.trim()).filter(Boolean);
    if (v.join(", ") === words) return;
    savePrefs({ ...keep, redactWords: v });
  };
  i.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") save(); else if (e.key === "Escape") { i.value = words; i.blur(); } };
  i.onblur = save;
  row(t("Masked words"), t("Your own words to keep from vendors, separated by commas"), i);
  // plain words, matched as written unless the user asks for any case
  row(t("Masked words in any case"), t("A word also matches in other capitals: Nightjar masks NIGHTJAR and nightjar too"),
    onOff(s.redactWordsAnyCase, (redactWordsAnyCase) => savePrefs({ ...keep, redactWordsAnyCase }))).id = "redactWordsAnyCaseRow";
  row(t("Whole words only"), t("A word is not masked inside a longer one: ABC masks ABC and 'ABC' but not XABCD, and 123456 not 0.123456"),
    onOff(s.redactWordsWhole, (redactWordsWhole) => savePrefs({ ...keep, redactWordsWhole }))).id = "redactWordsWholeRow";
  renderRedactRules(s, row);
  renderMaskActions(s);
  renderMaskTry(s);
  // how it is found: the local model, for what no pattern can tell, over
  // the rules on every request that masks anything
  const masking = s.redact || s.redactPersonal;
  const why = t("Turn on Mask secrets or Mask personal data first");
  privacyModelRow(find, masking ? "" : why);
  const always = el("span", "static-pill" + (masking ? " on" : ""), masking ? t("Always on") : t("Off"));
  rowIn(find, t("Rules"), masking ? t("Keys, tokens, emails and numbers whose checksum adds up: patterns that are certain, checked on every request") : why, always).id = "maskRulesRow";
  // Routing's and Usage's Hide accounts, here too, where privacy is looked for
  if (window.hideAccounts) rowIn(share, t("Hide accounts"), t("Email addresses and account names on Usage and Routing are blurred, for a screenshot to share"),
    onOff(window.hideAccounts.on(), (on) => { window.hideAccounts.set(on); renderSettings(); }));
  rowIn(share, t("Count me as a user"), t("Once a day, a random id for this computer with magpie's version and system"),
    onOff(!s.noStats, (on) => savePrefs({ ...keep, noStats: !on })));
  // rides on that event: nothing goes without it
  if (!s.noStats) rowIn(share, t("Share the agents, providers and models I use"), t("Sent with that event, by magpie's own ids, with how many of each, and how often each partner was shown, opened and added; a provider you added yourself is only “custom”. No names, addresses, accounts, keys or usage"),
    onOff(!s.noUsageStats, (on) => savePrefs({ ...keep, noUsageStats: !on })));
  // what masking did is a page of its own, Insights › Masking
  if (!featureHides($('#nav button[data-view="masking"]'))) {
    const open = el("button", "", t("Open"));
    open.type = "button";
    open.onclick = () => openMaskRecord(0);
    box.prepend(rowIn(box, t("What was masked"), t("Each request masking changed, what the vendor saw, and how, on Insights › Masking"), open));
  }
}

// privacyModelRow: the local masking model (internal/pii), downloaded when
// it is turned on and then asked beside the rules. Its state is its own
// (privacy-model): read when the row is drawn, and each second while it
// downloads or starts. Under it, once the model can run, its threshold
// (pmScore).
let pmState = null, pmTimer = 0;
function privacyModelRow(box, why) {
  const r = el("div", "row pref" + (why ? " pm-wait" : ""));
  r.id = "privacyModelRow";
  box.append(r);
  const sr = el("div", "row pref");
  sr.id = "pmScoreRow";
  const name = () => { const n = el("div", "name", t("Find with a local model")); n.append(el("span", "badge new", t("New"))); return n; };
  // nothing is masked: the model has nothing to find more of
  if (why) {
    clearTimeout(pmTimer);
    const who = el("div", "who");
    who.append(name(), el("div", "sub", why));
    r.append(who);
    return;
  }
  let tries = 0;
  const draw = (m) => {
    if (!r.isConnected) return;
    const who = el("div", "who"), val = el("div", "val");
    who.append(name(), el("div", "sub", pmSub(m)));
    if (m?.supported || m?.installed) {
      if (m.models?.length > 1) val.append(pmPick(m, (id) => act("pick", id)));
      if (pmBusy(m)) {
        const c = el("button", "text", t("Cancel"));
        c.onclick = () => act("cancel");
        val.append(c);
      } else if (m.installed && !m.on) {
        const x = el("button", "text", t("Delete model"));
        x.onclick = async () => {
          if (await confirmAction(t("Delete the model?"), t("Turning it on again downloads {size} again.", { size: fmtBytes(m.size) }), t("Delete"))) act("remove");
        };
        val.append(x);
      }
      val.append(segs([["off", t("Off")], ["on", t("On")]], m.on || m.downloading ? "on" : "off", (v) => act(v)));
    }
    r.replaceChildren(who, val);
    if (m && (m.supported || m.installed) && m.defaultScore) {
      const sw = el("div", "who");
      sw.append(el("div", "name", t("Confidence threshold")), el("div", "sub", t("What the model is less sure of goes as written. Higher masks less, with fewer false alarms")));
      const sv = el("div", "val");
      sv.append(pmScore(m, (score) => act("score", m.model, score)));
      sr.replaceChildren(sw, sv);
      if (!sr.isConnected) r.after(sr);
    } else sr.remove();
    clearTimeout(pmTimer);
    // a download's progress, and where pf-serve runs once it has started
    const starting = m?.on && m.installed && !m.running && !m.failed && tries++ < 30;
    if (pmBusy(m) || starting) pmTimer = setTimeout(load, 1000);
  };
  const load = () => api("privacy-model").then((m) => { pmState = m; draw(m); }).catch(() => {});
  const act = (doing, model, score) => { tries = 0; api("privacy-model", { do: doing, model, score }).then((m) => { pmState = m; draw(m); }).catch((e) => { statusTErr(e); load(); }); };
  draw(pmState);
  load();
}
// the local models to pick from (pii.Models), by the app's menu: what
// each is, its size and whether it is downloaded
const PM_MODELS = { "astrlink-guard": ["AstrLink Guard", "Chinese and English, few false alarms in code"], "privacy-filter": ["Privacy Filter", "OpenAI's, masks more ordinary values in code"] };
// pmBusy is the model downloading (the one picked while another masks, too)
const pmBusy = (m) => (m?.models || []).find((x) => x.downloading) || (m?.downloading ? m : null);
function pmPick(m, pick) {
  const b = el("button", "sess-pick pm-model");
  b.type = "button";
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.title = t("The local model");
  b.append(el("span", "", (PM_MODELS[m.model] || [m.model])[0]), svg(CHEV, 11, 1.6));
  b.onclick = (e) => {
    e.stopPropagation();
    if (b.classList.contains("open")) return closeProtoMenu();
    const opts = (m.models || []).map((x) => ({ v: x.model, name: (PM_MODELS[x.model] || [x.model])[0], literalName: true,
      note: !x.supported && !x.installed ? t("Not available on this system yet") : t(PM_MODELS[x.model]?.[1] || "") + " · " + fmtBytes(x.size) + (x.installed ? " · " + t("downloaded") : "") }));
    openProtoMenu(b, opts, m.model, (v) => v !== m.model && pick(v), "The local model", "sess-menu", "right");
  };
  return b;
}
// pmScore picks the model's threshold (privacy-model's score) by the
// app's menu: its default, or one of PM_SCORES
const PM_SCORES = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
function pmScore(m, pick) {
  const cur = m.minScore === m.defaultScore ? "0" : String(m.minScore);
  const b = el("button", "sess-pick pm-score");
  b.type = "button";
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.title = t("Confidence threshold");
  b.append(el("span", "", String(m.minScore)), svg(CHEV, 11, 1.6));
  b.onclick = (e) => {
    e.stopPropagation();
    if (b.classList.contains("open")) return closeProtoMenu();
    const note = (s) => s === PM_SCORES[0] ? "Masks the most" : s === PM_SCORES.at(-1) ? "Masks the least" : "";
    const opts = [{ v: "0", name: t("Default ({score})", { score: m.defaultScore }), literalName: true, note: note(m.defaultScore) },
      ...PM_SCORES.filter((s) => s !== m.defaultScore).map((s) => ({ v: String(s), name: String(s), literalName: true, note: note(s) }))];
    openProtoMenu(b, opts, cur, (v) => v !== cur && pick(Number(v)), "Confidence threshold", "sess-menu", "right");
  };
  return b;
}
function pmSub(m) {
  const about = t("Names, addresses and passwords no rule can find, found by a model that runs on this computer");
  if (!m) return about;
  if (!m.supported && !m.installed) return t("Not available on this system yet");
  const d = pmBusy(m);
  if (d) return t("Downloading the model: {done} of {total}", { done: fmtBytes(d.done), total: fmtBytes(d.total) });
  const bad = (m.models || []).find((x) => x.error) || (m.error ? m : null);
  if (bad) return t("The download stopped: {error}", { error: bad.error });
  if (m.on && m.failed) return m.chosen ? t("The model didn't answer, so requests are held back: {error}", { error: m.failed }) : t("The model didn't answer, so the rules mask requests alone: {error}", { error: m.failed });
  if (m.on && m.running) {
    if (m.gpu) return t("On, on the GPU ({device})", { device: m.device });
    // AstrLink Guard on a Mac: CoreML, on the device its plan picked
    if (m.via) return { "Neural Engine": t("On, with CoreML on the Neural Engine"), GPU: t("On, with CoreML on the GPU"), CPU: t("On, with CoreML on the CPU") }[m.device] || t("On, with CoreML");
    if (m.gpuError && m.model === "astrlink-guard") return t("On, on the CPU: CoreML failed ({error})", { error: m.gpuError });
    return m.gpuError ? t("On, on the CPU: the GPU failed ({error})", { error: m.gpuError }) : t("On, on the CPU");
  }
  if (m.on) return t("On: the model starts with the next request");
  if (m.installed) return t("Off. The model is downloaded ({size})", { size: fmtBytes(m.size) });
  return t("Names, addresses and passwords no rule can find, found by a model that runs on this computer. Turning it on downloads {size} once", { size: fmtBytes(m.size) });
}

// Settings › Privacy's Instead of masking, send to (the redact plugin's part
// of Settings). Run after app.js, whose helpers it shares (el, icon,
// openPicker, modelOpt, prefWrite, api), and before start.js draws
// Settings. It wraps renderRedact, so app.js carries none of it: the row
// shows while anything is masked, after the masked-words rows.

// redactRouteRow: where a request masking would change goes instead
// (redactRouteTo, jessyoungyu on X): Off masks it as before; a model whose
// provider the user set to Send requests unmasked (maskRouteModels, on
// this computer or the network) gets it as written, so 「百度这家公司怎么样」
// is answered about Baidu, not a placeholder. Picked in the app's menu,
// saved on its own (settings/redact-route).
function redactRouteRow(s) {
  const models = s.maskRouteModels || [];
  const v = s.redactRouteTo || "";
  const b = el("button", "rt-cond on");
  b.type = "button";
  b.setAttribute("aria-label", t("Model for requests masking would change"));
  const m = models.find((x) => x.id === v);
  if (v) b.append(icon(m?.icon || "generic"), el("span", "", m ? `${m.name || m.id} · ${m.providerName}` : v));
  else b.append(el("span", "", t("Off")));
  b.disabled = !models.length && !v;
  b.onclick = (ev) => openPicker({ id: "", name: "", fields: [] }, { key: "redactRouteTo", label: "model", value: v, options: [
    { value: "", label: t("Off"), note: t("Masked and sent to the model asked for, as before"), icon: "generic", reset: true },
    ...models.map(modelOpt)],
  onPick: (id) => {
    if (id === v) return;
    prefWrite(api("settings/redact-route", { model: id }));
  } }, b, ev);
  const sub = models.length || v
    ? t("A request masking would change goes as written to this model, which you set to take requests unmasked, so it answers about the real names. If it fails, the request fails: it is never masked and sent elsewhere")
    : t("Only a model you set to take requests unmasked can be picked: in the editor of a provider on this computer or your network, turn on Send requests unmasked");
  const r = el("div", "row pref"), who = el("div", "who"), val = el("div", "val");
  who.append(el("div", "name", t("Instead of masking, send to")), el("div", "sub", sub));
  val.append(b);
  r.append(who, val);
  r.id = "redactRouteRow";
  const after = $("#redactWordsWholeRow");
  if (after) after.after(r); else $("#redactList").append(r);
}
{
  const draw = renderRedact;
  renderRedact = function (s, keep) {
    draw(s, keep);
    if (s.redact || s.redactPersonal || (s.redactWords || []).length) redactRouteRow(s);
  };
}
