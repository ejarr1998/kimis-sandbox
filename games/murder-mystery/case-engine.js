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
  "evidence": [
    {
      "id": "short lowercase slug, e.g. 'call-log'",
      "name": "string — examinable object, e.g. 'Telephone call log', 'The victim's notebook'",
      "description": "string — what the detective sees when examining it",
      "reveals": ["string — 1-3 concrete facts this evidence establishes"]
    }
  ],
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
- Exactly 3-4 evidence items: physical objects the detective can examine (documents, the body, objects at the scene). At least ONE keyClue must come from evidence rather than from any suspect, so interrogation alone is never enough.
- The case MUST be solvable: the killer's guilt must be deducible from facts inside suspects' "knows"/"secrets" plus evidence "reveals" — e.g. a broken alibi, knowledge only the killer would have, a contradicting witness, a damning document.
- Distribute clues so at least 3 different suspects hold pieces of the solution.
- Suspects must NEVER need to reference people outside the 6 suspects and the victim — if a fact needs a source, it belongs in an evidence item, not an invented bystander.
- Red herrings welcome, but they must be resolvable as innocent.
- NAMES: each character has exactly ONE full name, used identically in every field of the document. Double-check every mention before finishing — a name spelled two ways (e.g. "Frost" vs "Voss") is a fatal defect.
- IMPORTANT: randomize ordering — do NOT put the killer first among suspects, and do NOT put the true weapon/location first in their lists.
- Victim era/setting: pick something atmospheric (1920s jazz club, remote lighthouse, luxury train, vineyard estate, small-town radio station...). Be original.`;

  const VALIDATE_PROMPT = (caseJson) => `You are a ruthless logic auditor for murder mysteries. Here is a case file:

${JSON.stringify(caseJson)}

Perform THREE audits:

AUDIT A — Name consistency: extract the canonical full name of every suspect and the victim. Search the ENTIRE document (all knows, secrets, alibis, evidence, keyClues, recap, openingScene) for any mention that uses a DIFFERENT or MISSPELLED variant of those names (e.g. "Voss" when the roster says "Frost", "Dr. Rousseau" when the roster says "Dr. Rousseau-Lane"). Any near-match surname that differs from the canonical one counts as a defect. Note: a character being referred to by first name, last name, or title+last name is fine as long as the spelling matches canon.

AUDIT B — World closure: no suspect's scripted facts may depend on people outside the suspect roster and victim.

AUDIT C — Solvability: simulate a sharp detective who can only learn facts in suspects' "knows"/"secrets" (secrets only via very pointed questions) and evidence items' "reveals". The killer, weapon AND location must all be deducible without guessing, and every keyClue must be reachable.

Answer STRICT JSON:
{
  "solvable": true/false,
  "consistent": true/false,
  "issues": ["string — each problem found"],
  "fixes": [
    { "find": "string — exact wrong text as it appears, e.g. 'Helena Voss' or 'Voss'",
      "replace": "string — correct text, e.g. 'Helena Frost' or 'Frost'" }
  ],
  "patches": [
    { "suspectId": "string or null", "evidenceId": "string or null",
      "addKnowledge": "string — ONE fact to inject into that suspect's knows[] or that evidence's reveals[] to fix a logic gap" }
  ]
}
Rules: use fixes[] for name/consistency repairs (max 6), patches[] for solvability gaps (max 3). Set solvable=false AND consistent=false only for fundamentally broken cases with no repair path.`;

  function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI did not return JSON");
    return JSON.parse(m[0]);
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- Stage 1: generate ----------
  async function generateCase(onStatus) {
    onStatus?.("🖋 Claude is writing the case…");
    const raw = await SandboxAPI.claude(GEN_PROMPT, { maxTokens: 4500 });
    const caseFile = extractJson(raw);
    caseFile.suspects.forEach(s => { s.portrait = null; });
    caseFile.evidence = caseFile.evidence || [];
    // Never trust the generator's ordering — shuffle lists so answers don't leak by position.
    caseFile.suspects = shuffle(caseFile.suspects);
    caseFile.weapons = shuffle(caseFile.weapons);
    caseFile.locations = shuffle(caseFile.locations);
    return caseFile;
  }

  // ---------- Stage 2: validate + patch ----------
  function applyFixes(caseFile, fixes) {
    let applied = 0;
    // Longest "find" first so specific phrases are replaced before bare surnames.
    const sorted = [...fixes].filter(f => f.find && f.replace && f.find !== f.replace)
      .sort((a, b) => b.find.length - a.find.length);
    let json = JSON.stringify(caseFile);
    for (const f of sorted) {
      if (json.includes(f.find)) {
        json = json.split(f.find).join(f.replace);
        applied++;
      }
    }
    return { caseFile: JSON.parse(json), applied };
  }

  async function validateAndPatch(caseFile, onStatus) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      onStatus?.(`🔍 Case audit (pass ${attempt})…`);
      const raw = await SandboxAPI.claude(VALIDATE_PROMPT(caseFile), { maxTokens: 2000 });
      const verdict = extractJson(raw);
      const needsFix = verdict.consistent === false && (verdict.fixes || []).length > 0;
      if (verdict.solvable && !needsFix) return { caseFile, issues: verdict.issues || [] };

      let changed = false;
      if (needsFix) {
        const res = applyFixes(caseFile, verdict.fixes);
        caseFile = res.caseFile;
        changed = res.applied > 0;
        onStatus?.(`✏️ Name consistency repairs: ${res.applied}…`);
      }
      const patches = verdict.patches || [];
      if (!verdict.solvable && patches.length) {
        onStatus?.(`🩹 Patching: ${patches.length} clue fix(es)…`);
        for (const p of patches) {
          if (p.suspectId) {
            const s = caseFile.suspects.find(x => x.id === p.suspectId);
            if (s && p.addKnowledge) { s.knows.push(p.addKnowledge); changed = true; }
          } else if (p.evidenceId) {
            const ev = caseFile.evidence.find(x => x.id === p.evidenceId);
            if (ev && p.addKnowledge) { ev.reveals.push(p.addKnowledge); changed = true; }
          }
        }
      }
      if (!changed) {
        throw new Error("Case failed audit and could not be repaired: " + (verdict.issues || []).join("; "));
      }
    }
    throw new Error("Case still failing audit after 3 repair attempts.");
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
    return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)].join ? letters[Math.floor(Math.random() * letters.length)] : "").join("");
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
      await ref.set({ joinedAt: new Date().toISOString(), clues: [], chats: {}, examined: [], accusation: null });
    }
    return ref;
  }

  return { generateCase, validateAndPatch, generatePortraits, saveCase, loadCase, joinCase };
})();
