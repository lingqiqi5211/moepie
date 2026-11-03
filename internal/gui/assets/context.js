"use strict";
// Context windows: what a request's prompt holds, as the gateway read it
// (gateway.Route.Prompt), drawn as a card: how full the window is, how
// much the vendor read from its cache and where the session is; the parts
// that fill it as a bar or as blocks, with tags to pick one; its contents,
// largest first; and the session's prompts request by request. Routing
// shows the card for the request it tells of; the Usage page's Context tab
// scores each agent's use of its window, tags it, and lists its sessions.
(() => {
  const PARTS = ["system", "tools", "skills", "memory", "files", "results", "chat"];
  const PART_NAMES = {
    system: "System prompt", tools: "Tools", skills: "Skills", memory: "Memory",
    files: "Files", results: "Tool results", chat: "Conversation",
  };
  const PART_NOTES = {
    system: "The agent's own instructions",
    tools: "The definitions of the tools it can call",
    skills: "The skills it can load, by name and what each is for",
    memory: "Instruction files, memory and reminders",
    files: "Files it read, and images",
    results: "What the other tools it called returned",
    chat: "What you and the model said, turn by turn",
  };
  const partName = (k) => t(PART_NAMES[k] || k);
  // the Codexes here before 0.163 or of no known version (app.js too)
  const codexHeld = window.codexHeld = (held) => t("{who}: the share needs Codex 0.163 or later; until it's updated magpie writes only async_compaction = true, at 65%", { who: held.map((r) => t({ app: "Codex app", ide: "Codex editor extension", wsl: "Codex in WSL" }[r.kind] || "Codex CLI") + (r.version ? " " + r.version : "")).join(", ") });

  const fmtK = (n) => {
    n = Math.max(0, Math.round(n || 0));
    const short = (x, d) => x.toFixed(d).replace(/\.0+$/, "");
    if (n >= 1e6) return short(n / 1e6, n >= 1e7 ? 1 : 2) + "M";
    if (n >= 1e3) return short(n / 1e3, n >= 1e5 ? 0 : 1) + "K";
    return String(n);
  };
  const pct = (x) => Math.round(x * 100) + "%";
  // a count of tokens that a redraw counts on from what it said (morph)
  const num = (tag, cls, n) => { const e = el(tag, cls, fmtK(n)); e.dataset.n = Math.round(n); return e; };
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const agentMeta = (id) => (state.clients || state.agents || []).find((a) => a.id === id);
  // "scripts": requests naming only a library (context.go's scriptsAgent)
  const agentLabel = (id) => (id === "scripts" ? t("Scripts") : agentMeta(id)?.name || id || t("your agent"));
  const agentIcon = (id) => icon(agentMeta(id)?.icon || "generic");
  // the lab a model id is from, by its name after the provider's; none when
  // it isn't known, so a wrong logo never stands for it
  const LABS = [[/claude/, "claude-color"], [/gpt|^o\d|codex/, "openai"], [/gemma/, "gemma-color"], [/gemini/, "gemini-color"],
    [/deepseek/, "deepseek-color"], [/qwen|qwq/, "qwen-color"], [/kimi|moonshot/, "kimi"], [/glm/, "zhipu-color"], [/grok/, "grok"],
    [/minimax|abab/, "minimax-color"], [/doubao|seed/, "doubao-color"], [/stral/, "mistral-color"], [/llama/, "meta-color"],
    [/mimo/, "xiaomimimo"], [/^step/, "stepfun-color"], [/hunyuan/, "hunyuan-color"]];
  const labIcon = (model) => {
    const m = model.toLowerCase().split("/").pop();
    const hit = LABS.find(([re]) => re.test(m));
    return hit ? [icon(hit[1])] : [];
  };

  // what an item of the prompt is called: a file's path or a tool's name
  // as it is; magpie's own names for the rest in the reader's language
  const ITEM_NAMES = {
    prompt: "Agent prompt", harness: "Harness messages", billing: "Billing header",
    environment: "Environment notes", context: "Context", skills: "Skills",
    reminders: "System reminders", compacted: "Compacted summary", image: "Image", document: "Document",
  };
  function itemName(it) {
    if (it.tag === "turn") return t("Turn {n}", { n: it.name });
    if (it.tag === "turns") return t("{n} earlier turns", { n: it.n });
    if (it.tag === "more") return t("{n} more", { n: it.n });
    return ITEM_NAMES[it.name] ? t(ITEM_NAMES[it.name]) : it.name;
  }
  // a path's file name first, where it is after it
  function itemLabel(it, kind) {
    const name = itemName(it);
    const e = el("span", "ctx-name");
    if ((kind === "files" || kind === "memory") && name.includes("/")) {
      const at = name.lastIndexOf("/");
      e.append(el("b", "", name.slice(at + 1)), el("small", "", name.slice(0, at + 1)));
    } else e.append(el("b", "", name));
    e.title = name;
    return e;
  }
  const TAG_NAMES = {
    mcp: "MCP", namespace: "namespace", read: "read", shell: "shell", result: "result",
    user: "user", project: "project", local: "local", memory: "memory", skills: "skills",
    reminder: "reminder", image: "image", turn: "", turns: "", more: "", compacted: "",
  };
  const tagOf = (it) => it.tag in TAG_NAMES ? TAG_NAMES[it.tag] : it.tag || "";

  const health = (fill) => fill < 0.75 ? ["ok", "Healthy"] : fill < 0.9 ? ["warn", "Filling up"] : ["bad", "Near full"];

  // the cache a route's vendor read: its last answer's usage
  function cacheOf(r) {
    const u = r.usage?.[r.usage.length - 1];
    // a vendor that counts no cache has none to show, not 0% (#3464)
    if (!u || u.cache_unknown) return null;
    const total = (u.in || 0) + (u.cache_read || 0) + (u.cache_write || 0);
    if (!total) return null;
    return { read: u.cache_read || 0, total };
  }

  // the headroom: how many more requests fit, at the pace the session's
  // prompts grew
  function headroom(series, free) {
    const g = growth(series);
    return g > 0 ? Math.floor(free / g) : null;
  }

  // count words a number with the phrase for one, or for many
  const count = (n, one, many) => n === 1 ? t(one) : t(many, { n });

  // spark draws a session's prompts, request by request, against its
  // window; the one the card tells of is marked
  function spark(series, at, window) {
    const W = 240, H = 34, pad = 3;
    // scaled to the session's peak, so a session that never came near its
    // window still shows how it grew; the window's line shows once it is near
    const peak = Math.max(...series.map((p) => p.tokens), 1);
    const top = window && peak > window * 0.6 ? Math.max(window, peak) : peak * 1.2;
    const x = (i) => series.length < 2 ? W / 2 : pad + (i / (series.length - 1)) * (W - pad * 2);
    const y = (n) => H - pad - (n / top) * (H - pad * 2);
    const box = el("span", "ctx-spark");
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", `0 0 ${W} ${H}`);
    s.setAttribute("preserveAspectRatio", "none");
    box.append(s);
    const ns = (tag, attrs) => {
      const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      s.append(e);
      return e;
    };
    if (window && window <= top) ns("line", { x1: 0, x2: W, y1: y(window), y2: y(window), class: "win" });
    const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.tokens).toFixed(1)}`);
    if (series.length > 1) {
      ns("path", { d: `M${pts[0]} L${pts.slice(1).join(" L")} L${x(series.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`, class: "area" });
      ns("polyline", { points: pts.join(" "), class: "line" });
    }
    // the marker is a dot over the stretched svg, so it stays round
    const i = series.findIndex((p) => p.id === at);
    if (i >= 0) {
      const dot = el("span", "at");
      dot.style.left = (x(i) / W * 100).toFixed(2) + "%";
      dot.style.top = (y(series[i].tokens) / H * 100).toFixed(2) + "%";
      box.append(dot);
    }
    return box;
  }

  // Narrow layouts go by the card's own width, as classes (max520), not
  // container queries: WebKit pulled a view scrolled to its end up by a
  // card's height on each redraw (#1249). A redrawn card starts at the last
  // width in its place, so it never lays out wide and pulls the page up
  const cardWidth = {};
  const sizeCard = (card, w) => {
    card.classList.toggle("max520", w <= 520);
    card.classList.toggle("max420", w <= 420);
    card.classList.toggle("max720", w <= 720);
  };
  const cardSizes = new ResizeObserver((all) => {
    for (const e of all) {
      if (!e.target.isConnected) { cardSizes.unobserve(e.target); continue; }
      const card = e.target, w = e.contentRect.width;
      if (!w) continue; // out of sight (#4652)
      cardWidth[card.dataset.place] = w;
      // on the next frame: a class changed in the observer's own call
      // changes the card's height, which WebKit reports as a
      // ResizeObserver loop (see quotaFit)
      requestAnimationFrame(() => sizeCard(card, w));
    }
  });

  // morph makes old what neu is, keeping old's nodes of the same kind: a
  // redrawn card is patched in place (Zhenzhen on Discord: each live
  // request flashed the whole card). Only handlers set as properties come
  // along, so nothing morphed uses addEventListener.
  const HANDLERS = ["onclick", "onpointerenter", "onpointerleave", "onkeydown"];
  function morph(old, neu) {
    if (old.nodeName !== neu.nodeName || (old.nodeType !== 1 && old.nodeType !== 3)) { old.replaceWith(neu); return neu; }
    if (old.nodeType === 3) { if (old.data !== neu.data) old.data = neu.data; return old; }
    // a count (data-n) is counted on from what it said to the new one
    const from = old._at ?? (old.dataset?.n ? +old.dataset.n : undefined);
    for (const a of [...old.attributes]) if (!neu.hasAttribute(a.name)) old.removeAttribute(a.name);
    for (const a of neu.attributes) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
    for (const h of HANDLERS) if (old[h] !== neu[h]) old[h] = neu[h];
    morphKids(old, [...neu.childNodes]);
    if (neu.dataset?.n) roll(old, from, +neu.dataset.n, fmtK, calm());
    return old;
  }
  // roll counts node's text from one number to another as the bar's parts
  // glide, in their time; fmt says a number. quiet, or with nothing to
  // count from, it says the new one at once
  function roll(node, from, to, fmt, quiet) {
    cancelAnimationFrame(node._raf);
    if (quiet || from === undefined || from === to || !node.isConnected) {
      delete node._at;
      if (node.textContent !== fmt(to)) node.textContent = fmt(to);
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      // a frame's time can be before t0 (it is when the frame began)
      const k = Math.min(1, Math.max(0, (now - t0) / 620));
      node._at = from + (to - from) * (1 - Math.pow(1 - k, 4));
      node.textContent = fmt(node._at);
      if (k < 1) node._raf = requestAnimationFrame(step);
      else delete node._at;
    };
    step(t0);
  }
  function morphKids(box, kids) {
    const old = [...box.childNodes];
    kids.forEach((k, i) => { if (i < old.length) morph(old[i], k); else box.append(k); });
    for (let i = kids.length; i < old.length; i++) old[i].remove();
  }

  // ---------- the card ----------

  // The parts that fill the prompt are drawn one of two ways, the
  // reader's pick: a bar of the parts side by side (the default), or a
  // block for each part listing its largest items
  let ctxLook = "bar";
  try { if (localStorage.getItem("magpie.ctxLook") === "blocks") ctxLook = "blocks"; } catch {}

  // compacted says a prompt is a compaction of the one before it, as
  // context.go's compacted tells it, to the token (Go's prev*6/10 is whole)
  const compacted = (prev, next) => prev >= 20000 && next < Math.floor(prev * 6 / 10);
  // the median a request adds to the one before it, as context.go's
  // Growth: a compaction adds nothing
  function growth(series) {
    const steps = [];
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1].tokens, d = series[i].tokens - prev;
      if (!compacted(prev, series[i].tokens) && d > 0) steps.push(d);
    }
    return median(steps);
  }
  // 0 to a round top in three or four steps
  function ticksTo(top) {
    const rough = Math.max(top, 1) / 3, mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough);
    const n = Math.max(1, Math.ceil(top / step - 1e-9));
    return Array.from({ length: n + 1 }, (_, i) => i * step);
  }
  const SVGNS = "http://www.w3.org/2000/svg";

  // ctxCard draws a route's prompt. opts: series (the session's prompts,
  // [{id, tokens, time}]), onPoint (a point of it opened), cache ({read,
  // total}, when the route carries no usage), crumbs (the footer's path),
  // place (where it is drawn, for its width: see cardWidth), tab and onTab
  // (the part the contents show). The card's ctxUpdate(r, opts) draws
  // another route, or the same one further on, in it: what is the same
  // stays the same nodes, so nothing flashes or comes in again.
  // a card that folds (Routing's, opts.foldable) keeps the reader's
  // choice: folded, it is its head alone, with how full the window is
  // beside the title, so the request list under it has the room
  // (0xBCD18E on X: it took most of the height, three rows were left)
  let ctxShut = false;
  try { ctxShut = localStorage.getItem("magpie.ctxShut") === "1"; } catch {}
  // opts.open: this request was opened to see its context window (the
  // Usage page's Context tab), so it shows unfolded, it alone: the next
  // request drawn in the card takes the reader's choice again
  // a window as a thin bar, a part each
  function stackBar(p) {
    const w = p.window || 0, bar = el("span", "ctx-stack"), scale = Math.max(w, p.tokens, 1);
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", t("{used} of {window} tokens used", { used: fmtK(p.tokens), window: fmtK(w || p.tokens) }));
    for (const k of PARTS) {
      const i = el("i", "k-" + k), n = (p.parts || []).find((x) => x.kind === k)?.tokens || 0;
      i.title = partName(k);
      i.style.width = +(Math.max(0, n) / scale * 100).toFixed(2) + "%";
      bar.append(i);
    }
    return bar;
  }
  window.ctxStack = stackBar;
  function ctxCard(r, opts = {}) {
    const card = el("div", "ctx-card" + (opts.foldable && ctxShut && !opts.open ? " shut" : ""));
    card.dataset.place = opts.place || "";
    if (cardWidth[card.dataset.place] !== undefined) sizeCard(card, cardWidth[card.dataset.place]);
    cardSizes.observe(card);

    // what stays across draws: the parts' bar and blocks, the section
    // heads, the contents, the session's curve and the tip
    const sec = el("div", "ctx-sec");
    const viz = el("div", "ctx-viz");
    viz.dataset.look = ctxLook;
    const bar = el("div", "ctx-segbar");
    bar.setAttribute("role", "img");
    const blocks = el("div", "ctx-blocks");
    viz.append(bar, blocks);
    const legend = el("div", "ctx-legend");
    legend.setAttribute("role", "group");
    legend.setAttribute("aria-label", t("Composition"));
    const tip = el("div", "ctx-tip");
    tip.hidden = true;
    const contents = el("div", "ctx-contents"), ch = el("div", "ctx-contents-head"), list = el("div", "ctx-rows");
    contents.append(ch, list);
    const cv = el("div", "ctx-curve");
    const cols = el("div", "ctx-cols");
    cols.append(contents);
    let parts = null, cur = null, cacheShown = false, lastCache = null, cacheWhose = "", secKey = "", rid = 0;
    let tab = opts.tab || "all", more = false, onTab = opts.onTab;
    // the part whose tip is open: a live request redrawn under the pointer
    // tells it again, over it
    let tipOf = "";

    // the tip over what it tells of, or under it where there's no room
    const placeTip = (target) => {
      tip.hidden = false;
      const b = target.getBoundingClientRect(), cr = card.getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let left = b.left - cr.left + b.width / 2 - w / 2;
      left = Math.max(8, Math.min(cr.width - w - 8, left));
      let topY = b.top - cr.top - h - 8;
      if (topY < 4) topY = b.bottom - cr.top + 8;
      tip.style.left = left + "px";
      tip.style.top = topY + "px";
    };
    // a part's tip: its tokens and share, its largest items
    const partTip = (kind, target) => {
      const part = cur.partOf.get(kind);
      if (!part) return;
      tipOf = kind;
      cvTip = 0;
      tip.replaceChildren();
      const th = el("div", "ctx-tip-head");
      th.append(el("i", "dot k-" + kind), el("b", "", partName(kind)), el("span", "grow"),
        el("span", "", fmtK(part.tokens) + " · " + pct(part.tokens / Math.max(1, cur.p.tokens))));
      tip.append(th);
      const items = [...(part.items || [])].sort((a, b) => b.tokens - a.tokens);
      for (const it of items.slice(0, 4)) {
        const row = el("div", "ctx-tip-row");
        row.append(el("span", "n", itemName(it)), el("span", "v", fmtK(it.tokens)));
        tip.append(row);
      }
      if (items.length > 4) tip.append(el("div", "ctx-tip-more", t("{n} more", { n: items.length - 4 })));
      placeTip(target);
    };
    bar.addEventListener("pointerover", (e) => {
      const s = e.target.closest?.(".ctx-seg");
      if (cur && s && s.parentElement === bar) { partTip(s.dataset.k, s); light(s.dataset.k); }
    });
    bar.addEventListener("pointerleave", () => { tipOf = ""; tip.hidden = true; light(""); });

    // pick shows one part alone, in the bar, the blocks and the contents;
    // the part picked again, or All, shows them all
    const pick = (k) => {
      tab = tab === k ? "all" : k;
      more = false;
      tipOf = "";
      tip.hidden = true;
      onTab?.(tab);
      drawParts();
      drawRows();
    };
    // a part an item of the contents is in, lit in the bar and the blocks
    const light = (kind) => {
      if (kind) viz.dataset.over = kind;
      else delete viz.dataset.over;
      for (const n of viz.querySelectorAll(".ctx-seg, .ctx-block")) n.classList.toggle("over", n.dataset.k === kind);
    };

    // fitSegs says in each of the bar's parts what fits: its name and
    // tokens, its tokens, or nothing (its tip and the tags say it). Every
    // width is read before any class is set, so the bar is laid out once
    const fitSegs = () => {
      const segs = [...bar.children].filter((s) => s.children.length > 1);
      const fit = segs.map((s) => {
        const [n, v] = s.children, room = s.clientWidth - 20;
        return n.offsetWidth + v.offsetWidth + 6 <= room ? "" : v.offsetWidth <= room ? "short" : "bare";
      });
      segs.forEach((s, i) => {
        s.classList.toggle("short", fit[i] === "short");
        s.classList.toggle("bare", fit[i] === "bare");
      });
    };
    bar.addEventListener("transitionend", (e) => {
      if (e.target.parentElement !== bar) return;
      fitSegs();
      const s = tipOf && bar.querySelector(`.ctx-seg[data-k="${tipOf}"]`);
      if (s) placeTip(s);
    });
    new ResizeObserver(() => { if (bar.isConnected) fitSegs(); }).observe(bar);

    // the bar, the blocks and the tags: the parts of the prompt
    const drawParts = () => {
      const { p, partOf } = cur;
      const shown = PARTS.map((k) => partOf.get(k)).filter((x) => x && x.tokens > 0);
      const total = Math.max(1, shown.reduce((s, x) => s + x.tokens, 0));
      const dim = (k) => tab !== "all" && tab !== k;
      bar.setAttribute("aria-label", shown.map((x) => partName(x.kind) + " " + fmtK(x.tokens) + " (" + pct(x.tokens / total) + ")").join(", "));
      morphKids(bar, shown.map((x) => {
        const s = el("div", "ctx-seg k-" + x.kind + (dim(x.kind) ? " dim" : "") + (viz.dataset.over === x.kind ? " over" : ""));
        s.dataset.k = x.kind;
        // a part of any size can be pointed at
        s.style.flexGrow = Math.max(x.tokens / total, 0.012).toFixed(4);
        s.append(el("span", "n", partName(x.kind)), num("span", "v", x.tokens));
        s.onclick = (e) => { e.stopPropagation(); pick(x.kind); };
        return s;
      }));
      requestAnimationFrame(fitSegs);

      morphKids(blocks, shown.map((x) => {
        const b = el("div", "ctx-block k-" + x.kind + (dim(x.kind) ? " dim" : "") + (tab === x.kind ? " on" : "") + (viz.dataset.over === x.kind ? " over" : ""));
        b.dataset.k = x.kind;
        b.style.flexGrow = (x.tokens / total).toFixed(4);
        const h = el("button", "ctx-block-h");
        h.type = "button";
        h.setAttribute("aria-pressed", String(tab === x.kind));
        h.append(el("i", "dot k-" + x.kind), el("b", "", partName(x.kind)), el("span", "grow"), num("span", "v", x.tokens));
        h.onclick = (e) => { e.stopPropagation(); pick(x.kind); };
        b.append(h);
        const items = [...(x.items || [])].sort((a, b) => b.tokens - a.tokens);
        for (const it of items.slice(0, 4)) {
          const row = el("button", "ctx-block-r");
          row.type = "button";
          const name = itemName(it);
          const n = el("span", "n", (x.kind === "files" || x.kind === "memory") && name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name);
          n.title = name;
          row.append(n, el("span", "v", fmtK(it.tokens)));
          row.onclick = (e) => { e.stopPropagation(); openCtxText(rid, x.kind, it); };
          b.append(row);
        }
        const rest = items.slice(4);
        if (rest.length) b.append(el("div", "ctx-block-more", t("{n} more", { n: rest.length }) + " · " + fmtK(rest.reduce((s, it) => s + it.tokens, 0))));
        return b;
      }));

      // the tags: the bar's legend, and what the contents show
      const tag = (k, name, n, dot) => {
        const b = el("button", "ctx-leg" + (tab === k ? " on" : ""));
        b.type = "button";
        b.dataset.k = k;
        b.setAttribute("aria-pressed", String(tab === k));
        if (PART_NOTES[k]) b.title = t(PART_NOTES[k]);
        b.append(dot, el("span", "n", name), num("span", "v", n));
        if (k !== "all") b.append(el("span", "s", pct(n / Math.max(1, p.tokens))));
        b.onclick = (e) => { e.stopPropagation(); if (k !== "all") pick(k); else if (tab !== "all") pick(tab); };
        if (k !== "all") { b.onpointerenter = () => light(k); b.onpointerleave = () => light(""); }
        return b;
      };
      morphKids(legend, [tag("all", t("All"), p.tokens, el("i", "dot all")), ...shown.map((x) => tag(x.kind, partName(x.kind), x.tokens, el("i", "dot k-" + x.kind)))]);
    };

    // setLook shows the bar or the blocks, the reader's pick for every card
    const setLook = (k) => {
      if (viz.dataset.look === k) return;
      ctxLook = k;
      try { localStorage.setItem("magpie.ctxLook", k); } catch {}
      tipOf = "";
      tip.hidden = true;
      viz.dataset.look = k;
      if (k === "bar") requestAnimationFrame(fitSegs);
    };

    // the contents: every item, or one part's, largest first
    const drawRows = () => {
      const { partOf, p } = cur;
      let rows;
      if (tab === "all") rows = p.parts.flatMap((x) => (x.items || []).map((it) => ({ it, kind: x.kind })));
      else rows = (partOf.get(tab)?.items || []).map((it) => ({ it, kind: tab }));
      rows.sort((a, b) => b.it.tokens - a.it.tokens);
      const head = [el("span", "ctx-k", t("Contents") + " · " + (tab === "all" ? t("All") : partName(tab))), el("span", "grow")];
      // a part shown alone opens to its text, every item of it
      if (tab !== "all" && rows.length) {
        const open = el("button", "text ctx-open", t("Open its text"));
        open.type = "button";
        open.onclick = (e) => { e.stopPropagation(); openCtxText(rid, tab); };
        head.push(open);
      }
      head.push(el("span", "ctx-count", t("{n} items, by size", { n: rows.length })));
      morphKids(ch, head);
      const most = Math.max(1, ...rows.map((x) => x.it.tokens));
      const n = more ? rows.length : Math.min(rows.length, 8);
      const out = rows.slice(0, n).map(({ it, kind }) => {
        const row = el("div", "ctx-row");
        const tg = tagOf(it);
        const mini = el("span", "ctx-mini");
        const b = el("i", "k-" + kind);
        b.style.width = Math.max(2, (it.tokens / most) * 100).toFixed(1) + "%";
        mini.append(b);
        row.append(el("i", "dot k-" + kind), itemLabel(it, kind));
        if (it.n > 1 && it.tag !== "turns" && it.tag !== "more") row.append(el("span", "ctx-x", "×" + it.n));
        if (tg) row.append(el("code", "ctx-tag", tg));
        row.append(mini, el("span", "ctx-v", fmtK(it.tokens)));
        // clicked, its text
        clickable(row, () => openCtxText(rid, kind, it));
        row.onpointerenter = () => light(kind);
        row.onpointerleave = () => light("");
        return row;
      });
      if (!rows.length) out.push(el("div", "ctx-empty", t("Nothing in it")));
      if (rows.length > 8) {
        const b = el("button", "text ctx-more", more ? t("Show fewer") : t("Show all {n}", { n: rows.length }));
        b.type = "button";
        b.onclick = () => { more = !more; drawRows(); };
        out.push(b);
      }
      morphKids(list, out);
    };

    // the session's prompts, a point a request, on a scale of its own;
    // its compactions marked. A point pointed at or focused says its
    // request in the tip and the line under the plot; clicked, it stays
    // said there, with a button to open it. The points are one tab stop,
    // the arrows going from one to the next.
    // Live, the request under way grows on every tick: the same points are
    // painted again where they are, so one pointed at, focused or pinned
    // stays so, its tip open. A request come or gone draws them anew, and
    // the reader is put back on the request they were on
    let cvPin = 0, cvAt = 0, cvTip = 0, cvKey = "", cvData = "", cvIds = [], cvGo = null, cvPaint = null;
    const drawCurve = (series, at, window, onPoint) => {
      cvGo = onPoint;
      const key = JSON.stringify([document.documentElement.lang, at, !!onPoint, series.map((x) => x.id).join()]);
      const data = window + ":" + series.map((x) => x.tokens).join();
      if (key === cvKey) {
        if (data !== cvData) { cvData = data; cvPaint(series, window); }
        return;
      }
      // the request the reader is on, to put them back on it
      const a = document.activeElement;
      const focused = a?.classList?.contains("ctx-cv-hit") && cv.contains(a) ? cvIds[[...a.parentNode.children].indexOf(a)] : 0;
      const told = !tip.hidden && cvTip;
      cvKey = key;
      cvData = data;
      cvIds = series.map((x) => x.id);
      // a point the reader pinned stays pinned; the request drawn, pinned
      // as it was, gives way to the one drawn now
      if (cvAt !== at) { if (cvPin === cvAt) cvPin = at; cvAt = at; }
      if (!series.some((x) => x.id === cvPin)) cvPin = at;

      const n = series.length;
      const X = (i) => n < 2 ? 50 : (i / (n - 1)) * 100;
      let S = series, Y = null;
      const note = el("span", "ctx-count");
      const head = el("div", "ctx-curve-head");
      head.append(el("span", "ctx-k", t("This session, request by request")), el("span", "grow"), note);
      const plot = el("div", "ctx-plot");
      const s = document.createElementNS(SVGNS, "svg");
      s.setAttribute("viewBox", "0 0 100 100");
      s.setAttribute("preserveAspectRatio", "none");
      s.setAttribute("aria-hidden", "true");
      const ns = (tag, attrs) => {
        const e = document.createElementNS(SVGNS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        s.append(e);
        return e;
      };
      // the axis's figures and the marks' words, painted with the lines
      const words = el("span", "ctx-cv-words");
      const guide = el("i", "ctx-cv-guide"), dot = el("i", "ctx-cv-dot"), now = el("i", "ctx-cv-now");
      // the x axis: the first request, the middle one and the last
      const xs = el("div", "ctx-cv-xs");
      for (const i of [...new Set([0, n > 2 ? Math.round((n - 1) / 2) : -1, n - 1])].filter((i) => i >= 0)) {
        const lab = el("span", i === 0 ? "start" : i === n - 1 ? "end" : "", i === 0 ? t("Request {n}", { n: 1 }) : String(i + 1));
        lab.style.left = X(i) + "%";
        xs.append(lab);
      }

      const read = el("div", "ctx-cv-read");
      const say = (i) => {
        const x = S[i], d = i ? x.tokens - S[i - 1].tokens : 0;
        const cut = i > 0 && compacted(S[i - 1].tokens, x.tokens);
        const when = t("Request {n}", { n: i + 1 }) + (x.id === at ? " · " + t("this one") : "");
        const step = !i ? "" : cut ? t("Compacted") + " · −" + fmtK(-d) : (d >= 0 ? "+" : "−") + fmtK(Math.abs(d));
        return { when, value: fmtK(x.tokens) + " " + t("tokens"), step };
      };
      // the line is changed in place: a point's blur as the button is
      // pressed would otherwise take the button away under the click
      const rv = el("b"), rw = el("span");
      const go = el("button", "text ctx-cv-open", t("Open this request"));
      go.type = "button";
      read.append(rv, rw, el("span", "grow"), go);
      const mark = (i) => {
        guide.style.left = dot.style.left = X(i) + "%";
        dot.style.top = Y(S[i].tokens) + "%";
        const w = say(i);
        rv.textContent = w.value;
        rw.textContent = w.when + (w.step ? " · " + w.step : "");
        go.hidden = !cvGo || S[i].id === at;
        go.onclick = (e) => { e.stopPropagation(); cvGo?.(S[i]); };
      };
      const pinned = () => Math.max(0, S.findIndex((x) => x.id === cvPin));
      // show says point i in the tip; hide closes it, the line under the
      // plot back on the point pinned
      const show = (i) => {
        tipOf = "";
        cvTip = S[i].id;
        plot.dataset.hover = "";
        mark(i);
        const w = say(i);
        tip.replaceChildren();
        const th = el("div", "ctx-tip-head");
        th.append(el("b", "", w.value), el("span", "grow"));
        tip.append(th, el("div", "ctx-tip-sub", w.when + (w.step ? " · " + w.step : "")));
        placeTip(dot);
      };
      const hide = () => {
        if (cvTip) { cvTip = 0; tip.hidden = true; }
        delete plot.dataset.hover;
        mark(pinned());
      };

      // the points: one tab stop, on the point last focused or pinned
      const hits = el("div", "ctx-cv-hits");
      hits.setAttribute("role", "group");
      hits.setAttribute("aria-label", t("This session, request by request"));
      const half = n < 2 ? 50 : 50 / (n - 1);
      const hs = series.map((x, i) => {
        const b = el("button", "ctx-cv-hit");
        b.type = "button";
        const l = Math.max(0, X(i) - half), r = Math.min(100, X(i) + half);
        b.style.left = l + "%";
        b.style.width = (r - l) + "%";
        b.onpointerenter = () => show(i);
        b.onfocus = () => { rove(i); show(i); };
        b.onblur = hide;
        b.onclick = (e) => { e.stopPropagation(); cvPin = S[i].id; rove(i); mark(i); };
        b.onkeydown = (e) => {
          // Escape unpins, back on the request drawn
          if (e.key === "Escape") {
            if (cvPin === at && tip.hidden) return;
            e.preventDefault();
            e.stopPropagation();
            cvPin = at;
            hide();
            return;
          }
          const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          hs[Math.max(0, Math.min(n - 1, to))].focus();
        };
        return b;
      });
      const rove = (i) => hs.forEach((b, j) => { b.tabIndex = j === i ? 0 : -1; });
      hits.append(...hs);
      hits.onpointerleave = hide;
      plot.append(s, words, guide, now, dot, xs, hits);

      // paint lays the figures out: the scale, the lines, the marks, each
      // point's label and what is said
      const paint = (ser, win) => {
        S = ser;
        const peak = Math.max(...ser.map((x) => x.tokens), 1);
        // the window's line shows once the session comes near it
        const near = win && peak > win * 0.6;
        const ticks = ticksTo(near ? Math.max(win, peak) : peak * 1.08);
        const top = ticks[ticks.length - 1];
        Y = (v) => 100 - (v / top) * 100;
        note.textContent = !win ? t("Window unknown") : near ? "" : t("The {window} window is far above", { window: fmtK(win) });
        s.replaceChildren();
        words.replaceChildren();
        for (const v of ticks) {
          ns("line", { x1: 0, x2: 100, y1: Y(v), y2: Y(v), class: v ? "grid" : "base" });
          const lab = el("span", "ctx-cv-y", fmtK(v));
          lab.style.top = Y(v) + "%";
          words.append(lab);
        }
        const wy = near ? Y(win) : 100;
        if (near) {
          ns("line", { x1: 0, x2: 100, y1: wy, y2: wy, class: "win" });
          const lab = el("span", "ctx-cv-win", t("Window {window}", { window: fmtK(win) }));
          lab.style.top = wy + "%";
          words.append(lab);
        }
        const pts = ser.map((x, i) => X(i).toFixed(2) + " " + Y(x.tokens).toFixed(2));
        if (n > 1) {
          ns("path", { d: "M" + pts.join(" L") + ` L${X(n - 1)} 100 L0 100 Z`, class: "area" });
          ns("path", { d: "M" + pts.join(" L"), class: "line" });
        }
        // a compaction: a dashed line where the prompt fell, and its word
        // at the plot's top; under the window's line when that is in the
        // top 16% (24px of 150), as the window's word over the line would
        // lie on it
        ser.forEach((x, i) => {
          if (!i || !compacted(ser[i - 1].tokens, x.tokens)) return;
          ns("line", { x1: X(i), x2: X(i), y1: 0, y2: 100, class: "cut" });
          const lab = el("span", "ctx-cv-cut" + (X(i) > 75 ? " end" : ""), t("Compacted"));
          lab.style.left = X(i) + "%";
          if (wy < 16) lab.style.top = `calc(${wy}% + 4px)`;
          words.append(lab);
        });
        const ai = Math.max(0, ser.findIndex((x) => x.id === at));
        now.style.left = X(ai) + "%";
        now.style.top = Y(ser[ai].tokens) + "%";
        hs.forEach((b, i) => b.setAttribute("aria-label", t("Request {n}: {tokens} tokens", { n: i + 1, tokens: fmtK(ser[i].tokens) })));
        // what is said is said again, from the new figures
        const ti = cvTip && !tip.hidden ? ser.findIndex((x) => x.id === cvTip) : -1;
        if (ti >= 0) show(ti);
        else mark(pinned());
      };
      cvPaint = paint;
      cvTip = 0;
      cv.replaceChildren(head, plot, read);
      paint(series, window);
      rove(pinned());
      // the reader put back: on the point they had focused (or, gone, the
      // one pinned), or its tip open again
      if (focused) {
        const fi = series.findIndex((x) => x.id === focused);
        hs[fi >= 0 ? fi : pinned()].focus({ preventScroll: true });
      } else if (told) {
        const ti = series.findIndex((x) => x.id === told);
        if (ti >= 0) show(ti);
        else tip.hidden = true;
      }
    };

    const fill = (r, o) => {
      opts = o;
      onTab = o.onTab;
      const p = r.prompt;
      if (!p) {
        card.replaceChildren();
        parts = cur = null;
        return;
      }
      rid = r.id;
      const window = p.window || 0;
      const full = window ? p.tokens / window : 0;
      const live = !r.done;
      const series = o.series && o.series.length > 1 ? o.series : null;

      // the head: what it is and how it was counted
      if (o.foldable) card.classList.toggle("shut", ctxShut && !o.open);
      const head = el("div", "ctx-head");
      let title = el("span", "ctx-title", t("Context window"));
      if (o.foldable) {
        const fold = el("button", "ctx-fold");
        fold.type = "button";
        fold.setAttribute("aria-expanded", String(!card.classList.contains("shut")));
        const tw = el("span", "tw");
        tw.append(svg(CHEV, 10, 1.7));
        fold.append(tw, title);
        // the head is morphed, so the button that is there is the target
        fold.onclick = (e) => {
          ctxShut = !card.classList.contains("shut");
          card.classList.toggle("shut", ctxShut);
          tipOf = "";
          tip.hidden = true;
          e.currentTarget.setAttribute("aria-expanded", String(!ctxShut));
          try { localStorage.setItem("magpie.ctxShut", ctxShut ? "1" : "0"); } catch {}
          opts.onFold?.(ctxShut);
        };
        title = fold;
      }
      // the state's words are all there, one shown: the pill is as wide as
      // the widest in any language, so the model beside it doesn't move as
      // a request goes from Live to Counted (dumplings on Discord: each
      // request made the card jitter)
      const state = live ? "live" : p.counted ? "counted" : "est";
      const st = el("span", "ctx-state " + state);
      const words = el("span", "ctx-state-w");
      for (const [k, w] of [["live", "Live"], ["counted", "Counted"], ["est", "Estimated"]]) {
        const word = el("span", k === state ? "on" : "", t(w));
        if (k !== state) word.setAttribute("aria-hidden", "true");
        words.append(word);
      }
      st.append(el("i"), words);
      st.title = t(live ? "The request is on its way: the prompt is estimated from what the agent sent"
        : p.counted ? "As many tokens as the vendor counted; the parts are measured from the request and scaled to it"
        : "Estimated from what the agent sent: the vendor didn't say how many tokens it read");
      head.append(title);
      if (o.foldable) {
        const short = el("span", "ctx-short");
        short.append(num("span", "", p.tokens), window ? " / " + fmtK(window) + " · " + pct(full) : "");
        head.append(short);
        // folded, the bar: morphed, so a live request moves widths only
        head.append(stackBar(p));
      }
      head.append(el("span", "grow"));
      // whose request it is and the model it went to; in a narrow card the
      // agent's name goes first, its icon stays
      const route = el("span", "ctx-route");
      if (r.agent) {
        const who = el("span", "ctx-who");
        who.append(agentIcon(r.agent), el("span", "ctx-who-n", agentLabel(r.agent)));
        route.append(who);
      }
      if (r.model) {
        const what = el("span", "ctx-what");
        what.append(...labIcon(r.model), el("code", "ctx-model", r.model));
        if (r.agent) route.append(el("span", "ctx-sep", "›"));
        route.append(what);
      }
      head.append(route);
      head.append(st);

      // three figures side by side: how full, the cache, the session
      const top = el("div", "ctx-top");
      const used = el("div", "ctx-stat ctx-used");
      const k = el("div", "ctx-k");
      k.append(el("span", "", t("Context used")));
      let tone = "";
      if (window) {
        const [tn, word] = health(full);
        tone = tn;
        k.append(el("span", "ctx-health " + tone, t(word)));
      }
      const big = el("div", "ctx-big");
      big.append(num("b", "", p.tokens));
      big.append(el("span", "", window ? "/ " + fmtK(window) + " " + t("tokens") : t("tokens")));
      used.append(k, big);
      if (window) {
        const fillBar = el("div", "ctx-bar " + tone);
        const i = el("i");
        i.style.width = Math.min(100, full * 100).toFixed(1) + "%";
        fillBar.append(i);
        used.append(fillBar);
      }
      const sub = el("div", "ctx-sub");
      if (window) {
        const bits = [t("{pct} full", { pct: pct(full) })];
        const turns = o.series ? headroom(o.series, Math.max(0, window - p.tokens)) : null;
        if (turns !== null) bits.push(turns >= 999 ? t("plenty of headroom") : t("~{n} requests of headroom", { n: turns }));
        else bits.push(t("{tokens} free", { tokens: fmtK(Math.max(0, window - p.tokens)) }));
        sub.textContent = bits.join(" · ");
      } else sub.textContent = t("the model's window isn't known");
      used.append(sub);
      top.append(used);

      const cache = cacheOf(r) || o.cache;
      // another agent or session drawn in the card has no last request's
      // cache to show: its place stays, with a dash till it is read
      const whose = r.agent + " " + (o.series?.[0]?.id ?? "");
      if (whose !== cacheWhose) lastCache = null;
      cacheWhose = whose;
      const known = cache && p.counted !== false ? cache : null;
      if (known || cacheShown) {
        // once shown, the cache keeps its place, so nothing under it moves
        // up and back down. A request under way has read no cache yet:
        // the last request's stays, dimmed and named as the last one's,
        // until this one's answer says (dumplings on Discord: each new
        // request flashed it to "—" and an empty bar, the dash against
        // 命中). Nothing to show is said in words, with no bar
        const shown = known || (live ? lastCache : null);
        const c = el("div", "ctx-stat ctx-cache" + (!known && shown ? " was" : shown ? "" : " none"));
        c.append(el("div", "ctx-k", t("Prompt cache")));
        const cb = el("div", "ctx-big");
        cb.append(el("b", "", shown ? pct(shown.read / shown.total) : "—"), el("span", "", t("hit")));
        const cbar = el("div", "ctx-bar");
        const fillBar = el("i");
        fillBar.style.width = (shown ? (shown.read / shown.total) * 100 : 0).toFixed(1) + "%";
        cbar.append(fillBar);
        c.append(cb, cbar, el("div", "ctx-sub", known ? t("{cached} cached · {fresh} new", { cached: fmtK(known.read), fresh: fmtK(known.total - known.read) })
          : shown ? t("The last request's · this one is on its way")
          : live ? t("Read once the vendor answers") : t("The vendor didn't say")));
        top.append(c);
        cacheShown = true;
        if (known) lastCache = known;
      }

      // the session: which request this is, its peak, its compactions
      // and what a request adds
      if (series) {
        const at = series.findIndex((x) => x.id === r.id);
        const s = el("div", "ctx-stat ctx-run");
        s.append(el("div", "ctx-k", t("This session")));
        const sb = el("div", "ctx-big");
        sb.append(el("b", "", String(at < 0 ? series.length : at + 1)), el("span", "", t("/ {n} requests", { n: series.length })));
        let pk = 0, cuts = 0;
        series.forEach((x, i) => {
          if (x.tokens > series[pk].tokens) pk = i;
          if (i && compacted(series[i - 1].tokens, x.tokens)) cuts++;
        });
        const bits = [t("Peak {tokens} (request {n})", { tokens: fmtK(series[pk].tokens), n: pk + 1 })];
        if (cuts) bits.push(count(cuts, "1 compaction", "{n} compactions"));
        const g = growth(series);
        if (g > 0) bits.push(t("+{tokens} a request", { tokens: fmtK(g) }));
        s.append(sb, el("div", "ctx-sub", bits.join(" · ")));
        top.append(s);
      }

      cur = { p, window, partOf: new Map(p.parts.map((x) => [x.kind, x])) };
      if (!PARTS.some((k) => cur.partOf.get(k)?.tokens > 0) || (tab !== "all" && !(cur.partOf.get(tab)?.tokens > 0))) { tab = "all"; more = false; }

      // the parts' head: its name, and the look
      const sk = JSON.stringify([document.documentElement.lang, viz.dataset.look]);
      if (sk !== secKey) {
        secKey = sk;
        sec.replaceChildren(el("span", "ctx-k", t("Composition")), el("span", "ctx-hint", t("Click a part or a tag to see only that kind")), el("span", "grow"),
          segs([["bar", t("Segmented bar")], ["blocks", t("By kind")]], viz.dataset.look, (k) => { setLook(k); secKey = JSON.stringify([document.documentElement.lang, k]); }));
      }
      drawParts();
      drawRows();

      // the session's curve beside the contents
      if (series) {
        drawCurve(series, r.id, window, o.onPoint);
        if (cv.parentNode !== cols) cols.append(cv);
      } else if (cv.parentNode === cols) {
        cv.remove();
        cvKey = "";
        if (cvTip) { cvTip = 0; tip.hidden = true; }
      }
      cols.classList.toggle("two", !!series);
      const ts = tipOf && viz.dataset.look === "bar" && bar.querySelector(`.ctx-seg[data-k="${tipOf}"]`);
      if (ts) partTip(tipOf, ts);
      else if (tipOf) { tipOf = ""; tip.hidden = true; }

      // the foot: where it is
      const foot = el("div", "ctx-foot");
      const crumbs = el("code", "ctx-crumbs");
      crumbs.textContent = (o.crumbs || [agentLabel(r.agent)]).filter(Boolean).join(" › ");
      const notes = [];
      if (p.held) notes.push(t("Earlier turns are held by the vendor"));
      if (p.turns) notes.push(count(p.turns, "1 turn", "{n} turns"));
      foot.append(crumbs, el("span", "grow"));
      if (notes.length) foot.append(el("span", "ctx-note", notes.join(" · ")));

      if (!parts) {
        parts = { head, top, foot };
        card.append(head, top, sec, viz, legend, cols, foot, tip);
        return;
      }
      for (const key of ["head", "top", "foot"]) parts[key] = morph(parts[key], { head, top, foot }[key]);
    };
    card.ctxUpdate = fill;
    fill(r, opts);
    return card;
  }
  window.ctxCard = ctxCard;

  // clickable makes e a button for the keyboard too, its handlers set as
  // properties, so a morphed card keeps them
  function clickable(e, go) {
    e.setAttribute("role", "button");
    e.tabIndex = 0;
    e.classList.add("ctx-click");
    e.onclick = (ev) => { ev.stopPropagation(); go(); };
    e.onkeydown = (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      go();
    };
  }

  // ---------- the text of a part (masaka on Discord) ----------

  // A part of the card clicked opens what the request sent there, read
  // from the request's body: an item alone (a tool, a file, a turn), or
  // the part's items, each opened to its text. magpie keeps the last few
  // requests' bodies, masked, in memory only, so an older one's text is
  // gone. A long text comes a stretch at a time, so a prompt of megabytes
  // doesn't hold the window up.
  // in ctxtext.js, loaded when a part is first opened
  const openCtxText = (...a) => import("./ctxtext.js").then((m) => m.open({ fmtK, partName, itemName, itemLabel, tagOf }, ...a)).catch(statusErr);
  window.openCtxText = openCtxText;
  window.ctxFmt = fmtK;

  // ---------- the Usage page's Context tab ----------

  const CTX_RANGES = [["1", "Today"], ["7", "7 days"], ["30", "30 days"]];
  let ctxDays = "7";
  try { const d = localStorage.getItem("magpie.ctxDays"); if (CTX_RANGES.some(([id]) => id === d)) ctxDays = d; } catch {}
  let ctxData = null, ctxJSON = "", ctxRead = 0, ctxOpen = "", ctxAgent = "all";
  // the days the pane shows "Reading…" for: a second read before the history
  // answers (the page opened, then the first state's refresh) leaves it be,
  // so the advice drawn meanwhile keeps its entrance
  let ctxWaiting = "";

  const SCORE_NAMES = { cache: "Cache", lean: "Lean start", pace: "Pace", reliable: "Reliability" };
  const SCORE_NOTES = {
    cache: "How much of its prompts the vendor read from its cache: full marks at 90%",
    lean: "What every request starts with — system prompt, tools, memory — against the window: full marks at 5% or less",
    pace: "How much a request adds to the one before it: full marks at 1% of the window or less",
    reliable: "Its requests that didn't fail: none at 20% failing",
  };
  const TAGS = {
    "cache-friendly": ["Cache-friendly", (v) => t("{pct} of its prompts were read from the vendor's cache", { pct: pct(v) })],
    "cache-misses": ["Cache misses", (v) => t("Only {pct} of its prompts were read from the cache: each request pays for most of its prompt again", { pct: pct(v) })],
    lean: ["Lean start", (v) => t("Every request starts with {tokens} of system prompt, tools and memory", { tokens: fmtK(v) })],
    "heavy-start": ["Heavy start", (v) => t("Every request starts with {tokens} of system prompt, tools and memory, before a word of yours", { tokens: fmtK(v) })],
    "mcp-heavy": ["MCP-heavy", (v) => t("MCP servers' tool definitions take {tokens} of every request", { tokens: fmtK(v) })],
    "tool-heavy": ["Tool-heavy", (v) => t("Tool results are {pct} of its prompts", { pct: pct(v) })],
    "file-reader": ["Reads files", (v) => t("Files it read are {pct} of its prompts", { pct: pct(v) })],
    "memory-heavy": ["Memory-heavy", (v) => t("Instruction files and memory are {pct} of its prompts", { pct: pct(v) })],
    "fills-fast": ["Fills fast", (v) => t("A request adds {tokens} to the one before it, the median", { tokens: fmtK(v) })],
    "near-full": ["Runs near full", (v) => t("A session reached {pct} of its window", { pct: pct(v) })],
    compacts: ["Compacts", (v) => t("Its context was compacted {n} times", { n: v })],
    steady: ["Steady", () => t("Fewer than 1% of its requests failed")],
    flaky: ["Flaky", (v) => t("{pct} of its requests failed", { pct: pct(v) })],
  };
  const grade = (s) => s >= 85 ? ["great", "Excellent"] : s >= 70 ? ["good", "Good"] : s >= 50 ? ["fair", "Fair"] : ["poor", "Needs care"];

  function ring(score) {
    const r = 26, c = 2 * Math.PI * r;
    const [tone] = grade(score);
    const box = el("div", "ctx-ring " + tone);
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 64 64");
    s.innerHTML = `<circle cx="32" cy="32" r="${r}" class="track"/><circle cx="32" cy="32" r="${r}" class="arc" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${c.toFixed(2)}" style="--to:${(c * (1 - score / 100)).toFixed(2)}"/>`;
    box.append(s, el("b", "", String(score)));
    return box;
  }

  function shareBar(shares) {
    const bar = el("div", "ctx-share");
    for (const k of PARTS) {
      const v = shares?.[k] || 0;
      if (v <= 0.002) continue;
      const i = el("i", "k-" + k);
      i.style.flexGrow = v;
      i.title = partName(k) + " · " + pct(v);
      bar.append(i);
    }
    return bar;
  }

  function agentCard(a) {
    const card = el("div", "ctx-agent");
    const head = el("div", "ctx-agent-head");
    const who = el("div", "ctx-who");
    who.append(agentIcon(a.agent), el("b", "", agentLabel(a.agent)));
    const cl = a.clients || [];
    const meta = el("div", "ctx-who-sub", [...(cl.length ? [cl.slice(0, 3).join(", ") + (cl.length > 3 ? " +" + (cl.length - 3) : "")] : []), count(a.requests, "1 request", "{n} requests"), count(a.sessions, "1 session", "{n} sessions")].join(" · "));
    if (cl.length) who.title = t("Requests whose User-Agent names only an HTTP library or an SDK, not an agent: {clients}", { clients: cl.join(", ") });
    const name = el("div", "ctx-who-box");
    name.append(who, meta);
    const [tone, word] = grade(a.score);
    const g = el("div", "ctx-grade");
    g.append(ring(a.score), el("span", "ctx-grade-word " + tone, t(word)));
    head.append(name, el("span", "grow"), g);

    const scores = el("div", "ctx-scores");
    for (const s of a.scores || []) {
      const r = s.most ? s.points / s.most : 0;
      const row = el("div", "ctx-score " + (r >= 0.8 ? "ok" : r >= 0.5 ? "warn" : "bad"));
      row.title = t(SCORE_NOTES[s.key] || "");
      const bar = el("span", "ctx-bar");
      const f = el("i");
      f.style.width = ((s.points / s.most) * 100).toFixed(1) + "%";
      bar.append(f);
      row.append(el("span", "n", t(SCORE_NAMES[s.key] || s.key)), bar, el("span", "v", `${s.points}/${s.most}`));
      scores.append(row);
    }

    const tags = el("div", "ctx-tags");
    for (const tg of a.tags || []) {
      const def = TAGS[tg.key];
      const chip = el("span", "ctx-chip " + tg.tone);
      chip.append(el("i"), def ? t(def[0]) : tg.key);
      chip.dataset.tt = def ? def[1](tg.value || 0) : tg.key;
      tags.append(chip);
    }

    const facts = el("div", "ctx-facts");
    const fact = (label, value, note) => {
      const f = el("div", "ctx-fact");
      f.append(el("span", "ctx-k", t(label)), el("b", "", value));
      if (note) f.dataset.tt = t(note);
      facts.append(f);
    };
    fact("Typical prompt", fmtK(a.median), "The median request's prompt");
    fact("Largest", fmtK(a.p90), "90% of its requests' prompts are this size or smaller");
    fact("Starts with", fmtK(a.baseline), "System prompt, tools and memory: what every request carries before the conversation");
    fact("Grows by", a.growth ? "+" + fmtK(a.growth) : "—", "How much a request's prompt adds to the one before it, the median");
    fact("Cache hit", a.scores?.find((s) => s.key === "cache") && a.cache ? pct(a.cache) : "—", "Of its prompts, what the vendor read from its cache");
    fact("Window size", a.window ? fmtK(a.window) : "—", "The largest context window of the models it used");

    const mix = el("div", "ctx-mix");
    mix.append(el("span", "ctx-k", t("What its prompts hold")), shareBar(a.shares));
    const keys = el("div", "ctx-mix-keys");
    for (const k of PARTS) {
      const v = a.shares?.[k] || 0;
      if (v < 0.01) continue;
      const s = el("span", "");
      s.append(el("i", "dot k-" + k), partName(k) + " " + pct(v));
      keys.append(s);
    }
    mix.append(keys);

    const foot = el("div", "ctx-agent-foot");
    const models = el("span", "ctx-models");
    // by the model's own name: "live/claude/claude-sonnet-4-5" cut short
    // read the same for each of its models; the whole id in its tooltip
    for (const m of a.models || []) {
      const c = el("code", "", m.split("/").pop());
      c.title = m;
      models.append(c);
    }
    foot.append(models, el("span", "grow"));
    if (a.latestId) {
      const go = el("button", "text", t("Latest request"));
      go.type = "button";
      go.dataset.feature = "routing"; // it opens on the Routing page
      go.onclick = () => window.openRoute(a.latestId, a.latestTime, { context: true }).catch(statusErr);
      foot.append(go);
    }
    card.append(head, scores, tags, facts, mix, foot);
    return card;
  }

  function sessionRow(s) {
    const open = ctxOpen === s.agent + "\x00" + s.key;
    const box = el("div", "ctx-sess" + (open ? " open" : ""));
    const row = el("button", "ctx-sess-row");
    row.type = "button";
    row.setAttribute("aria-expanded", String(open));
    const name = el("span", "ctx-sess-name");
    // an untitled session goes by the head of its id, the way the footer names it
    name.append(s.title ? el("b", "", s.title) : el("b", "raw", s.key.slice(0, 8)));
    name.append(el("code", "", s.model));
    const fill = s.window ? s.peak / s.window : 0;
    const [tone] = health(fill);
    const peak = el("span", "ctx-sess-peak " + tone, s.window ? pct(fill) : fmtK(s.peak));
    peak.dataset.tt = t("Its largest prompt: {tokens} of {window}", { tokens: fmtK(s.peak), window: fmtK(s.window) });
    const meta = el("span", "ctx-sess-meta", count(s.requests, "1 request", "{n} requests") + (s.compacts ? " · " + count(s.compacts, "1 compaction", "{n} compactions") : ""));
    row.append(agentIcon(s.agent), name, spark(s.points, s.latestId, s.window), peak, meta, el("span", "ctx-sess-when", ago(s.last)));
    row.onclick = () => {
      ctxOpen = open ? "" : s.agent + "\x00" + s.key;
      renderContext();
    };
    box.append(row);
    if (open && s.latest) {
      const last = s.points[s.points.length - 1];
      const r = { id: s.latestId, time: s.last, done: true, agent: s.agent, model: s.model, prompt: s.latest };
      const cache = last && s.latest.counted && last.tokens && !last.cache_unknown ? { read: last.cache || 0, total: last.tokens } : null;
      box.append(ctxCard(r, {
        cache, place: "session",
        series: s.points,
        crumbs: [agentLabel(s.agent), s.title || s.key.slice(0, 12), t("latest request")],
        onPoint: (pt) => { if (!featuresOff.has("routing")) window.openRoute(pt.id, pt.time, { context: true }).catch(statusErr); },
      }));
    }
    return box;
  }


  // ---------- tuned for you: the settings that would have spent the fewest tokens ----------

  let tuneData = null, tuneJSON = "", tuneRead = 0, tuneBusy = "";
  // whether the last draw showed the history and the advice: what was on
  // the pane already doesn't play its entrance again when the pane is
  // redrawn (the other answering, the state, a filter, a click)
  let ctxDrawn = false, tuneDrawn = false;

  const KNOBS = {
    compact: "Auto-compact",
    cache_ttl: "Prompt cache · main conversation",
    subagent_cache_ttl: "Prompt cache · subagents",
  };
  const ttlName = (v) => v === "1h" ? t("1 hour") : v === "5m" ? t("5 min") : v || "—";

  // chart draws what each setting would have cost over the range, as the
  // tokens it spends past the advice: the area over the advice's level is
  // what the others waste, and the one set now says how much
  let chartN = 0;
  // how far apart, as a share of the axis, two of its labels must sit: a
  // label is about 30px wide, the narrowest card's axis about 280px
  const TICK_GAP = 0.16;
  function chart(pts, current, best, show, timed) {
    if (pts.length < 2) return null;
    const near = (v) => pts.reduce((a, p) => Math.abs(p.value - v) < Math.abs(a.value - v) ? p : a, pts[0]);
    const now = typeof current === "number" ? near(current) : pts.find((p) => p.value === current);
    const top = typeof best === "number" ? near(best) : pts.find((p) => p.value === best);
    if (!top) return null;
    // measured from the advice, not the cheapest point: tune takes the
    // largest window within 1% of it, and those cost nothing more here.
    // Timed, the advice may pass a cheaper window that waits longer, so
    // each is said against the cheapest
    const low = timed ? Math.min(...pts.map((p) => p.cost)) : top.cost;
    const extra = (p) => Math.max(0, p.cost - low);
    const most = Math.max(...pts.map(extra));
    if (!(most > 0)) return null;
    const worst = pts.reduce((a, p) => p.cost > a.cost ? p : a, pts[0]);
    const W = 300, H = 100, top0 = 22, base = 84;
    const X = (i) => (i / (pts.length - 1)) * W;
    const Y = (p) => base - (extra(p) / most) * (base - top0);
    const xy = pts.map((p, i) => [X(i), Y(p)]);
    // a smooth line through every point that never swings past its neighbours
    let d = `M${xy[0][0].toFixed(1)} ${xy[0][1].toFixed(1)}`;
    for (let i = 1; i < xy.length; i++) {
      const [x0, y0] = xy[i - 1], [x1, y1] = xy[i], m = (x1 - x0) / 2;
      d += ` C${(x0 + m).toFixed(1)} ${y0.toFixed(1)} ${(x1 - m).toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    const id = "ctx-waste-" + ++chartN;
    const box = el("div", "ctx-tune-chart");
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", `0 0 ${W} ${H}`);
    s.setAttribute("preserveAspectRatio", "none");
    s.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" class="hot"/><stop offset="1" class="cool"/></linearGradient></defs>` +
      `<line class="level" x1="0" x2="${W}" y1="${base}" y2="${base}"/>` +
      `<path class="area" fill="url(#${id})" d="${d} L${W} ${base} L0 ${base} Z"/>` +
      `<path class="line" d="${d}"/>`;
    const plot = el("div", "ctx-tc-plot");
    plot.append(s);
    box.append(plot);
    const at = (p, cls, label) => {
      const i = pts.indexOf(p);
      const dot = el("span", "ctx-tc-dot " + cls);
      dot.style.left = (i / (pts.length - 1)) * 100 + "%";
      dot.style.top = (Y(p) / H) * 100 + "%";
      if (label) {
        const tag = el("b", "ctx-tc-tag", label);
        if (i === 0) tag.classList.add("start");
        if (i === pts.length - 1) tag.classList.add("end");
        dot.append(tag);
      }
      dot.dataset.tt = p === top
        ? timed ? t("{value}: the fewest tokens without waiting longer on compactions", { value: show(p.value) })
          : t("{value}: the fewest tokens for how you work", { value: show(p.value) })
        : t("{value}: {tokens} more tokens over the range (+{pct})", { value: show(p.value), tokens: fmtK(extra(p)), pct: pct(extra(p) / low) });
      plot.append(dot);
    };
    // the advice's value first, then the setting now, then the range's two
    // ends: a value that sits too close to one before it is left off, so two
    // labels are never drawn over each other (#1549, Ti800: 170K, the
    // leanest, one step from the axis's 160K, read as "1170K")
    const along = (p) => pts.indexOf(p) / (pts.length - 1);
    // the tags over the dots the same way: "Leanest" first, then the setting
    // now, then the costliest; one beside a tag that matters more and at
    // about its height keeps its dot and tooltip but not its tag, so a
    // setting one step from the advice doesn't print its "+3%" over
    // "Leanest" (#1549)
    const tagged = [];
    const tag = (p, label) => {
      if (tagged.some((k) => Math.abs(along(k) - along(p)) < TICK_GAP && Math.abs(Y(k) - Y(p)) < 20)) return "";
      tagged.push(p);
      return label;
    };
    const bestTag = tag(top, timed ? t("Tokens + wait") : t("Leanest"));
    const nowTag = now && now !== top ? tag(now, "+" + pct(extra(now) / low)) : "";
    const worstTag = worst !== now && worst !== top ? tag(worst, "+" + pct(extra(worst) / low)) : "";
    if (worst !== now && worst !== top) at(worst, "worst", worstTag);
    at(top, "best", bestTag);
    if (now && now !== top) at(now, "now", nowTag);
    const axis = el("div", "ctx-tc-x");
    const kept = [];
    for (const p of new Set([top, now, pts[0], pts[pts.length - 1]].filter(Boolean))) {
      if (kept.every((k) => Math.abs(along(k) - along(p)) >= TICK_GAP)) kept.push(p);
    }
    for (const p of new Set([pts[0], top, now, pts[pts.length - 1]].filter(Boolean))) {
      const i = pts.indexOf(p);
      if (!kept.includes(p)) continue;
      const tick = el("span", (p === top ? "best" : p === now ? "now" : "") + (i === 0 ? " start" : i === pts.length - 1 ? " end" : ""), show(p.value));
      tick.style.left = (i / (pts.length - 1)) * 100 + "%";
      axis.append(tick);
    }
    box.append(axis);
    box.dataset.tt = t("Tokens each setting would have spent past the leanest, on your own calls");
    return box;
  }

  function adviceRow(agent, a) {
    const r = a.compact || a.ttl;
    const ttl = !!a.ttl;
    const show = (v) => ttl ? ttlName(v) : fmtK(+v);
    const cur = ttl ? r.current : r.current, best = r.best;
    const same = String(cur) === String(best);
    const saves = r.cost > 0 ? (r.cost - r.low) / r.cost : 0;
    const set = a.setting || {};
    // a model's own Compact at is where Codex runs, over Long conversations
    // (hoobnn on Discord: "In use" for 170K beside "Now 430K")
    const own = a.own;
    const held = !!(set.locked || own);
    const applied = !own && set.ours && String(set.value) === String(best);
    const row = el("div", "ctx-tune-row" + (same || applied ? " done" : ""));

    const title = el("div", "ctx-tune-title");
    title.append(el("b", "", t(KNOBS[a.knob] || a.knob)));
    if (a.model) title.append(el("code", "", a.model));
    row.append(title);

    const vals = el("div", "ctx-tune-vals");
    const val = (label, v, cls) => {
      const f = el("div", "ctx-tune-val " + cls);
      f.append(el("span", "ctx-k", t(label)), el("b", "", show(v)));
      return f;
    };
    vals.append(val("Now", cur, "now"));
    // named for what it is measured by, tokens alone, not "best" (#1854);
    // with the agent's compactions timed, tokens and the wait on them
    const timed = !!(a.compact && (r.facts || {}).took > 0);
    if (!same) vals.append(el("span", "ctx-tune-arrow", "→"), val(timed ? "Tokens + wait" : "Fewest tokens", best, "best"));
    row.append(vals);
    const c = a.compact
      ? chart(a.compact.curve || [], r.current, r.best, show, timed)
      : chart([{ value: "5m", cost: r.short }, { value: "1h", cost: r.hour }], r.current, r.best, show);
    if (c) row.append(c);
    // the leanest band: the windows within 3% of the cheapest on the curve,
    // the share tune counts as costing the same. Timed, the advice keeps a
    // window that waits no longer than now, so a window the reader picked
    // past the band (yapechan on Discord: a larger one) comes back as the
    // advice and isn't the leanest; it says so, names the band, and offers
    // the band's largest window, the one of them that compacts least
    const curve = (a.compact && a.compact.curve) || [];
    const fewest = curve.length ? Math.min(...curve.map((p) => p.cost)) : 0;
    const band = curve.filter((p) => p.cost <= fewest * 1.03);
    const lean = same && timed && band.length && r.cost > fewest * 1.03 ? band[band.length - 1] : null;
    const bandName = lean ? (band[0] === lean ? show(lean.value) : show(band[0].value) + "–" + show(lean.value)) : "";

    const why = el("p", "ctx-tune-why");
    const f = r.facts || {};
    if (a.compact) {
      why.textContent = f.compacts
        ? t("Your conversations grow {growth} a call; a compaction leaves {after}, and reading back what it dropped costs {rework}. {n} compactions in the range.", { growth: fmtK(f.growth), after: fmtK(f.after), rework: fmtK(f.rework), n: f.compacts })
        : t("Your conversations grow {growth} a call, and none was compacted in the range.", { growth: fmtK(f.growth) });
      // how long the agent's own compactions took, from its files: what a
      // window that compacts more often would have kept the reader waiting
      if (timed) {
        const secs = f.took < 120 ? t("{n}s", { n: f.took }) : fmtDur(f.took);
        why.textContent += " " + (same
          ? t("Each compaction kept you waiting about {secs} ({n} timed). Over the range that's about {wait} at {value}.", { secs, n: f.timed, wait: fmtDur(r.wait || 0), value: show(cur) })
          : t("Each compaction kept you waiting about {secs} ({n} timed). Over the range that's about {wait} at {best}, against {now} at {value}.", { secs, n: f.timed, wait: fmtDur(r.wait_best || 0), best: show(best), now: fmtDur(r.wait || 0), value: show(cur) }));
        // the cheaper window the advice passed over, for waiting longer
        const cheap = (a.compact.curve || []).find((p) => p.value === r.cheapest);
        const adv = same ? r.cost : r.low;
        if (cheap && r.cheapest !== best && adv > 0 && (adv - cheap.cost) / adv >= 0.03 && (r.wait_cheapest || 0) > (same ? r.wait || 0 : r.wait_best || 0))
          why.textContent += " " + t("{value} would spend {pct} fewer tokens, but wait about {wait}.", { value: show(r.cheapest), pct: pct((adv - cheap.cost) / adv), wait: fmtDur(r.wait_cheapest) });
      }
    } else {
      why.textContent = t("{quick} of your calls came within 5 minutes of the one before, {pause} after a pause of 5 to 60 minutes.", { quick: pct(f.quick || 0), pause: pct(f.pause || 0) });
    }
    row.append(why);
    // one with its own Compact at, which Use doesn't move (hoobnn)
    for (const m of a.apart || []) row.append(el("p", "ctx-tune-caveat ctx-tune-apart", t("{model} compacts at its own {value}, which this doesn't move", { model: m.model, value: fmtK(m.value) })));
    // a window advised is weighed by tokens alone: what a compaction loses of
    // the task isn't measured, and a smaller one compacts more often (#1854)
    if (a.compact && (!same || lean)) row.append(el("p", "ctx-tune-caveat", timed
      ? t("Tokens and waiting only: it doesn't measure how well the agent keeps the task after a compaction. The lower the window, the more often it compacts.")
      : t("A token estimate only: it doesn't measure how well the agent keeps the task after a compaction. The lower the window, the more often it compacts.")));

    const foot = el("div", "ctx-tune-foot");
    const verdict = !lean && (same || applied)
      ? el("span", "ctx-chip good", "")
      : el("span", "ctx-chip info", "");
    verdict.append(el("i"), lean ? t("Not the leanest: {range} spends the fewest tokens", { range: bandName })
      : same ? t("Already the leanest for how you work") : applied ? t("In use") : t("{pct} fewer tokens · {tokens} over the range", { pct: pct(saves), tokens: fmtK(Math.round(r.cost - r.low)) }));
    foot.append(verdict, el("span", "grow"));
    const note = el("div", "ctx-tune-src");
    title.after(note);
    if (set.locked) note.textContent = t("{name} is set and comes first", { name: set.locked });
    else if (own) note.textContent = t("{model} compacts at its own {value}, which comes first", { model: own.model, value: fmtK(own.value) });
    else if (set.source == "long") note.textContent = t("Long conversations, shared by Codex, Claude Code and Grok Build");
    else if (set.ours) note.textContent = t("Set by magpie");
    else if (set.value && a.compact && +set.value > a.compact.window && a.compact.window) note.textContent = t("You set {value}; the model's {window} comes first", { value: show(set.value), window: fmtK(a.compact.window) });
    else if (set.value) note.textContent = t("You set {value}", { value: show(set.value) });
    else note.textContent = t("The agent's default");
    const key = [agent, a.knob, a.model || ""].join("\x00");
    const send = async (path, value, knob = a.knob) => {
      tuneBusy = key;
      renderContext();
      try {
        await api("tune/" + path, { agent, knob, model: a.model || "", value: String(value ?? "") });
        status(path === "apply" ? t("Saved: {agent} reads it from its next session", { agent: agentLabel(agent) }) : t("Put back"), "ok");
      } catch (e) {
        statusErr(e);
      }
      tuneBusy = "";
      await loadTune(true);
    };
    if (set.ours) {
      const undo = el("button", "text", t("Undo"));
      undo.type = "button";
      undo.disabled = tuneBusy === key;
      undo.onclick = () => send("undo");
      foot.append(undo);
    }
    if (!same && !applied && !held) {
      const go = el("button", "text primary", t("Use {value}", { value: show(best) }));
      go.type = "button";
      go.disabled = tuneBusy === key;
      if (set.value && !set.ours) go.dataset.tt = t("Replaces your {value}; Undo puts it back", { value: show(set.value) });
      go.onclick = () => send("apply", best);
      foot.append(go);
    }
    if (lean && !held) {
      const go = el("button", "text primary", t("Use {value}", { value: show(lean.value) }));
      go.type = "button";
      go.disabled = tuneBusy === key;
      go.dataset.tt = set.value && !set.ours
        ? t("Replaces your {value}; Undo puts it back", { value: show(set.value) })
        : t("Fewer tokens, but more compactions to wait on");
      go.onclick = () => send("apply", lean.value);
      foot.append(go);
    }
    // a window of the reader's own (#1860), from the same replay: each
    // value's tokens past the leanest and compactions, both estimates
    const pts = (a.compact && a.compact.curve) || [];
    if (pts.length > 1 && !held) {
      const other = el("button", "text ctx-tune-pick", t("Other window…"));
      other.type = "button";
      other.disabled = tuneBusy === key;
      other.setAttribute("aria-haspopup", "menu");
      other.setAttribute("aria-expanded", "false");
      other.onclick = (e) => {
        e.stopPropagation();
        // timed, the advice may spend over the cheapest to wait no
        // longer, so each value is said against the cheapest
        const cheapest = pts.reduce((x, p) => p.cost < x.cost ? p : x, pts[0]);
        const base = timed ? cheapest.cost : (pts.find((p) => p.value === best) || {}).cost ?? r.low;
        const now = set.ours && set.value != null ? +set.value : cur;
        const near = pts.reduce((x, p) => Math.abs(p.value - now) < Math.abs(x.value - now) ? p : x, pts[0]);
        const opts = pts.map((p) => {
          const extra = Math.max(0, p.cost - base);
          const spend = p.value === (timed ? cheapest.value : best) ? t("Fewest tokens")
            : base > 0 && extra / base < 0.005 ? t("As few tokens")
            : t("+{tokens} tokens (+{pct})", { tokens: fmtK(extra), pct: pct(base > 0 ? extra / base : 0) });
          const often = p.compacts == null ? "" : p.compacts ? count(p.compacts, "about 1 compaction", "about {n} compactions") : t("no compaction");
          const wait = timed && p.compacts ? t("about {d} waiting", { d: fmtDur(p.wait || 0) }) : "";
          return { v: String(p.value), name: show(p.value), literalName: true, note: [spend, often, wait].filter(Boolean).join(" · ") };
        });
        openProtoMenu(other, opts, String(near.value), (v) => {
          if (v !== String(now)) send("apply", v);
        }, "Compact at · estimated from your calls of the range", "ctx-tune-menu");
      };
      foot.append(other);
    }
    // Codex's background compaction at the advice, the limit kept (herman_hong)
    const as = a.async, aset = as?.setting || {}, cav = (s) => row.append(el("p", "ctx-tune-caveat ctx-tune-async", s));
    const btn = (label, go, c = "") => {
      const b = el("button", "text" + c, label);
      b.type = "button";
      b.disabled = tuneBusy === key;
      b.onclick = go;
      return foot.appendChild(b);
    };
    if (!as) {} else if (aset.locked) cav(t("Background compaction: Codex's config.toml sets {key}, which comes first", { key: aset.locked }));
    else if (as.held?.length) cav(codexHeld(as.held));
    else if (aset.ours && +aset.value === as.percent) {
      verdict.after(el("span", "ctx-chip good ctx-tune-async", t("In the background at {value}", { value: fmtK(as.value) })));
      verdict.nextSibling.prepend(el("i"));
      btn(t("Undo background"), () => send("undo", "", "async_compact"));
    } else btn(t("Use {value} in the background", { value: fmtK(as.value) }), () => send("apply", as.percent, "async_compact"), " ctx-tune-async").dataset.tt = t("Codex compacts in the background past {pct} of the model's window, about {value} of {window}, while the turn goes on; {now} stays as the foreground limit, for when the background one isn't ready. A Codex feature still under development, 0.163 or later.", { pct: as.percent + "%", value: fmtK(as.value), window: fmtK(as.window), now: show(cur) });
    row.append(foot);
    return row;
  }

  function tuneCard(ag) {
    const card = el("div", "ctx-tune");
    const head = el("div", "ctx-agent-head");
    const who = el("div", "ctx-who");
    who.append(agentIcon(ag.agent), el("b", "", agentLabel(ag.agent)));
    const name = el("div", "ctx-who-box");
    name.append(who, el("div", "ctx-who-sub", count(ag.calls, "1 call", "{n} calls")));
    head.append(name, el("span", "grow"));
    const total = ag.advice.reduce((s, a) => { const r = a.compact || a.ttl; return s + Math.max(0, r.cost - r.low); }, 0);
    const all = ag.advice.reduce((s, a) => s + (a.compact || a.ttl).cost, 0);
    // a share that rounds to nothing is no promise
    if (all > 0 && total / all >= 0.01) head.append(el("span", "ctx-tune-total", t("Up to {pct} fewer", { pct: pct(total / all) })));
    card.append(head);
    for (const a of ag.advice) card.append(adviceRow(ag.agent, a));
    if (!ag.advice.length) card.append(el("p", "usage-note", t("Not enough calls in this range to tune on")));
    return card;
  }

  function renderTune(pane) {
    const head = el("div", "row-head ctx-sess-head");
    head.append(el("span", "label", t("Tuned for you")), el("span", "grow"));
    pane.append(head);
    pane.append(el("p", "usage-note ctx-tune-note", t("Your own calls of the range, replayed setting by setting from your agents' session files: the settings that would have spent the fewest tokens, for how you work. Tokens are weighed as the vendor charges them: a cache read is a tenth of one.")));
    if (!tuneData) {
      pane.append(el("p", "usage-note", t("Working it out from your sessions…")));
      return;
    }
    const shown = tuneData.agents.filter((a) => a.advice.length);
    if (!shown.length) {
      pane.append(el("p", "usage-note", t("Not enough calls in this range to tune on")));
      return;
    }
    const grid = el("div", "ctx-agents ctx-tunes");
    for (const a of shown) grid.append(tuneCard(a));
    pane.append(grid);
  }

  async function loadTune(force) {
    const read = ++tuneRead, days = ctxDays;
    if (tuneData && tuneData.days !== +days) tuneData = null;
    const data = await api("tune?days=" + days);
    if (read !== tuneRead) return;
    const json = JSON.stringify(data);
    if (!force && tuneData && json === tuneJSON) return;
    tuneData = { days: +data.days || +days, agents: (data.agents || []).map((a) => ({ ...a, advice: a.advice || [] })) }, tuneJSON = json;
    renderContext();
  }

  function renderContext() {
    const pane = $("#contextPane");
    if (!pane) return;
    // the range sits in the Usage page's own head, where the other tabs keep
    // theirs, so no row of its own stands empty above the pane
    $("#ctxRange")?.replaceChildren(segs(CTX_RANGES.map(([id, n]) => [id, t(n)]), ctxDays, (id) => {
      ctxDays = id;
      try { localStorage.setItem("magpie.ctxDays", id); } catch {}
      loadContext();
    }));
    pane.replaceChildren();
    pane.classList.toggle("still", ctxDrawn && !!ctxData);
    pane.classList.toggle("tune-still", tuneDrawn && !!tuneData);
    ctxDrawn = !!ctxData, tuneDrawn = !!tuneData;
    renderTune(pane);
    if (!ctxData) {
      pane.append(el("p", "usage-note", t("Reading the routing history…")));
      return;
    }
    const seen = el("div", "row-head ctx-sess-head");
    seen.append(el("span", "label", t("Through magpie")), el("span", "grow"));
    pane.append(seen);
    pane.append(el("p", "usage-note", t("What each agent's prompts hold, as magpie's gateway read them: the score and tags are worked out from the requests of the range.")));
    if (!ctxData.agents.length) {
      const empty = el("div", "ctx-none");
      empty.append(el("b", "", t("No prompts read yet")), el("span", "", t("Requests your agents send through magpie show here.")));
      pane.append(empty);
      return;
    }
    const grid = el("div", "ctx-agents");
    for (const a of ctxData.agents) grid.append(agentCard(a));
    pane.append(grid);

    const agents = [...new Set(ctxData.sessions.map((s) => s.agent))];
    const head = el("div", "row-head ctx-sess-head");
    head.append(el("span", "label", t("Sessions")), el("span", "grow"));
    if (agents.length > 1) {
      if (ctxAgent !== "all" && !agents.includes(ctxAgent)) ctxAgent = "all";
      head.append(segs([["all", t("All")], ...agents.map((id) => [id, agentLabel(id)])], ctxAgent, (id) => { ctxAgent = id; renderContext(); }));
    }
    pane.append(head);
    const list = el("div", "ctx-sess-list");
    const shown = ctxData.sessions.filter((s) => ctxAgent === "all" || s.agent === ctxAgent);
    for (const s of shown) list.append(sessionRow(s));
    if (!shown.length) list.append(el("p", "usage-note", t("No sessions in this range")));
    pane.append(list);
  }

  async function loadContext() {
    const read = ++ctxRead, days = ctxDays;
    if (tuneData && tuneData.days !== +days) tuneData = null;
    if (ctxData && ctxData.days !== +days) ctxData = null;
    if (!ctxData && (ctxWaiting !== days || !$("#contextPane")?.childElementCount)) { ctxWaiting = days; renderContext(); }
    loadTune().catch(statusErr);
    const data = await api("context?days=" + days);
    if (read !== ctxRead) return;
    // the auto refresh redraws only what changed: the same answer keeps the
    // pane (and what the pointer is on), and a new one comes in without its
    // entrance animations. What it is drawn with counts too: the agents'
    // names and icons come with the state, which can answer after a first
    // history, drawn by the agents' ids until then
    const json = JSON.stringify([data, (state.clients || state.agents || []).map((a) => [a.id, a.name, a.icon])]);
    if (ctxData && json === ctxJSON) return;
    ctxData = data, ctxJSON = json;
    renderContext();
  }
  window.loadContext = loadContext;
  window.renderContext = renderContext;
})();
