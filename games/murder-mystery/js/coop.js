/* ==========================================================================
   Dead Air — Buddy Cop mode
   --------------------------------------------------------------------------
   Two or more detectives work ONE shared investigation: one transcript per
   suspect, one clue board, live typing indicators.

   The core problem this solves: if two browsers each call Claude against the
   same suspect at the same moment, you get two replies that know nothing about
   each other and the suspect contradicts herself. So each suspect's room has a
   "floor" — a soft lock held by whoever is actively questioning. Everyone can
   read the room live; only the floor holder can send.

   Nothing here runs unless the case was created in coop mode. Solo cases take
   the original code paths untouched.

   Firestore layout (all under cases/{CODE}):
     interrogations/{suspectId}                floor: { by, at, typing, generating }
     interrogations/{suspectId}/messages/{id}  { role, text, by, at }
     shared/clues                              { clues: [...] }
     presence/{detective}                      { at, viewing }
   ========================================================================== */
const Coop = (() => {
  "use strict";

  // How long a floor survives without a heartbeat, by state. Generating gets a
  // long leash because a slow Claude call must never be interrupted; the value
  // is a crash failsafe, not a normal timeout.
  const GRACE = { generating: 120000, typing: 15000, idle: 25000 };
  const HEARTBEAT_MS = 3000;   // while holding the floor
  const PRESENCE_MS  = 20000;  // "still on the case" ping

  let db = null, CODE = null, ME = null, active = false;
  let clockOffset = 0;         // serverNow() - Date.now()
  let heartbeatTimer = null, presenceTimer = null;
  let heldSuspect = null;      // suspect id whose floor we currently hold
  let amTyping = false;
  const unsubs = [];

  /* ---------- clock ----------------------------------------------------
     Every staleness decision compares two machines' timestamps, so browser
     clock skew would let a client declare a live floor dead and steal it.
     Calibrate once against the server and do all math in server time. */
  async function calibrate() {
    try {
      const ref = db.collection("cases").doc(CODE).collection("_clock").doc(ME);
      const t0 = Date.now();
      await ref.set({ t: firebase.firestore.FieldValue.serverTimestamp() });
      const snap = await ref.get({ source: "server" });
      const t1 = Date.now();
      const server = snap.data().t.toMillis();
      clockOffset = server - (t0 + t1) / 2;   // midpoint of the round trip
    } catch (e) {
      clockOffset = 0; // fall back to local time; skew risk, but never fatal
      console.warn("[Coop] clock calibration failed, using local time:", e.message);
    }
  }
  const serverNow = () => Date.now() + clockOffset;

  /* ---------- refs ---------- */
  const caseRef   = () => db.collection("cases").doc(CODE);
  const roomRef   = (sid) => caseRef().collection("interrogations").doc(sid);
  const msgsRef   = (sid) => roomRef(sid).collection("messages");
  const cluesRef  = () => caseRef().collection("shared").doc("clues");
  const presRef   = (name) => caseRef().collection("presence").doc(name);

  /* ---------- floor ---------- */
  function floorState(f) {
    if (!f || !f.by) return { free: true };
    const grace = f.generating ? GRACE.generating : (f.typing ? GRACE.typing : GRACE.idle);
    const age = serverNow() - (f.at || 0);
    if (age > grace) return { free: true, expired: true };
    return { free: false, by: f.by, typing: !!f.typing, generating: !!f.generating,
             mine: f.by === ME, expiresIn: Math.max(0, grace - age) };
  }

  // Claim on FIRST KEYSTROKE, not on send: the other detective should find out
  // before composing a paragraph, not after. Returns true if we hold the floor.
  async function claimFloor(sid) {
    if (!active) return true;
    try {
      const got = await db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef(sid));
        const st = floorState(snap.exists ? snap.data().floor : null);
        if (!st.free && !st.mine) return false;
        tx.set(roomRef(sid), {
          floor: { by: ME, at: serverNow(), typing: true, generating: false }
        }, { merge: true });
        return true;
      });
      if (got) { heldSuspect = sid; amTyping = true; startHeartbeat(); }
      return got;
    } catch (e) {
      console.warn("[Coop] claimFloor failed:", e.message);
      return false; // fail closed: better to block than to double-ask
    }
  }

  async function setFloorFlags(sid, patch) {
    if (!active || heldSuspect !== sid) return;
    try {
      await roomRef(sid).set({
        floor: Object.assign({ by: ME, at: serverNow() }, patch)
      }, { merge: true });
    } catch (e) { /* heartbeat will retry */ }
  }

  const setTyping    = (sid, on) => { amTyping = on; return setFloorFlags(sid, { typing: on, generating: false }); };
  const setGenerating = (sid, on) => setFloorFlags(sid, { typing: false, generating: on });

  async function releaseFloor(sid) {
    if (!active) return;
    const target = sid || heldSuspect;
    if (!target) return;
    stopHeartbeat();
    heldSuspect = null; amTyping = false;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef(target));
        const f = snap.exists ? snap.data().floor : null;
        if (f && f.by !== ME) return;              // someone already took it
        tx.set(roomRef(target), { floor: null }, { merge: true });
      });
    } catch (e) { /* it will expire on its own */ }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!heldSuspect) return stopHeartbeat();
      setFloorFlags(heldSuspect, { typing: amTyping });
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() { clearInterval(heartbeatTimer); heartbeatTimer = null; }

  /* ---------- transcript ----------
     `at` is a calibrated millisecond number rather than serverTimestamp() so
     that ordering works immediately on the writing client — serverTimestamp is
     null until the server acks, which makes freshly sent messages jump. */
  async function postMessage(sid, msg) {
    const doc = { role: msg.role, text: msg.text, by: msg.by || ME, at: serverNow() };
    await msgsRef(sid).add(doc);
    return doc;
  }

  function watchRoom(sid, onMessages, onFloor) {
    const a = msgsRef(sid).orderBy("at").onSnapshot(
      (snap) => onMessages(snap.docs.map(d => d.data())),
      (e) => console.warn("[Coop] transcript listener:", e.message));
    const b = roomRef(sid).onSnapshot(
      (snap) => onFloor(floorState(snap.exists ? snap.data().floor : null)),
      (e) => console.warn("[Coop] floor listener:", e.message));
    unsubs.push(a, b);
    return () => { a(); b(); };
  }

  /* ---------- shared clues ---------- */
  async function addClues(clues) {
    if (!clues.length) return;
    await cluesRef().set({
      clues: firebase.firestore.FieldValue.arrayUnion(...clues)
    }, { merge: true });
  }
  function watchClues(cb) {
    const u = cluesRef().onSnapshot(
      (snap) => cb((snap.exists && snap.data().clues) || []),
      (e) => console.warn("[Coop] clue listener:", e.message));
    unsubs.push(u);
    return u;
  }
  // Full-array write for edits (arrayUnion can only append). Two detectives
  // editing different notes at the same instant is last-writer-wins — the
  // listener then repaints both boards with the surviving array.
  async function setClues(clues) {
    if (!active) return;
    await cluesRef().set({ clues }, { merge: true });
  }

  /* ---------- joint warrant ----------
     One warrant per case, co-signed. A signature records exactly WHAT was
     signed (`on`); if any field later changes, the recorded text no longer
     matches the live warrant and the signature is treated as void. That makes
     "editing voids signatures" fall out of a comparison rather than a
     race-prone cascade of writes. */
  const warrantRef = () => caseRef().collection("warrant").doc("joint");

  // Canonical fingerprint of the charge. Signatures are bound to this string.
  function chargeOf(w) {
    return [w.killerId || "", (w.weapon || "").trim().toLowerCase(),
            (w.location || "").trim().toLowerCase(),
            (w.motive || "").trim().toLowerCase()].join("|");
  }
  function validSignatures(w) {
    const charge = chargeOf(w);
    const sigs = w.signatures || {};
    return Object.keys(sigs).filter(n => sigs[n] && sigs[n].on === charge);
  }

  async function updateWarrant(patch) {
    if (!active) return;
    await warrantRef().set(
      Object.assign({}, patch, { updatedAt: serverNow(), updatedBy: ME }),
      { merge: true });
  }

  async function signWarrant() {
    if (!active) return { ok: false };
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(warrantRef());
      const w = snap.exists ? snap.data() : {};
      if (w.sealed) return { ok: false, reason: "sealed" };
      if (!w.killerId || !(w.weapon || "").trim() || !(w.location || "").trim() ||
          !(w.motive || "").trim())
        return { ok: false, reason: "incomplete" };
      const sigs = Object.assign({}, w.signatures);
      sigs[ME] = { at: serverNow(), on: chargeOf(w) };
      tx.set(warrantRef(), { signatures: sigs }, { merge: true });
      return { ok: true, signatures: sigs, charge: chargeOf(w) };
    });
  }

  async function unsignWarrant() {
    if (!active) return;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(warrantRef());
      if (!snap.exists || snap.data().sealed) return;
      const sigs = Object.assign({}, snap.data().signatures);
      delete sigs[ME];
      tx.set(warrantRef(), { signatures: sigs }, { merge: true });
    });
  }

  // Seals exactly once, no matter how many clients notice completion at the
  // same instant: the transaction re-checks `sealed` before writing.
  async function sealWarrant(buildVerdict) {
    if (!active) return null;
    const pre = await warrantRef().get();
    const w = pre.exists ? pre.data() : {};
    if (w.sealed) return null;
    const verdict = await buildVerdict(w);   // the audit call; slow, so outside the tx
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(warrantRef());
      const cur = snap.data() || {};
      if (cur.sealed) return null;                       // someone else won
      if (chargeOf(cur) !== chargeOf(w)) return null;    // charge changed mid-audit
      tx.set(warrantRef(), { sealed: true, verdict, sealedAt: serverNow() }, { merge: true });
      return verdict;
    });
  }

  function watchWarrant(cb) {
    const u = warrantRef().onSnapshot(
      (snap) => cb(snap.exists ? snap.data() : {}),
      (e) => console.warn("[Coop] warrant listener:", e.message));
    unsubs.push(u);
    return u;
  }

  /* ---------- presence ---------- */
  function startPresence() {
    const ping = () => presRef(ME).set({ at: serverNow() }, { merge: true }).catch(() => {});
    ping();
    presenceTimer = setInterval(ping, PRESENCE_MS);
  }
  function watchPresence(cb) {
    const u = caseRef().collection("presence").onSnapshot((snap) => {
      const cutoff = serverNow() - PRESENCE_MS * 3; // ~1 min of silence = gone
      cb(snap.docs.filter(d => (d.data().at || 0) > cutoff).map(d => d.id));
    }, (e) => console.warn("[Coop] presence listener:", e.message));
    unsubs.push(u);
    return u;
  }

  /* ---------- lifecycle ---------- */
  async function init({ code, detective, mode }) {
    active = mode === "coop";
    if (!active) return false;
    await SandboxAPI.firebaseApp();
    db = firebase.firestore();
    CODE = code; ME = detective;
    await calibrate();
    startPresence();
    // Best-effort tidy on close so a partner isn't stuck waiting out the grace
    // period. Not load-bearing: the timeout covers a hard crash.
    window.addEventListener("pagehide", () => { if (heldSuspect) releaseFloor(heldSuspect); });
    return true;
  }

  function teardown() {
    stopHeartbeat();
    clearInterval(presenceTimer);
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs.length = 0;
  }

  return { init, isActive: () => active, me: () => ME, serverNow,
           claimFloor, releaseFloor, setTyping, setGenerating, heldSuspect: () => heldSuspect,
           postMessage, watchRoom, addClues, setClues, watchClues, watchPresence, teardown,
           updateWarrant, signWarrant, unsignWarrant, sealWarrant, watchWarrant,
           validSignatures, chargeOf };
})();
