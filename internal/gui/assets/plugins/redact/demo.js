(() => {
// A fixed illustration: five steps, with local replacement and restoration.
// A single timeout advances the highlight only while the illustration is visible.
const MASK_FLOW_STEPS = [
  ["Original request", "On your computer", "The agent starts with the original values.", "account:\ndemo@ex.test\npassword:\nhello demo"],
  ["Replace locally", "On your computer", "Matched values become placeholders. Their mapping stays in local memory.", "{{EMAIL_1}}\n↔ demo@ex.test\n{{SECRET_1}}\n↔ hello demo"],
  ["Send masked request", "Remote model", "The request crosses the network with the matched values replaced.", "account:\n{{EMAIL_1}}\npassword:\n{{SECRET_1}}"],
  ["Receive the reply", "Remote model → your computer", "The model can refer to placeholders in its reply.", "account:\n{{EMAIL_1}}\npassword:\n{{SECRET_1}}"],
  ["Restore locally", "On your computer", "Known placeholders in the reply are restored before it reaches the agent.", "account:\ndemo@ex.test\npassword:\nhello demo"],
];
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
  const root = el("div", "mask-flow");
  root.append(say("p", "mf-note", "Fictional example · no request is sent"));
  const list = el("ol", "mf-steps");
  const nodes = MASK_FLOW_STEPS.map(([title, place, detail, sample], i) => {
    const item = el("li", "mf-step"), button = el("button", "mf-node");
    button.type = "button";
    button.append(el("span", "mf-number", String(i + 1)), say("span", "mf-title", title));
    button.onclick = () => { playing = false; step = i; render(); wake(); };
    item.append(say("span", "mf-place", place), button, say("p", "mf-detail", detail), el("pre", "mf-example", sample));
    list.append(item);
    return button;
  });
  root.append(list, say("p", "mf-note", "Placeholders are replacements, not encryption. This example shows matched values; detection depends on your masking settings and rules."));
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
    nodes.forEach((node, i) => {
      node.setAttribute("aria-current", i === step ? "step" : "false");
      node.closest("li").classList.toggle("mf-current", i === step);
    });
    play.textContent = t(playing ? "Pause the flow" : "Play the flow");
    status.textContent = `${step + 1} / ${nodes.length} · ${t(MASK_FLOW_STEPS[step][0])}`;
  }
  function wake() {
    clearTimeout(timer);
    timer = 0;
    if (!root.isConnected) { dispose(); return; }
    if (disposed || !playing || !seen || document.hidden || !root.getClientRects().length || $("#mdRow")?.getAttribute("aria-expanded") !== "true") return;
    timer = setTimeout(() => {
      timer = 0;
      if (step < nodes.length - 1) step++;
      else playing = false;
      render();
      wake();
    }, 2200);
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
    intersection.disconnect(); visibility.disconnect(); language.disconnect(); removal.disconnect();
    motion.removeEventListener("change", reduce);
    document.removeEventListener("visibilitychange", wake);
  }
  render();
  root.__state = () => ({ step, playing, timer: !!timer });
  return { root, wake, dispose };
}

})();
