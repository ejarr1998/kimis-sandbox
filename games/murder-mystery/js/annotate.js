/**
 * Dead Air — detective annotation layer
 *
 * Lets a player mark up two kinds of targets with a red pen, a yellow
 * highlighter and an eraser:
 *   A) the Initial Report panel (#opening-panel)
 *   B) every corkboard note (.clue-note inside #boardfield)
 *
 * Public API (global lexical const — shared with game.js / stage.js scripts):
 *   Annotate.attach(element, key)    make one element annotatable
 *   Annotate.attachNotes(container)  auto-attach to current + future .clue-note
 *
 * Strokes persist in localStorage under `deadair_anno_{key}` as JSON:
 *   [{ tool, color, size, points:[[x,y]…] }]
 * with points and size normalized 0..1 against the target box, so they survive
 * resizes, note re-renders and the panel being adopted into the Stage.
 *
 * This file is self-contained: it must not modify game.js / stage.js, and
 * reads their globals (CODE, DETECTIVE) lazily, inside functions only.
 */
const Annotate = (() => {
  "use strict";

  const STORE_PREFIX = "deadair_anno_";
  const MAX_STROKES = 300;
  const PEN = { tool: "pen", color: "#b3261e", size: 2.5 };
  const HIGHLIGHTER = { tool: "hl", color: "rgba(250,220,90,0.35)", size: 14 };
  const ERASER = { tool: "eraser", color: "#000", size: 18 };

  // element -> state (see attach)
  const states = new Map();
  let activeState = null;   // the single target currently in annotation mode

  const storeKey = (key) => STORE_PREFIX + key;

  function loadStrokes(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey(key)) || "[]");
      return Array.isArray(raw) ? raw.filter(s => s && Array.isArray(s.points) && s.points.length) : [];
    } catch (e) { return []; }
  }
  function saveStrokes(key, strokes) {
    try { localStorage.setItem(storeKey(key), JSON.stringify(strokes.slice(-MAX_STROKES))); }
    catch (e) { /* storage full / private mode — annotations just stay in-memory */ }
  }

  // small stable hash for note identity (clue text → key fragment)
  function hashText(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // lazily read game.js globals (they are script-level consts, available on demand)
  function caseTag() {
    try {
      if (typeof CODE !== "undefined" && typeof DETECTIVE !== "undefined" && CODE && DETECTIVE)
        return CODE + ":" + DETECTIVE;
    } catch (e) { /* globals not there yet */ }
    return "local:anon";
  }

  // ---------- canvas sizing / drawing ----------

  function fitCanvas(st) {
    const el = st.el, c = st.canvas;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return false;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function strokeStyle(st, s) {
    const ctx = st.ctx, w = st.el.clientWidth || 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = (s.size || 0.02) * w;
    } else if (s.tool === "hl") {
      ctx.globalCompositeOperation = "multiply";
      ctx.strokeStyle = s.color || HIGHLIGHTER.color;
      ctx.lineWidth = (s.size || 0.05) * w;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = s.color || PEN.color;
      ctx.lineWidth = (s.size || 0.005) * w;
    }
  }

  function drawStroke(st, s, fromIdx) {
    const w = st.el.clientWidth, h = st.el.clientHeight;
    if (!w || !h) return;
    const ctx = st.ctx, pts = s.points;
    strokeStyle(st, s);
    const start = Math.max(0, fromIdx === undefined ? 0 : fromIdx);
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0] * w, pts[0][1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[start][0] * w, pts[start][1] * h);
      for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function redraw(st) {
    if (!fitCanvas(st)) return;
    st.ctx.clearRect(0, 0, st.el.clientWidth, st.el.clientHeight);
    for (const s of st.strokes) drawStroke(st, s);
  }

  // ---------- annotation mode ----------

  const TOOLS = [
    { id: "pen",    label: "✏️", title: "Red pen" },
    { id: "hl",     label: "🖍",  title: "Yellow highlighter" },
    { id: "eraser", label: "🧽", title: "Eraser" },
    { id: "clear",  label: "🗑",  title: "Clear all annotations on this target" },
    { id: "done",   label: "✓",   title: "Done annotating (Esc)" },
  ];

  function buildToolbar(st) {
    const bar = document.createElement("div");
    bar.className = "anno-toolbar hidden";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Annotation tools");
    for (const t of TOOLS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "anno-tool" + (t.id === "done" ? " anno-done" : "");
      b.textContent = t.label;
      b.title = t.title;
      b.setAttribute("aria-label", t.title);
      b.dataset.tool = t.id;
      // keep the pointer interaction off the note's drag handler
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (t.id === "done") { exitMode(); return; }
        if (t.id === "clear") {
          st.strokes = [];
          saveStrokes(st.key, st.strokes);
          redraw(st);
          return;
        }
        st.tool = t.id === "pen" ? { ...PEN } : t.id === "hl" ? { ...HIGHLIGHTER } : { ...ERASER };
        refreshToolbar(st);
      });
      bar.appendChild(b);
    }
    bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(bar);
    return bar;
  }

  function refreshToolbar(st) {
    for (const b of st.toolbar.querySelectorAll(".anno-tool")) {
      const id = b.dataset.tool;
      b.classList.toggle("on", id === st.tool.tool);
    }
  }

  function placeToolbar(st) {
    const r = st.el.getBoundingClientRect();
    const bar = st.toolbar;
    bar.classList.remove("hidden");
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let x = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - bw - 4));
    let y = r.top - bh - 6;                       // prefer above the target
    if (y < 4) y = r.bottom + 6;                  // … else below
    if (y + bh > window.innerHeight - 4) y = Math.max(4, window.innerHeight - bh - 4);
    bar.style.left = x + "px";
    bar.style.top = y + "px";
  }

  function enterMode(st) {
    if (activeState === st) return;
    exitMode();
    activeState = st;
    st.annotating = true;
    st.canvas.classList.add("on");
    st.afford.classList.add("hidden");
    st.tool = { ...PEN };
    refreshToolbar(st);
    placeToolbar(st);
    redraw(st);
  }

  function exitMode() {
    const st = activeState;
    if (!st) return;
    activeState = null;
    st.annotating = false;
    st.canvas.classList.remove("on");
    st.afford.classList.remove("hidden");
    st.toolbar.classList.add("hidden");
    if (st.strokes.length > MAX_STROKES) st.strokes = st.strokes.slice(-MAX_STROKES);
    saveStrokes(st.key, st.strokes);
  }

  // Escape exits annotation mode (capture so the Stage doesn't also close)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeState) {
      e.preventDefault();
      e.stopPropagation();
      exitMode();
    }
  }, true);

  window.addEventListener("resize", () => {
    for (const st of states.values()) redraw(st);
    if (activeState) placeToolbar(activeState);
  });
  window.addEventListener("scroll", () => { if (activeState) placeToolbar(activeState); }, true);

  // ---------- drawing input ----------

  function normPoint(st, e) {
    const r = st.canvas.getBoundingClientRect();
    const w = r.width || 1, h = r.height || 1;
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / w)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / h))
    ];
  }

  function bindCanvas(st) {
    const c = st.canvas;
    let drawing = false, cur = null;

    c.addEventListener("pointerdown", (e) => {
      if (!st.annotating) return;
      e.preventDefault();
      e.stopPropagation();           // keep the note's drag handler out of this
      c.setPointerCapture(e.pointerId);
      drawing = true;
      const w = st.el.clientWidth || 1;
      cur = {
        tool: st.tool.tool,
        color: st.tool.color,
        size: st.tool.size / w,      // normalized against target width
        points: [normPoint(st, e)]
      };
      drawStroke(st, cur, 0);
    });

    c.addEventListener("pointermove", (e) => {
      if (!drawing || !st.annotating) return;
      e.preventDefault();
      const p = normPoint(st, e);
      const last = cur.points[cur.points.length - 1];
      // skip sub-pixel jitter (distance in normalized space of the shorter side)
      const dw = (p[0] - last[0]) * st.el.clientWidth;
      const dh = (p[1] - last[1]) * st.el.clientHeight;
      if (dw * dw + dh * dh < 1.2) return;
      const from = cur.points.length - 1;
      cur.points.push(p);
      drawStroke(st, cur, from);
    });

    const finish = (e) => {
      if (!drawing) return;
      drawing = false;
      if (cur && cur.points.length) {
        st.strokes.push(cur);
        if (st.strokes.length > MAX_STROKES) st.strokes = st.strokes.slice(-MAX_STROKES);
        saveStrokes(st.key, st.strokes);
      }
      cur = null;
    };
    c.addEventListener("pointerup", finish);
    c.addEventListener("pointercancel", finish);
  }

  // ---------- attach ----------

  function attach(el, key) {
    if (!el || !key || states.has(el)) return null;
    if (getComputedStyle(el).position === "static") el.classList.add("anno-rel");

    const canvas = document.createElement("canvas");
    canvas.className = "anno-canvas";
    canvas.setAttribute("aria-hidden", "true");
    el.appendChild(canvas);

    const afford = document.createElement("button");
    afford.type = "button";
    afford.className = "anno-edit";
    afford.textContent = "✎";
    afford.title = "Annotate (red pen / highlighter)";
    afford.setAttribute("aria-label", "Annotate this panel");
    // don't let a press on the affordance start a note drag
    afford.addEventListener("pointerdown", (e) => e.stopPropagation());
    afford.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeState === st) exitMode(); else enterMode(st);
    });
    el.appendChild(afford);

    const st = {
      el, key, canvas, afford,
      ctx: canvas.getContext("2d"),
      strokes: loadStrokes(key),
      tool: { ...PEN },
      annotating: false,
      toolbar: null,
      lastParent: el.parentNode,
    };
    st.toolbar = buildToolbar(st);
    states.set(el, st);
    bindCanvas(st);

    // resize → refit canvas + redraw scaled strokes
    if (typeof ResizeObserver !== "undefined") {
      st.ro = new ResizeObserver(() => {
        redraw(st);
        if (activeState === st) placeToolbar(st);
      });
      st.ro.observe(el);
    }

    // reparenting (stage.js adopt() moves #opening-panel / #boardfield) →
    // layout may have changed even without a resize event
    if (typeof MutationObserver !== "undefined") {
      st.mo = new MutationObserver(() => {
        if (el.parentNode !== st.lastParent || !el.isConnected) {
          st.lastParent = el.parentNode;
          requestAnimationFrame(() => {
            redraw(st);
            if (activeState === st) placeToolbar(st);
          });
        }
      });
      st.mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    requestAnimationFrame(() => redraw(st));
    return st;
  }

  // release everything for a detached element (note re-rendered away)
  function detach(el) {
    const st = states.get(el);
    if (!st) return;
    if (activeState === st) exitMode();
    if (st.ro) st.ro.disconnect();
    if (st.mo) st.mo.disconnect();
    st.toolbar.remove();
    states.delete(el);
  }

  function noteKey(note) {
    const idx = note.dataset && note.dataset.idx !== undefined ? note.dataset.idx : "x";
    const txt = note.querySelector(".txt");
    return "note:" + caseTag() + ":" + idx + ":" + hashText(txt ? txt.textContent : note.textContent);
  }

  // observe a #boardfield-like container: annotate every .clue-note, present
  // and future; drop state for notes that get wiped by re-renders
  function attachNotes(container) {
    if (!container) return;
    const scan = () => {
      for (const n of container.querySelectorAll(".clue-note"))
        if (!states.has(n)) attach(n, noteKey(n));
    };
    scan();
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.removedNodes)
          if (n.nodeType === 1) {
            if (states.has(n)) detach(n);
            for (const d of n.querySelectorAll ? n.querySelectorAll(".clue-note") : [])
              if (states.has(d)) detach(d);
          }
      scan();
    });
    mo.observe(container, { childList: true });
  }

  // The Stage's fullscreen Case File builds a fresh reader node instead of
  // adopting #opening-panel, so it needs attaching by hand. Using the SAME key
  // as the desk panel means existing marks reappear there — strokes are stored
  // normalized 0..1 against the target box, so they simply scale to the larger
  // reader. Returns a cleanup for the caller to run when the pane closes.
  function attachReport(el) {
    if (!el) return () => {};
    attach(el, "report:" + caseTag());
    return () => detach(el);
  }

  // ---------- auto-init ----------

  function init() {
    const panel = document.getElementById("opening-panel");
    if (panel) attach(panel, "report:" + caseTag());
    const field = document.getElementById("boardfield");
    if (field) attachNotes(field);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else
    init();

  return {
    attach,
    attachNotes,
    attachReport,
    detach,
    exit: exitMode,
    isActive: () => !!activeState,
    _states: states,   // exposed for debugging / tests
  };
})();
