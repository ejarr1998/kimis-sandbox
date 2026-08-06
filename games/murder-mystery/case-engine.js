/**
 * Dead Air — case engine
 * Case generation (Claude) → solvability validation → patching → portraits (Grok).
 * Case files are stored in Firestore under a 4-letter join code:
 *   cases/{CODE}           — the locked case file
 *   cases/{CODE}/players/{name} — per-player progress (clues, chats, accusation)
 */

const CaseEngine = (() => {

  const CASE_SCHEMA = `{
  "title": "string — evocative case title",
  "setting": "string — 2-3 sentence world/location description",
  "victim": { "name": "string", "description": "string — who they were, how found" },
  "artStyle": "string — ONE consistent portrait style, e.g. 'moody noir pencil sketch, dramatic shadows, muted sepia tones'. Applied verbatim to every portrait.",
  "solution": {
    "killerId": "string — id of the true killer from suspects",
    "weapon": "string", "location": "string", "motive": "string",
    "recap": "string — 150-word dramatic narration of how the murder actually happened"
  },
  "weapons": ["string — 5-7 plausible weapons, including the true one"],
  "locations": ["string — 5-7 plausible locations, including the true one"],
  "keyClues": ["string — the 5-8 facts a sharp detective MUST uncover to solve it"],
  "openingScene": "string — 120-word second-person narration setting the scene for the detective",
  "suspects": [
    {
      "id": "short lowercase slug, e.g. 'mara'",
      "name": "string", "role": "string — relationship to victim",
      "physical": "string — detailed appearance for portrait generation",
      "personality": "string — speech style notes for roleplay",
      "alibi": "string — what they claim they were doing",
      "knows": ["string — facts they will reveal IF asked precisely"],
      "secrets": ["string — things they hide; revealed only by very pointed questions"],
      "liar": false
    }
  ]
}`;

  const GEN_PROMPT = `You are a master mystery writer. Generate ONE complete, original murder mystery case as STRICT JSON (no markdown fences, no commentary) matching this schema exactly:

${CASE_SCHEMA}

Requirements:
- Exactly 6 suspects. Exactly ONE is the killer (liar: true). One OTHER suspect may also be a liar about something unrelated (a red herring). Everyone else lies only by omission.
- The case MUST be solvable: the killer's guilt must be deducible from facts inside suspects' "knows"/"secrets" — e.g. a broken alibi, knowledge only the killer would have, a contradicting witness.
- Distribute clues so at least 3 different suspects hold pieces of the solution.
- Red herrings welcome, but they must be resolvable as innocent.
- Victim era/setting: pick something atmospheric (1920s jazz club, remote lighthouse, luxury train, vineyard estate, small-town radio station...). Be original.`;

  const VALIDATE_PROMPT = (caseJson) => `You are a ruthless logic auditor for murder mysteries. Here is a case file:

${JSON.stringify(caseJson)}

Simulate a sharp detective who can only learn facts in suspects' "knows" and "secrets" (secrets only via very pointed questions). Answer STRICT JSON:
{
  "solvable": true/false,
  "issues": ["string — each logical problem: unreachable clue, contradiction, insufficient distinguishing evidence, etc."],
  "patches": [
    { "suspectId": "string", "addKnowledge": "string — ONE fact to inject into that suspect's knows[] that fixes a gap" }
  ]
}
Rules: solvable=true ONLY if the killer, weapon AND location can all be deduced without guessing. If small fixes suffice, give patches (max 3). If the case is fundamentally broken, set solvable=false with empty patches.`;

  function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI did not return JSON");
    return JSON.parse(m[0]);
  }

  // ---------- Stage 1: generate ----------
  async function generateCase(onStatus) {
    onStatus?.("🖋 Claude is writing the case…");
    const raw = await SandboxAPI.claude(GEN_PROMPT, { maxTokens: 4000 });
    const caseFile = extractJson(raw);
    caseFile.suspects.forEach(s => { s.portrait = null; });
    return caseFile;
  }

  // ---------- Stage 2: validate + patch ----------
  async function validateAndPatch(caseFile, onStatus) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      onStatus?.(`🔍 Solvability audit (pass ${attempt})…`);
      const raw = await SandboxAPI.claude(VALIDATE_PROMPT(caseFile), { maxTokens: 1500 });
      const verdict = extractJson(raw);
      if (verdict.solvable) return { caseFile, issues: verdict.issues || [] };
      if (!verdict.patches || verdict.patches.length === 0) {
        throw new Error("Case failed validation and could not be patched: " + (verdict.issues || []).join("; "));
      }
      onStatus?.(`🩹 Patching: ${verdict.patches.length} clue fix(es)…`);
      for (const p of verdict.patches) {
        const s = caseFile.suspects.find(x => x.id === p.suspectId);
        if (s && p.addKnowledge) s.knows.push(p.addKnowledge);
      }
    }
    throw new Error("Case still not solvable after 3 patch attempts.");
  }

  // ---------- Stage 3: portraits ----------
  async function generatePortraits(caseFile, onStatus) {
    for (let i = 0; i < caseFile.suspects.length; i++) {
      const s = caseFile.suspects[i];
      onStatus?.(`🎨 Painting portrait ${i + 1}/${caseFile.suspects.length}: ${s.name}…`);
      try {
        const img = await SandboxAPI.grokImage(
          `${caseFile.artStyle}. Character portrait of ${s.name}, ${s.role}. ${s.physical}. Head-and-shoulders, centered, no text.`);
        s.portrait = img.url;
      } catch (e) {
        s.portrait = null; // game shows initial-letter avatar fallback
      }
    }
    return caseFile;
  }

  // ---------- Firestore ----------
  function makeCode() {
    const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
    return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  }

  async function saveCase(caseFile) {
    await SandboxAPI.firebaseApp();
    const db = firebase.firestore();
    const code = makeCode();
    await db.collection("cases").doc(code).set({
      ...caseFile,
      status: "ready",
      createdAt: new Date().toISOString()
    });
    return code;
  }

  async function loadCase(code) {
    await SandboxAPI.firebaseApp();
    const snap = await firebase.firestore().collection("cases").doc(code.toUpperCase().trim()).get();
    if (!snap.exists) throw new Error("No case found with code " + code);
    return snap.data();
  }

  async function joinCase(code, detectiveName) {
    await SandboxAPI.firebaseApp();
    const ref = firebase.firestore().collection("cases").doc(code.toUpperCase().trim())
      .collection("players").doc(detectiveName.trim());
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ joinedAt: new Date().toISOString(), clues: [], chats: {}, accusation: null });
    }
    return ref;
  }

  return { generateCase, validateAndPatch, generatePortraits, saveCase, loadCase, joinCase };
})();
