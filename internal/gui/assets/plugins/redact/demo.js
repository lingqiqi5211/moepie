(() => {
// A fixed illustration: five steps, with local replacement and restoration.
// A stage shows this computer and the remote model on either side of the
// network: the request's values turn into placeholders here, the mapping
// stays in a local table, and the reply's placeholders turn back. A single
// timeout advances the steps only while the illustration is visible.
const MASK_FLOW_DWELL = 2200;
// Each step: title, where it happens, what happens, and the stage's scene:
// which card each side shows, whether this computer's values are replaced,
// which mapping rows are written or read, and which way a packet crosses.
const MASK_FLOW_STEPS = [
  ["Original request", "On your computer", "The agent starts with the original values.", { local: "req", masked: false, remote: "", table: false, hit: [], wire: "" }],
  ["Replace locally", "On your computer", "Matched values become placeholders. Their mapping stays in local memory.", { local: "req", masked: true, remote: "", table: true, hit: [0, 1], wire: "" }],
  ["Send masked request", "Remote model", "The request crosses the network with the matched values replaced.", { local: "req", masked: true, sent: true, remote: "req", table: true, hit: [], wire: "out" }],
  ["Receive the reply", "Remote model → your computer", "The model can refer to placeholders in its reply.", { local: "rep", masked: true, remote: "rep", table: true, hit: [], wire: "back" }],
  ["Restore locally", "On your computer", "Known placeholders in the reply are restored before it reaches the agent.", { local: "rep", masked: false, remote: "rep", table: true, hit: [0], wire: "" }],
];
const MASK_FLOW_VALUES = [["{{EMAIL_1}}", "demo@ex.test"], ["{{SECRET_1}}", "hello demo"]];
const MASK_FLOW_ICONS = {
  local: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="7.5" rx="1.3"/><path d="M1 13h14"/></svg>',
  remote: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 12.5h6.9a2.9 2.9 0 0 0 .3-5.8 3.9 3.9 0 0 0-7.5 1.1 2.4 2.4 0 0 0 .3 4.7z"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></svg>',
};
let maskFlow = null;
document.addEventListener("click", (event) => {
  if (!event.target.closest?.("#mdRow")) return;
  const row = $("#mdRow"), body = $("#mdBody");
  const open = row.getAttribute("aria-expanded") !== "true";
  row.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
  if (open && !maskFlow?.root.isConnected) {
    maskFlow?.dispose();
    maskFlow = maskDemoBuild(body);
  }
  maskFlow?.wake();
});
function maskDemoBuild(body) {
  const say = (tag, cls, key) => {
    const node = el(tag, cls, t(key));
    node.dataset.t = "";
    node.dataset.en = key;
    return node;
  };
  const icon = (name) => {
    const node = el("span", "mf-icon");
    node.innerHTML = MASK_FLOW_ICONS[name];
    return node;
  };
  // A token holds a value and its placeholder in one place, one face
  // showing; the model's side only ever has the placeholder.
  const token = ([ph, value], remote) => {
    const node = el("span", "mf-tok");
    if (!remote) node.append(el("span", "mf-face mf-val", value));
    node.append(el("span", "mf-face mf-ph", ph));
    return node;
  };
  const request = (remote) => {
    const card = el("div", "mf-msg mf-req");
    card.append(say("span", "mf-mlabel", "Request to the model"));
    [["account:", MASK_FLOW_VALUES[0]], ["password:", MASK_FLOW_VALUES[1]]].forEach(([field, pair], i) => {
      const line = el("div", "mf-line"), tok = token(pair, remote);
      tok.style.setProperty("--i", i);
      line.append(el("span", "mf-key", field), tok);
      card.append(line);
    });
    return card;
  };
  const replies = [];
  const reply = (remote) => {
    const card = el("div", "mf-msg mf-rep"), text = el("p", "mf-say");
    text.append(document.createTextNode(""), token(MASK_FLOW_VALUES[0], remote), document.createTextNode(""));
    card.append(say("span", "mf-mlabel", "The model's reply"), text);
    replies.push(text);
    return card;
  };
  const zone = (cls, name, label) => {
    const node = el("section", "mf-zone " + cls), head = el("div", "mf-zhead");
    head.append(icon(name), say("span", "", label));
    node.append(head);
    return node;
  };

  const root = el("div", "mask-flow");
  root.style.setProperty("--mf-dwell", MASK_FLOW_DWELL + "ms");
  root.append(say("p", "mf-note", "Fictional example · no request is sent"));
  const list = el("ol", "mf-steps");
  const nodes = MASK_FLOW_STEPS.map(([title], i) => {
    const item = el("li", "mf-step"), button = el("button", "mf-node"), bar = el("span", "mf-bar");
    button.type = "button";
    button.append(el("span", "mf-number", String(i + 1)), say("span", "mf-title", title));
    button.onclick = () => { playing = false; step = i; render(); wake(); };
    bar.append(el("i"));
    item.append(button, bar);
    list.append(item);
    return button;
  });

  // This computer: the card on the agent's side, and the mapping table.
  const local = zone("mf-local", "local", "On your computer"), localSlot = el("div", "mf-slot");
  const localReq = request(false), localRep = reply(false);
  localSlot.append(localReq, localRep);
  const table = el("div", "mf-table"), tableHead = el("div", "mf-thead"), tableBody = el("div", "mf-tbody"), rows = el("ul", "mf-rows");
  tableHead.append(icon("lock"), say("span", "", "Mapping table · stays on this computer"));
  const tableRows = MASK_FLOW_VALUES.map(([ph, value], i) => {
    const row = el("li", "mf-row");
    row.style.setProperty("--i", i);
    row.append(token([ph], true), el("span", "mf-arrow", "↔"), el("span", "mf-tok mf-plain", el("span", "mf-face mf-val", value)));
    rows.append(row);
    return row;
  });
  tableBody.append(say("span", "mf-tempty", "Empty until a value is replaced"), rows);
  table.append(tableHead, tableBody);
  local.append(localSlot, table);

  // The network between them, which a packet crosses each way.
  const wire = el("div", "mf-wire"), run = el("span", "mf-run"), way = el("span", "mf-dir");
  wire.setAttribute("aria-hidden", "true");
  run.append(el("i", "mf-pkt"));
  way.append(icon("arrow"));
  wire.append(el("span", "mf-net"), say("span", "mf-wlabel", "Network boundary"), way, run);

  // The remote model: only placeholders reach it.
  const remote = zone("mf-remote", "remote", "Remote model"), remoteSlot = el("div", "mf-slot");
  const remoteReq = request(true), remoteRep = reply(true), remoteEmpty = say("p", "mf-empty", "Nothing has reached the model yet");
  remoteSlot.append(remoteEmpty, remoteReq, remoteRep);
  remote.append(remoteSlot);

  const stage = el("div", "mf-stage");
  stage.append(local, wire, remote);
  const caption = el("div", "mf-caption"), place = el("span", "mf-place"), detail = el("p", "mf-detail");
  caption.append(place, detail);
  root.append(list, caption, stage, say("p", "mf-note", "Placeholders are replacements, not encryption. This example shows matched values; detection depends on your masking settings and rules."));
  const controls = el("div", "mf-controls"), play = el("button", "mf-control"), replay = say("button", "mf-control", "Replay the flow");
  play.type = replay.type = "button";
  const status = el("span", "mf-status");
  status.setAttribute("role", "status");
  controls.append(play, replay, status);
  root.append(controls);
  body.replaceChildren(root);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let step = 0, playing = !motion.matches, timer = 0, seen = false, disposed = false;
  function render() {
    const [title, where, what, scene] = MASK_FLOW_STEPS[step];
    nodes.forEach((node, i) => {
      node.setAttribute("aria-current", i === step ? "step" : "false");
      const item = node.closest("li");
      item.classList.toggle("mf-current", i === step);
      item.classList.toggle("mf-done", i < step);
    });
    localReq.classList.toggle("mf-on", scene.local === "req");
    localReq.classList.toggle("mf-sent", !!scene.sent);
    localRep.classList.toggle("mf-on", scene.local === "rep");
    local.classList.toggle("mf-masked", scene.masked);
    remoteEmpty.classList.toggle("mf-on", !scene.remote);
    remoteReq.classList.toggle("mf-on", scene.remote === "req");
    remoteRep.classList.toggle("mf-on", scene.remote === "rep");
    table.classList.toggle("mf-filled", scene.table);
    tableRows.forEach((row, i) => row.classList.toggle("mf-hit", scene.hit.includes(i)));
    wire.classList.toggle("mf-out", scene.wire === "out");
    wire.classList.toggle("mf-back", scene.wire === "back");
    stage.dataset.step = String(step);
    place.textContent = t(where);
    place.classList.toggle("mf-far", where !== "On your computer");
    detail.textContent = t(what);
    // The reply's sentence is said around its token in each language.
    const [before, after = ""] = t("Got it, I'll sign in as {email}.").split("{email}");
    for (const text of replies) { text.firstChild.data = before; text.lastChild.data = after; }
    play.textContent = t(playing ? "Pause the flow" : "Play the flow");
    status.textContent = `${step + 1} / ${nodes.length} · ${t(title)}`;
  }
  // The current step's bar fills over the timer's own wait, from its start.
  function ticking(on) {
    root.classList.remove("mf-ticking");
    if (!on) return;
    void root.offsetWidth;
    root.classList.add("mf-ticking");
  }
  function wake() {
    clearTimeout(timer);
    timer = 0;
    ticking(false);
    if (!root.isConnected) { dispose(); return; }
    if (disposed || !playing || !seen || document.hidden || !root.getClientRects().length || $("#mdRow")?.getAttribute("aria-expanded") !== "true") return;
    timer = setTimeout(() => {
      timer = 0;
      if (step < nodes.length - 1) step++;
      else playing = false;
      render();
      wake();
    }, MASK_FLOW_DWELL);
    ticking(true);
  }
  play.onclick = () => {
    playing = !playing;
    if (playing && step === nodes.length - 1) step = 0;
    render(); wake();
  };
  replay.onclick = () => { step = 0; playing = !motion.matches; render(); wake(); };
  const intersection = new IntersectionObserver((entries) => { seen = entries[entries.length - 1].isIntersecting; wake(); });
  intersection.observe(root);
  // Ancestor visibility includes page switches, request details, and folding.
  const visibility = new MutationObserver(wake);
  for (let parent = body; parent; parent = parent.parentElement) visibility.observe(parent, { attributes: true, attributeFilter: ["hidden", "class", "style"] });
  const language = new MutationObserver(render);
  language.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  const reduce = () => { if (motion.matches) playing = false; render(); wake(); };
  motion.addEventListener("change", reduce);
  document.addEventListener("visibilitychange", wake);
  // Dispose even if the kernel removes and redraws the page while folded.
  const removal = new MutationObserver(() => { if (!root.isConnected) dispose(); });
  removal.observe(document.body, { childList: true, subtree: true });
  function dispose() {
    disposed = true;
    clearTimeout(timer); timer = 0;
    ticking(false);
    intersection.disconnect(); visibility.disconnect(); language.disconnect(); removal.disconnect();
    motion.removeEventListener("change", reduce);
    document.removeEventListener("visibilitychange", wake);
  }
  render();
  root.__state = () => ({ step, playing, timer: !!timer });
  return { root, wake, dispose };
}

})();
