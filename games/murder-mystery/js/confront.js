/**
 * Dead Air — confrontations
 *
 * Suspects are sealed off from each other by default: nothing said to Mara ever
 * reaches Owen. This module adds the one exception, the classic detective move —
 * walk one suspect into another's interrogation and let them talk.
 *
 * Two rules make it work:
 *   1. Only what is said ALOUD IN THE ROOM, with both present, becomes shared.
 *      A suspect never inherits a transcript they weren't in.
 *   2. What they witness persists. Interview either of them alone afterwards and
 *      they remember the exchange, and can be held to it.
 *
 * Storage: witnessed[suspectId] = ["Detective → Mara: …", "Mara: …", "Owen: …"]
 * Flat strings, because they get injected verbatim into a system prompt.
 *
 * Reads game.js globals (CASE, DETECTIVE) lazily, inside functions only.
 */
const Confront = (() => {
  "use strict";

  const MAX_LINES = 40;   // per suspect, oldest dropped — keeps prompts bounded
  const MAX_INJECT = 24;  // most recent lines actually fed back into a prompt

  let witnessed = {};
  let escort = null;      // the suspect currently brought into the room

  const load = (data) => { witnessed = (data && typeof data === "object") ? data : {}; };
  const all = () => witnessed;
  const escorted = () => escort;
  const setEscort = (s) => { escort = s || null; };
  const clear = () => { escort = null; };

  function push(id, lines) {
    const log = witnessed[id] || (witnessed[id] = []);
    log.push(...lines);
    if (log.length > MAX_LINES) log.splice(0, log.length - MAX_LINES);
  }

  // Record an exchange into BOTH participants' memories. This is the only way
  // anything crosses between suspects.
  function record(primary, other, lines) {
    push(primary.id, lines);
    push(other.id, lines);
  }

  // Injected into suspectPrompt() so a suspect interviewed later still recalls
  // what happened while they were standing there.
  function memoryFor(id) {
    const log = witnessed[id];
    if (!log || !log.length) return "";
    return `
THINGS YOU PERSONALLY WITNESSED (you were in the room and heard all of this — you remember it and may be held to it):
${log.slice(-MAX_INJECT).join("\n")}
If someone said something here that you know to be false, you may say so. If YOU said something here, you are stuck with it: contradicting yourself now is something the detective will notice.`;
  }

  // Everyone the detective has actually interviewed, minus whoever is in the
  // room. You can't march in a stranger you've never spoken to.
  function available(currentId, chats) {
    return (CASE.suspects || []).filter(s =>
      s.id !== currentId && chats[s.id] && chats[s.id].length);
  }

  // One call plays both characters. The hard constraint is leakage: both sets of
  // secrets sit in this prompt, so it must be spelled out that neither may voice
  // the other's private knowledge.
  function roomPrompt(primary, other, describe) {
    return `You are staging a two-hander interrogation scene. ${DETECTIVE} has brought ${other.name} into the room where ${primary.name} is being questioned. Both are present and can hear everything.

CHARACTER 1 — ${primary.name}
${describe(primary)}

CHARACTER 2 — ${other.name}
${describe(other)}

SCENE RULES:
1. Output ONLY dialogue lines in this exact format, one per line:
${primary.name}: <what they say>
${other.name}: <what they say>
2. The detective's question is aimed at the room. Whoever it most concerns speaks first. The other speaks ONLY if they have a genuine reason to — agreement, contradiction, alarm, or a demand to be left out of it. It is fine for only one of them to speak.
3. ABSOLUTE: neither character may state, hint at, or act on anything from the OTHER character's private knowledge or secrets. They only know what that person has actually said out loud, here or in a previously witnessed scene. Getting this wrong ruins the mystery.
4. They may contradict each other, and should when their accounts genuinely clash. Being caught out is the point of this scene. A character caught in a contradiction squirms, deflects, or gets angry — they do not calmly confess.
5. Each character keeps their own voice, their own rules about lying, and their own refusal to confess to murder.
6. Max 55 words per character. No narration outside the dialogue lines, no stage directions except brief *asterisks* inside a line.`;
  }

  // Split "Name: line" output back into structured turns. Unlabelled text is
  // attributed to the primary speaker rather than dropped.
  function parseRoom(text, primary, other) {
    const out = [];
    const names = [primary, other];
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let matched = null;
      for (const s of names) {
        const first = s.name.split(" ")[0];
        const rx = new RegExp("^\\s*(?:" + esc(s.name) + "|" + esc(first) + ")\\s*:\\s*", "i");
        if (rx.test(line)) { matched = { who: s, text: line.replace(rx, "").trim() }; break; }
      }
      if (matched) { if (matched.text) out.push(matched); }
      else if (out.length) out[out.length - 1].text += " " + line;
      else out.push({ who: primary, text: line });
    }
    return out.filter(t => t.text);
  }

  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return { load, all, record, memoryFor, available, roomPrompt, parseRoom,
           setEscort, escorted, clear };
})();
