/**
 * Dead Air — Stage: fullscreen views + split screen
 *
 * The Stage is a fullscreen layer (z-index below the modal overlays so the
 * warrant / reveal / intro still float above it) hosting one or two PANES.
 * Each pane runs a purpose-built VIEW — not a zoomed copy of the desk panel:
 *
 *   file      → Case File Reader   (calm reading layout, narration, actions)
 *   suspects  → Lineup Room        (large cards; tap to dock the interrogation)
 *   board     → War Room Board     (the corkboard gets the whole canvas)
 *   evidence  → Evidence Locker    (big tag grid; tap to hold one to the lamp)
 *   chat      → Interrogation      (dockable pane; adopts the overlay's DOM)
 *
 * Panes sit side by side on desktop / landscape, stacked on portrait phones.
 */
const Stage = (() => {

  const VIEW_NAMES = {
    file: "Case File",
    suspects: "Lineup Room",
    board: "War Room Board",
    ranking: "Board of Suspicion",
    evidence: "Evidence Locker",
    chat: "Interrogation"
  };

  let panes = [];          // [{ view, root, body, restore }] in display order
  let opened = false;

  // ---------- split divider (drag to resize the two panes) ----------
  const MIN_RATIO = 0.2;   // neither pane may go below 20%
  let divider = null;
  const ratio = { h: null, v: null }; // first-pane fraction per axis (null = not loaded)

  // "h" = side-by-side (drag horizontally), "v" = stacked portrait (drag vertically)
  function splitAxis() {
    const w = stageEl().querySelector(".stage-panes");
    return w && getComputedStyle(w).flexDirection === "column" ? "v" : "h";
  }
  const ratioKey = (a) => a === "v" ? "deadair_split_ratio_v" : "deadair_split_ratio_h";
  const clampRatio = (r) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));
  function loadRatio(a) {
    try {
      const x = parseFloat(localStorage.getItem(ratioKey(a)));
      if (isFinite(x)) return clampRatio(x);
    } catch (e) { /* storage may be unavailable */ }
    return 0.5;
  }
  function currentRatio(a) {
    if (ratio[a] == null) ratio[a] = loadRatio(a);
    return ratio[a];
  }
  function saveRatio(a, r) {
    try { localStorage.setItem(ratioKey(a), String(r)); } catch (e) {}
  }

  function applySplit() {
    if (panes.length !== 2) return;
    const r = clampRatio(currentRatio(splitAxis()));
    panes[0].root.style.flex = "0 0 " + (r * 100).toFixed(3) + "%";
    panes[1].root.style.flex = "1 1 auto";
  }

  // Swap which side each view sits on. The first-pane fraction is inverted too,
  // so each view keeps the width it had rather than inheriting the other's —
  // otherwise "swap" would also resize both panes, which reads as a bug.
  function swapPanes() {
    if (panes.length !== 2) return;
    const wrap = stageEl().querySelector(".stage-panes");
    wrap.prepend(panes[1].root);
    panes.reverse();
    const a = splitAxis();
    ratio[a] = clampRatio(1 - currentRatio(a));
    saveRatio(a, ratio[a]);
    syncDivider();
    refreshNav();
  }

  function clearSplit() {
    for (const p of panes) p.root.style.flex = "";
    if (divider) { divider.remove(); divider = null; }
  }

  function makeDivider() {
    const d = el("div", "stage-divider");
    d.setAttribute("role", "separator");
    d.title = "Drag to resize · double-click to reset";
    d.appendChild(el("span", "stage-divider-grip", "⋮⋮"));

    d.addEventListener("pointerdown", (e) => {
      if (panes.length < 2) return;
      e.preventDefault(); // no text selection / no scroll hijack while dragging
      try { d.setPointerCapture(e.pointerId); } catch (err) {}
      const a = splitAxis();
      const rect = stageEl().querySelector(".stage-panes").getBoundingClientRect();
      const size = a === "v" ? rect.height : rect.width;
      const start = a === "v" ? rect.top : rect.left;
      let moved = false;
      d.classList.add("dragging");
      document.body.classList.add("split-dragging", a === "v" ? "split-dragging-v" : "split-dragging-h");
      const move = (ev) => {
        const pos = a === "v" ? ev.clientY - start : ev.clientX - start;
        ratio[a] = clampRatio(size ? pos / size : 0.5);
        moved = true;
        applySplit();
      };
      const up = () => {
        d.removeEventListener("pointermove", move);
        d.removeEventListener("pointerup", up);
        d.removeEventListener("pointercancel", up);
        d.classList.remove("dragging");
        document.body.classList.remove("split-dragging", "split-dragging-v", "split-dragging-h");
        saveRatio(a, ratio[a]);
        // double-tap / double-click (pointer events) resets to 50/50
        const now = Date.now();
        if (!moved && now - (d._lastTap || 0) < 350) {
          ratio[a] = 0.5;
          saveRatio(a, 0.5);
          applySplit();
          d._lastTap = 0;
        } else if (!moved) {
          d._lastTap = now;
        }
      };
      d.addEventListener("pointermove", move);
      d.addEventListener("pointerup", up);
      d.addEventListener("pointercancel", up);
    });

    d.addEventListener("dblclick", () => {
      const a = splitAxis();
      ratio[a] = 0.5;
      saveRatio(a, 0.5);
      applySplit();
    });
    return d;
  }

  // insert / remove the divider + re-apply the persisted ratio for this axis
  function syncDivider() {
    if (panes.length === 2) {
      if (!divider || !divider.isConnected) divider = makeDivider();
      panes[0].root.after(divider);
      applySplit();
    } else {
      clearSplit();
    }
  }

  // re-clamp on window resize / orientation change while split is open
  window.addEventListener("resize", () => {
    if (opened && panes.length === 2) syncDivider();
  });

  const stageEl = () => $("stage");

  // ---------- fullscreen API (app-level) ----------
  // iPhone Safari has no requestFullscreen — we detect and hint instead.
  function appFullscreenSupported() {
    const de = document.documentElement;
    return !!(de.requestFullscreen || de.webkitRequestFullscreen);
  }

  // ---------- adopt / restore: borrow desk DOM instead of duplicating it ----------
  function adopt(node, into) {
    const parent = node.parentNode, next = node.nextSibling;
    into.appendChild(node);
    return () => parent.insertBefore(node, next);
  }

  // ---------- stage shell ----------
  function buildShell() {
    const s = stageEl();
    s.innerHTML = "";
    const bar = el("div", "stage-bar");
    const nav = el("div", "stage-nav");
    for (const v of ["file", "suspects", "board", "ranking", "evidence"]) {
      const b = el("button", "stage-nav-btn", VIEW_NAMES[v]);
      b.dataset.view = v;
      b.onclick = () => switchPrimary(v);
      nav.appendChild(b);
    }
    const swapBtn = el("button", "stage-swap", "⇆ swap sides");
    swapBtn.title = "Swap the two views (Alt+S)";
    swapBtn.onclick = () => swapPanes();
    bar.appendChild(swapBtn);
    const closeBtn = el("button", "stage-close", "✕ back to the desk");
    closeBtn.onclick = () => close();   // NB: must not shadow close() above
    bar.appendChild(nav);
    bar.appendChild(closeBtn);
    const panesWrap = el("div", "stage-panes");
    s.appendChild(bar);
    s.appendChild(panesWrap);
  }

  function refreshNav() {
    const sw = stageEl().querySelector(".stage-swap");
    if (sw) sw.classList.toggle("hidden", panes.length !== 2);
    const active = panes.map(p => p.view);
    for (const b of stageEl().querySelectorAll(".stage-nav-btn"))
      b.classList.toggle("on", active.includes(b.dataset.view));
    stageEl().querySelector(".stage-panes").classList.toggle("split", panes.length > 1);
    syncDivider();
  }

  function addPane(view, { at } = {}) {
    const root = el("section", "pane pane-" + view);
    const head = el("header", "pane-head");
    head.appendChild(el("span", "pane-title", VIEW_NAMES[view]));
    const tools = el("span", "pane-tools");
    // The chat pane is the one view you can't reach from the top nav, so it
    // needs its own way back to the suspect list.
    if (view === "chat") {
      const backBtn = el("button", "pane-tool", "← all suspects");
      backBtn.title = "Close this interview and show the lineup";
      backBtn.onclick = () => backToLineup();
      tools.appendChild(backBtn);
    }
    // split menu: dock any other view beside this one
    const splitBtn = el("button", "pane-tool", "⇄ split");
    splitBtn.title = "Open another view beside this one";
    splitBtn.onclick = () => showSplitMenu(root);
    tools.appendChild(splitBtn);
    const closeBtn = el("button", "pane-tool", "✕");
    closeBtn.title = "Close this view";
    closeBtn.onclick = () => closePane(view);
    tools.appendChild(closeBtn);
    head.appendChild(tools);
    const body = el("div", "pane-body");
    root.appendChild(head);
    root.appendChild(body);
    const wrap = stageEl().querySelector(".stage-panes");
    // `at: 0` puts the new pane on the LEFT. syncDivider() re-seats the divider
    // from panes[0], so DOM order and array order just have to agree.
    if (at === 0) { wrap.prepend(root); } else { wrap.appendChild(root); }
    const pane = { view, root, body, restore: null };
    if (at === 0) panes.unshift(pane); else panes.push(pane);
    VIEWS[view](pane);
    refreshNav();
    return pane;
  }

  // Leave the interview and show the lineup. If the Lineup Room is already
  // docked alongside, closing the chat simply hands it the full width;
  // otherwise the chat's own slot becomes the lineup.
  function backToLineup() {
    const chatIdx = panes.findIndex(p => p.view === "chat");
    if (chatIdx === -1) return;
    const hasLineup = panes.some(p => p.view === "suspects");
    closePane("chat", { keepStage: true });
    if (!hasLineup) addPane("suspects", { at: chatIdx });
  }

  function showSplitMenu(root) {
    root.querySelector(".split-menu")?.remove();
    const menu = el("div", "split-menu");
    for (const v of Object.keys(VIEW_NAMES)) {
      if (v === "chat") continue; // chat docks via the Lineup Room
      if (panes.some(p => p.view === v)) continue;
      const b = el("button", null, VIEW_NAMES[v]);
      b.onclick = () => { menu.remove(); openAsSplit(v, root); };
      menu.appendChild(b);
    }
    root.querySelector(".pane-head").appendChild(menu);
    const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", off); } };
    setTimeout(() => document.addEventListener("pointerdown", off), 0);
  }

  // "Split" means: put this view NEXT TO the pane whose button I pressed. So
  // the pane that gets replaced is the other one — previously this always
  // replaced panes[1], which meant hitting split on the left pane swapped out
  // the right-hand view instead of the one you were looking away from.
  function openAsSplit(view, fromRoot) {
    if (panes.length >= 2) {
      const fromIdx = panes.findIndex(p => p.root === fromRoot);
      const targetIdx = fromIdx === -1 ? 1 : 1 - fromIdx;
      closePane(panes[targetIdx].view, { keepStage: true });
      addPane(view, { at: targetIdx });   // reopen in the slot we just vacated
      return;
    }
    addPane(view);
  }

  function switchPrimary(view) {
    if (panes.some(p => p.view === view)) return; // already open — nav just reflects it
    if (panes.length === 0) { open(view); return; }
    const keep = panes.length > 1 ? panes[1].view : null;
    // afterChatUndock() clears currentSuspect, so a chat pane that survives a
    // nav switch would come back blank and unable to send. Hold the suspect
    // across the teardown and re-populate.
    const keepSuspect = keep === "chat" ? currentSuspect : null;
    while (panes.length) closePane(panes[0].view, { keepStage: true }); // restores adopted DOM
    addPane(view);
    if (keep && keep !== view) {
      addPane(keep);
      if (keepSuspect) populateChat(keepSuspect);
    }
  }

  function closePane(view, { keepStage = false } = {}) {
    const i = panes.findIndex(p => p.view === view);
    if (i === -1) return;
    const pane = panes[i];
    if (pane.restore) pane.restore();
    if (view === "chat") afterChatUndock();
    if (view === "board") afterBoardUndock();
    pane.root.remove();
    panes.splice(i, 1);
    if (!panes.length && !keepStage) { close(); return; }
    refreshNav();
  }

  function open(view) {
    // initZoneFocus() derives the view name from each zone's data-tab, so a new
    // desk panel silently gets an ⤢ button pointing at a view that may not be
    // registered here. Bail before mutating any state: half-opening the Stage
    // and then throwing inside addPane leaves it stuck with an empty shell.
    if (!VIEWS[view]) {
      console.warn(`[Stage] no fullscreen view registered for "${view}" — add it to VIEWS and VIEW_NAMES.`);
      return;
    }
    if (!opened) {
      buildShell();
      stageEl().classList.remove("hidden");
      stageEl().setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
      opened = true;
      if (gsapOK()) window.gsap.fromTo(stageEl(), { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.out" });
    } else if (panes.some(p => p.view === view)) {
      return; // already showing
    }
    if (panes.length) {
      while (panes.length) closePane(panes[0].view, { keepStage: true });
    }
    addPane(view);
  }

  function close() {
    while (panes.length) closePane(panes[0].view, { keepStage: true });
    stageEl().classList.add("hidden");
    stageEl().setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    opened = false;
  }

  const isOpen = () => opened;

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !opened) return;
    e.stopPropagation();
    if (panes.length > 1) closePane(panes[panes.length - 1].view);
    else close();
  });

  // ---------- VIEW: case file reader ----------
  function viewFile(pane) {
    const b = pane.body;
    const doc = el("article", "reader paper-doc");
    doc.appendChild(el("div", "reader-kicker", "Homicide Division · Case № " + CODE));
    doc.appendChild(el("h2", "reader-title", CASE.title));
    // The establishing shot belongs in the case file too — the desk report
    // shows it, so the fullscreen reader shouldn't lose it.
    if (CASE.sceneImageUrl) {
      const fig = el("figure", "reader-scene");
      const img = el("img");
      img.src = CASE.sceneImageUrl;
      img.alt = CASE.sceneImage || CASE.setting || "the scene";
      img.loading = "lazy";
      fig.appendChild(img);
      if (CASE.setting) fig.appendChild(el("figcaption", null, CASE.setting));
      doc.appendChild(fig);
    }
    doc.appendChild(el("p", "reader-text", CASE.openingScene));
    const tools = el("div", "reader-tools");
    const nar = el("button", "ghost", "🔊 hear the report read aloud");
    const narWrap = el("span", "reader-narr");
    narWrap.appendChild(nar);
    narWrap.appendChild(el("span", "narr-status"));
    nar.onclick = () => narrate(nar, CASE.openingScene, "opening");
    tools.appendChild(narWrap);
    const poi = el("button", "ghost", "👥 persons of interest");
    poi.onclick = () => playIntro(true);
    tools.appendChild(poi);
    if (accused) {
      const res = el("button", "ghost", "📜 case resolution");
      res.onclick = () => showReveal(false);
      tools.appendChild(res);
    } else {
      const acc = el("button", "stamp-btn", "⚖ Make Accusation");
      acc.onclick = () => showAccuse();
      tools.appendChild(acc);
    }
    doc.appendChild(tools);
    // strip of persons of interest for quick jumps into the Lineup Room
    const strip = el("div", "reader-strip");
    for (const s of CASE.suspects) {
      const c = el("button", "reader-poi");
      c.appendChild(makePortrait(s.name, s.portrait));
      c.appendChild(el("span", null, s.name.split(" ")[0]));
      c.onclick = () => openChat(s);
      strip.appendChild(c);
    }
    b.appendChild(doc);
    b.appendChild(strip);
    // The desk report is annotatable but this reader is a fresh node, so it
    // gets no pen from Annotate's auto-init. Same key as the desk panel, so
    // marks made in either place show up in both.
    if (typeof Annotate !== "undefined") pane.restore = Annotate.attachReport(doc);
  }

  // ---------- VIEW: lineup room ----------
  function viewSuspects(pane) {
    const b = pane.body;
    const grid = el("div", "lineup-grid");
    for (const s of CASE.suspects) {
      const n = clueCountFor(s.name);
      const card = el("button", "lineup-card");
      card.appendChild(makePortrait(s.name, s.portrait));
      const meta = el("span", "lineup-meta");
      meta.appendChild(el("span", "lnm", s.name));
      meta.appendChild(el("span", "lrl", s.role));
      if (s.intro) meta.appendChild(el("span", "lintro", "“" + s.intro + "”"));
      if (n) meta.appendChild(el("span", "lcc", `${n} clue${n > 1 ? "s" : ""} pinned`));
      card.appendChild(meta);
      card.onclick = () => openChat(s);
      grid.appendChild(card);
    }
    b.appendChild(grid);
  }

  // ---------- VIEW: interrogation (docks the overlay's DOM) ----------
  function viewChat(pane) {
    // adopt the chat room's contents so all the fixed ids keep working
    const room = document.querySelector("#chat-overlay .room");
    const nodes = [...room.childNodes];
    const restores = nodes.map(n => adopt(n, pane.body));
    // restore last-to-first: each node's captured nextSibling is back in the
    // room before it is re-inserted (first-to-last breaks insertBefore)
    pane.restore = () => restores.slice().reverse().forEach(r => r());
    pane.body.classList.add("chat-docked");
    // the overlay's own "end interview" button is replaced by the pane's ✕
    const endBtn = pane.body.querySelector(".chat-head .end");
    if (endBtn) endBtn.style.display = "none";
  }
  function afterChatUndock() {
    const endBtn = document.querySelector("#chat-overlay .chat-head .end");
    if (endBtn) endBtn.style.display = "";
    currentSuspect = null;
  }

  function stageChat(s) {
    const existing = panes.find(p => p.view === "chat");
    if (!existing) {
      if (panes.length >= 2) {
        // Picking a suspect FROM the Lineup Room converts THAT pane into the
        // interrogation room — whatever the other pane held (notes, report,
        // board) stays put. Only when no lineup is docked do we take the
        // other pane's slot.
        const lineupIdx = panes.findIndex(p => p.view === "suspects");
        const slot = lineupIdx !== -1 ? lineupIdx : panes.length - 1;
        closePane(panes[slot].view, { keepStage: true });
        addPane("chat", { at: slot });
      } else {
        addPane("chat");
      }
    }
    populateChat(s);
    sfx("door");
    if (!touchOnly()) setTimeout(() => $("question").focus(), 80);
  }

  // ---------- VIEW: war room board ----------
  const NOTE_SIZES = { S: 132, M: 168, L: 216 };
  function viewBoard(pane) {
    const b = pane.body;
    b.classList.add("war-room");
    // toolbar
    const bar = el("div", "war-tools");
    const org = el("button", "ghost", "🧠 type up my notes");
    org.onclick = () => organizeNotes();
    const arr = el("button", "ghost", "🧹 auto-arrange");
    arr.onclick = () => autoArrange();
    bar.appendChild(org); bar.appendChild(arr);
    const rst = el("button", "ghost", "↺ reset board");
    rst.title = "Clear all note positions and board size";
    rst.onclick = () => resetBoard();
    bar.appendChild(rst);
    const sizeWrap = el("span", "war-sizes");
    sizeWrap.appendChild(el("span", "war-label", "note size"));
    for (const k of Object.keys(NOTE_SIZES)) {
      const sb = el("button", "war-size" + ((window.NOTE_W || 168) === NOTE_SIZES[k] ? " on" : ""), k);
      sb.onclick = () => {
        window.NOTE_W = NOTE_SIZES[k] === 168 ? null : NOTE_SIZES[k];
        b.style.setProperty("--notew", NOTE_SIZES[k] + "px");
        b.querySelectorAll(".war-size").forEach(x => x.classList.toggle("on", x === sb));
        renderClues();
      };
      sizeWrap.appendChild(sb);
    }
    bar.appendChild(sizeWrap);
    const str = el("button", "ghost", "🧵 strings on/off");
    str.onclick = () => b.classList.toggle("no-strings");
    bar.appendChild(str);
    // The archive drawer is a fixed overlay (z 130) so it already floats above
    // the Stage — but its only trigger lived in the desk tools bar, which the
    // war room doesn't adopt. Without this, tucked notes are unreachable in
    // fullscreen. data-archive-btn keeps the count in sync with the desk copy.
    const arch = el("button", "ghost", "🗃 archived (0)");
    arch.dataset.archiveBtn = "1";
    arch.onclick = () => toggleArchiveDrawer();
    bar.appendChild(arch);
    b.appendChild(bar);
    updateArchiveBtn(); // paint the real count now that the button exists
    // adopt the live corkboard field (keeps #boardfield + #strings ids valid)
    const field = $("boardfield");
    pane.restore = adopt(field, b);
    if (window.NOTE_W) b.style.setProperty("--notew", window.NOTE_W + "px");
    renderClues();
  }
  function afterBoardUndock() {
    window.NOTE_W = null;
    renderClues();
  }

  // ---------- VIEW: evidence locker ----------
  function viewEvidence(pane) {
    const b = pane.body;
    if (!CASE.evidence.length) {
      b.appendChild(el("p", "locker-empty", "No physical evidence in this case — it's all in the testimony."));
      return;
    }
    const grid = el("div", "locker-grid");
    for (const ev of CASE.evidence) {
      const done = examined.includes(ev.id);
      const tag = el("button", "locker-tag" + (done ? " examined" : ""));
      tag.appendChild(el("span", "lt-name", ev.name));
      tag.appendChild(el("span", "lt-state", done ? "EXAMINED ✓ — hold to the lamp again" : "UNEXAMINED — tap to inspect"));
      tag.onclick = () => openEvidence(ev); // lamp overlay floats above the stage
      grid.appendChild(tag);
    }
    b.appendChild(grid);
  }

  // ---------- VIEW: board of suspicion ----------
  // Adopts the live #ranking node rather than rebuilding it, so the sliders,
  // band chips and persist() wiring all keep working untouched. Fullscreen
  // buys width, so the rows lay out as a responsive grid instead of one
  // tall column.
  function viewRanking(pane) {
    const b = pane.body;
    b.classList.add("suspicion-room");

    const bar = el("div", "war-tools");
    const hint = el("span", "war-label", "drag a slider or tap a band — nobody else sees this");
    bar.appendChild(hint);
    const cols = el("span", "war-sizes");
    cols.appendChild(el("span", "war-label", "columns"));
    for (const k of ["1", "2", "3"]) {
      const cb = el("button", "war-size" + (k === "2" ? " on" : ""), k);
      cb.onclick = () => {
        b.style.setProperty("--rank-cols", k);
        b.querySelectorAll(".war-size").forEach(x => x.classList.toggle("on", x === cb));
      };
      cols.appendChild(cb);
    }
    bar.appendChild(cols);
    b.appendChild(bar);

    const box = $("ranking");
    if (!box) { b.appendChild(el("p", "locker-empty", "No suspects on the board yet.")); return; }
    pane.restore = adopt(box, b);
    renderRanking();
  }

  const VIEWS = {
    file: viewFile,
    suspects: viewSuspects,
    chat: viewChat,
    board: viewBoard,
    ranking: viewRanking,
    evidence: viewEvidence
  };

  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "s" || e.key === "S") && opened && panes.length === 2) {
      e.preventDefault();
      swapPanes();
    }
  });

  return { open, close, isOpen, openChat: stageChat, appFullscreenSupported, swapPanes };
})();

// ---------- app-level fullscreen toggle (topbar ⛶) ----------
function toggleAppFullscreen() {
  const de = document.documentElement;
  const req = de.requestFullscreen || de.webkitRequestFullscreen;
  if (!req) {
    // iPhone Safari: no fullscreen API — point at the real alternative
    let toast = document.getElementById("fs-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "fs-toast";
      toast.style.cssText = "position:fixed;left:50%;bottom:4.5rem;transform:translateX(-50%);z-index:3000;" +
        "background:#efe6d0;color:#2c2519;font-size:0.85rem;padding:0.6rem 1rem;border-radius:4px;" +
        "box-shadow:0 8px 20px rgba(0,0,0,0.5);max-width:86vw;text-align:center;";
      document.body.appendChild(toast);
    }
    toast.textContent = "Full screen isn't available in this browser — on iPhone use Share → Add to Home Screen.";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.remove(), 3500);
    return;
  }
  if (document.fullscreenElement || document.webkitFullscreenElement)
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else
    req.call(de).catch(() => {});
}
