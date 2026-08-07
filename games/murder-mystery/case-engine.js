/**
 * Dead Air — case engine
 * Case generation (Claude) → solvability validation → patching → portraits (Grok).
 * Case files are stored in Firestore under a 4-letter join code:
 *   cases/{CODE}           — the locked case file
 *   cases/{CODE}/players/{name} — per-player progress (clues, chats, accusation)
 */

const CaseEngine = (() => {

  // Settings deck — one is dealt at random per case so the AI can't fall
  // back on a favorite (it kept generating observatories). A host can
  // override the deck by requesting their own setting.
  const SETTINGS = [
    "a 1920s jazz club on the riverfront",
    "a remote lighthouse during a storm",
    "the dining car of a luxury overnight train",
    "a family vineyard estate at harvest time",
    "a small-town radio station during a live broadcast",
    "a traveling circus on its final night in town",
    "a grand alpine hotel snowed in by an avalanche",
    "an auction house the night of a record-breaking sale",
    "a university library's restricted archives wing",
    "a film studio backlot during a night shoot",
    "an art gallery on the eve of a controversial exhibition",
    "a fishing harbor cannery at the end of the season",
    "a mountain sanatorium in the 1930s",
    "a botanical garden's glass conservatory gala",
    "an old printing press warehouse",
    "a chess tournament at a seaside resort",
    "a monastery famous for its illuminated manuscripts",
    "a speakeasy hidden behind a barbershop",
    "an opera house on opening night",
    "a research station in the Antarctic winter",
    "a riverboat casino crossing state lines",
    "a fashion house the week of the big show",
    "a natural history museum's new dinosaur wing",
    "a radio telescope array in the desert",
    "a boarding school over a foggy autumn weekend",
    "a hot springs resort in the mountains",
    "an antique map dealership's private vault",
    "a community theater's dress rehearsal",
    "a vineyard harvest festival in the 1950s",
    "a clockmaker's shop filled with antique timepieces",
    "a Grand Prix pit lane in the 1960s",
    "a small island reachable only by tide",
    "a royal pastry competition's final day",
    "an observatory on a remote mountain peak",
    "a newspaper office the night of a big scoop",
    "a perfume atelier with a secret formula",
    "a ski lodge cut off by a blizzard",
    "an aquarium's after-hours donor dinner",
    "a lighthouse keeper's retirement party",
    "a traveling book fair's closing banquet"
  ];

  const CASE_SCHEMA = `{
  "title": "string — evocative case title",
  "setting": "string — 2-3 sentence world/location description",
  "victim": { "name": "string", "description": "string — who they were, how found" },
  "artStyle": "string — ONE consistent portrait style that fits this case's era and mood, e.g. 'moody noir pencil sketch, dramatic shadows, muted sepia tones' for a period case, or 'grainy smartphone photo, fluorescent lighting, desaturated colors' for a modern case. Applied verbatim to every portrait.",
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
      "intro": "string — ONE punchy noir line (max 20 words) introducing this suspect to the detective: who they are and your first impression, e.g. 'The victim's business partner. Smiles like he's counting your money.' Never hint at guilt or innocence.",
      "physical": "string — detailed appearance for portrait generation",
      "personality": "string — speech style notes for roleplay",
      "alibi": "string — what they claim they were doing",
      "knows": ["string — facts they will reveal IF asked precisely"],
      "secrets": ["string — things they hide; revealed only by very pointed questions"],
      "liar": false
    }
  ]
}`;

  const GEN_PROMPT = (setting, custom) => `You are a master mystery writer. Generate ONE complete, original murder mystery case as STRICT JSON (no markdown fences, no commentary) matching this schema exactly:

${CASE_SCHEMA}

THE SETTING FOR THIS CASE IS ALREADY CHOSEN — you MUST use it: ${setting}.
Build everything (victim, suspects, weapons, locations, evidence, era, tone, artStyle) to fit that world.${custom ? " This setting was personally requested by the host — honor its specific details (brands, era, place) faithfully and lean into what makes it distinctive." : ""}

Requirements:
- Exactly 6 suspects. Exactly ONE is the killer (liar: true). One OTHER suspect may also be a liar about something unrelated (a red herring). Everyone else lies only by omission.
- Exactly 3-4 evidence items: physical objects the detective can examine (documents, the body, objects at the scene). At least ONE keyClue must come from evidence rather than from any suspect, so interrogation alone is never enough.
- The case MUST be solvable: the killer's guilt must be deducible from facts inside suspects' "knows"/"secrets" plus evidence "reveals" — e.g. a broken alibi, knowledge only the killer would have, a contradicting witness, a damning document.
- Distribute clues so at least 3 different suspects hold pieces of the solution.
- Suspects must NEVER need to reference people outside the 6 suspects and the victim — if a fact needs a source, it belongs in an evidence item, not an invented bystander.
- NO SMOKING GUNS: no single evidence item, no single suspect "knows" fact, and no single secret may BY ITSELF identify the killer, the weapon, or the location. Guilt must require combining at least 2-3 facts from different sources. The true weapon may appear only CIRCUMSTANTIALLY (e.g. "the ice scraper was recently cleaned and rehung", "a faint smell of bleach near the sink") — evidence descriptions must describe physical observations, never conclusions; writing "this was the murder weapon" or equivalent is forbidden.
- RED HERRINGS ARE MANDATORY: at least 2 innocent suspects must EACH have a genuine motive AND one piece of circumstantially suspicious behavior (something that looks bad but resolves innocent). Their innocence must be provable from facts present in the case.
- The killer's public behavior and knowledge must NOT make them the obvious prime suspect: no uniquely nervous behavior, and no "only the killer would know X" fact served early in their knows[] — such facts belong deep in their secrets[] and must require the detective to first learn X elsewhere.
- keyClues must be raw observable facts, never interpretations or conclusions.
- Every suspect needs an "intro" line — pure flavor for the meet-the-suspects sequence; it must NEVER leak or hint at who the killer is.
- Each suspect MUST have a UNIQUE name — no two suspects may share a first or last name.
- NAMES: each character has exactly ONE full name, used identically in every field of the document. Double-check every mention before finishing — a name spelled two ways (e.g. "Frost" vs "Voss") is a fatal defect.
- IMPORTANT: randomize ordering — do NOT put the killer first among suspects, and do NOT put the true weapon/location first in their lists.`;

  const VALIDATE_PROMPT = (caseJson) => `You are a ruthless logic auditor for murder mysteries. Here is a case file:

${JSON.stringify(caseJson)}

Perform FIVE audits:

AUDIT A — Name consistency: extract the canonical full name of every suspect and the victim. Search the ENTIRE document (all knows, secrets, alibis, evidence, keyClues, recap, openingScene) for any mention that uses a DIFFERENT or MISSPELLED variant of those names (e.g. "Voss" when the roster says "Frost"). Any near-match surname that differs from the canonical one counts as a defect. Note: a character being referred to by first name, last name, or title+last name is fine as long as the spelling matches canon. ALSO: every suspect's name must be UNIQUE — if two suspects share a first or last name (or any confusingly similar names), report it as an issue and supply a fixes[] entry renaming the duplicate everywhere it appears.

AUDIT B — World closure: no suspect's scripted facts may depend on people outside the suspect roster and victim.

AUDIT C — Solvability: simulate a sharp detective who can only learn facts in suspects' "knows"/"secrets" (secrets only via very pointed questions) and evidence items' "reveals". The killer, weapon AND location must all be deducible without guessing, and every keyClue must be reachable.

AUDIT D — Portrait safety: check every suspect's "physical" description (it feeds verbatim into portrait image generation). It must NOT contain anything incriminating or spoilery — e.g. bloodied clothing/items, a guilty expression, "hiding the knife", or behavior that reveals their role in the crime. If any does, report it as an issue and supply a fixes[] entry replacing the incriminating text with neutral appearance detail.

AUDIT E — Difficulty / telegraphing: the case must not give itself away.
- Flag if any single evidence description, single evidence "reveals" fact, or single suspect fact ALONE identifies the killer, weapon, or location (a smoking gun). Guilt should require combining 2-3 facts from different sources.
- Flag if FEWER than 2 innocent suspects have BOTH a genuine motive AND suspicious-but-resolvable circumstances.
- Flag if the true weapon is named outright in any evidence description AS the weapon (e.g. "the murder weapon"), rather than appearing only circumstantially.
- Flag if the killer is the obvious prime suspect on first meeting (uniquely nervous behavior, or an early knows[] fact only the killer could know).
Report these as issues; use patches[] to inject corrective knowledge (e.g. give an innocent suspect a motive or a circumstantial observation that complicates the picture), and use fixes[] to reword a too-direct fact into a neutral physical observation where it is a wording problem.

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
Rules: use fixes[] for name/consistency/portrait/wording repairs (max 6), patches[] for solvability and difficulty gaps (max 3). Set solvable=false AND consistent=false only for fundamentally broken cases with no repair path.`;

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

  // ---------- Deterministic structural validation ----------
  // Runs in code (no LLM). First performs gentle auto-repairs where safe,
  // then returns an array of remaining structural problems (empty = OK).
  function structuralCheck(caseFile) {
    const problems = [];
    const suspects = Array.isArray(caseFile.suspects) ? caseFile.suspects : [];
    const solution = caseFile.solution || {};
    const weapons = Array.isArray(caseFile.weapons) ? caseFile.weapons : [];
    const locations = Array.isArray(caseFile.locations) ? caseFile.locations : [];
    const evidence = Array.isArray(caseFile.evidence) ? caseFile.evidence : [];

    // Gentle auto-repair: trim exact-match whitespace on weapon/location.
    if (typeof solution.weapon === "string") {
      const trimmed = solution.weapon.trim();
      if (weapons.includes(trimmed)) solution.weapon = trimmed;
    }
    if (typeof solution.location === "string") {
      const trimmed = solution.location.trim();
      if (locations.includes(trimmed)) solution.location = trimmed;
    }
    // Gentle auto-repair: if killerId doesn't match but exactly one suspect
    // is flagged liar:true, that suspect is the intended killer.
    const liars = suspects.filter(s => s.liar === true);
    if (!suspects.some(s => s.id === solution.killerId) && liars.length === 1) {
      solution.killerId = liars[0].id;
    }

    if (suspects.length !== 6) {
      problems.push(`expected exactly 6 suspects, got ${suspects.length}`);
    }
    const ids = suspects.map(s => s.id);
    if (new Set(ids).size !== ids.length) {
      problems.push("suspect ids are not unique");
    }
    const names = suspects.map(s => (s.name || "").trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      problems.push("suspect names are not unique");
    }
    if (liars.length < 1 || liars.length > 2) {
      problems.push(`expected 1-2 suspects with liar:true (killer + optional red herring), got ${liars.length}`);
    }
    if (!suspects.some(s => s.id === solution.killerId)) {
      problems.push(`solution.killerId "${solution.killerId}" matches no suspect id`);
    }
    if (!weapons.includes(solution.weapon)) {
      problems.push(`solution.weapon "${solution.weapon}" is not in weapons[]`);
    }
    if (!locations.includes(solution.location)) {
      problems.push(`solution.location "${solution.location}" is not in locations[]`);
    }
    if (evidence.length < 3 || evidence.length > 4) {
      problems.push(`expected 3-4 evidence items, got ${evidence.length}`);
    }
    evidence.forEach((ev, i) => {
      if (!Array.isArray(ev.reveals)) {
        problems.push(`evidence[${i}] ("${ev.id || ev.name || "?"}") is missing a reveals[] array`);
      }
    });
    return problems;
  }

  // ---------- Stage 1: generate ----------
  // customSetting: optional host-requested setting; overrides the random deck.
  async function generateCase(onStatus, customSetting) {
    const custom = (customSetting || "").trim();
    const setting = custom || SETTINGS[Math.floor(Math.random() * SETTINGS.length)];
    onStatus?.(`🖋 Claude is writing the case… (${setting})`);

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await SandboxAPI.claude(GEN_PROMPT(setting, !!custom), { maxTokens: 16000 });
        const caseFile = extractJson(raw);
        caseFile.requestedSetting = custom || null;
        (caseFile.suspects || []).forEach(s => { s.portrait = null; });
        caseFile.evidence = caseFile.evidence || [];
        // Never trust the generator's ordering — shuffle lists so answers don't leak by position.
        caseFile.suspects = shuffle(caseFile.suspects);
        caseFile.weapons = shuffle(caseFile.weapons);
        caseFile.locations = shuffle(caseFile.locations);
        const problems = structuralCheck(caseFile);
        if (problems.length) {
          throw new Error("structural check failed: " + problems.join("; "));
        }
        return caseFile;
      } catch (e) {
        lastError = e;
        if (attempt < 2) {
          onStatus?.(`🖋 First draft flawed (${e.message}) — rewriting…`);
        }
      }
    }
    throw new Error("Case generation failed after 2 attempts. Last error: " + (lastError && lastError.message));
  }

  // ---------- Stage 2: validate + patch ----------
  // Escape regex metacharacters so a `find` string is matched literally.
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Word-boundary-aware replacement of `find` → `replace` inside one string.
  // \b anchors fail for phrases ending/starting in punctuation, so use
  // lookaround on non-word characters instead — works for multi-word phrases.
  function replaceInText(text, find, replace) {
    if (typeof text !== "string" || !find) return text;
    const re = new RegExp(`(?<![\\w])${escapeRegExp(find)}(?![\\w])`, "g");
    return text.replace(re, replace);
  }

  // Apply name/consistency fixes ONLY to narrative text fields — never to
  // id fields, solution.killerId, the weapons[]/locations[] lists, or
  // artStyle (ids and list membership must survive; artStyle/physical feed
  // image generation so they are deliberately left alone).
  function applyFixes(caseFile, fixes) {
    let applied = 0;
    // Longest "find" first so specific phrases are replaced before bare surnames.
    const sorted = [...fixes].filter(f => f.find && f.replace && f.find !== f.replace)
      .sort((a, b) => b.find.length - a.find.length);

    const fixString = (s, f) => {
      const out = replaceInText(s, f.find, f.replace);
      if (out !== s) applied++;
      return out;
    };
    const fixArray = (arr, f) => Array.isArray(arr) ? arr.map(x => fixString(x, f)) : arr;

    for (const f of sorted) {
      caseFile.title = fixString(caseFile.title, f);
      caseFile.setting = fixString(caseFile.setting, f);
      caseFile.openingScene = fixString(caseFile.openingScene, f);
      if (caseFile.victim) caseFile.victim.description = fixString(caseFile.victim.description, f);
      if (caseFile.solution) {
        caseFile.solution.motive = fixString(caseFile.solution.motive, f);
        caseFile.solution.recap = fixString(caseFile.solution.recap, f);
      }
      caseFile.keyClues = fixArray(caseFile.keyClues, f);
      (caseFile.evidence || []).forEach(ev => {
        ev.name = fixString(ev.name, f);
        ev.description = fixString(ev.description, f);
        ev.reveals = fixArray(ev.reveals, f);
      });
      (caseFile.suspects || []).forEach(s => {
        s.personality = fixString(s.personality, f);
        s.alibi = fixString(s.alibi, f);
        s.physical = fixString(s.physical, f);
        s.knows = fixArray(s.knows, f);
        s.secrets = fixArray(s.secrets, f);
      });
    }
    return { caseFile, applied };
  }

  async function validateAndPatch(caseFile, onStatus) {
    // NOTE: this throws on unrepairable cases — the caller (lobby) treats
    // the thrown error as fatal and surfaces its message to the host.
    for (let attempt = 1; attempt <= 3; attempt++) {
      onStatus?.(`🔍 Case audit (pass ${attempt})…`);
      const raw = await SandboxAPI.claude(VALIDATE_PROMPT(caseFile), { maxTokens: 4000 });
      const verdict = extractJson(raw);
      const fixes = verdict.fixes || [];
      if (verdict.solvable && verdict.consistent !== false && fixes.length === 0) {
        return { caseFile, issues: verdict.issues || [] };
      }

      let changed = false;
      if (fixes.length) {
        const res = applyFixes(caseFile, fixes);
        caseFile = res.caseFile;
        changed = res.applied > 0;
        onStatus?.(`✏️ Consistency repairs: ${res.applied}…`);
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
      // Re-check structure after repairs so a fix can never corrupt the case.
      const problems = structuralCheck(caseFile);
      if (problems.length) {
        throw new Error("Case audit repairs broke case structure: " + problems.join("; "));
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
    return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  }

  async function saveCase(caseFile) {
    await SandboxAPI.firebaseApp();
    const db = firebase.firestore();
    // Collision guard: never overwrite an existing case under a reused code.
    let code = null;
    for (let i = 0; i < 5; i++) {
      const candidate = makeCode();
      const snap = await db.collection("cases").doc(candidate).get();
      if (!snap.exists) { code = candidate; break; }
    }
    if (!code) throw new Error("Could not allocate a free case code after 5 tries.");
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

  // Generous allowlist for detective names: letters (any script), numbers,
  // spaces, hyphen, underscore, apostrophe. Rejects /, ., .. etc. so the
  // name is always a safe Firestore document id.
  const DETECTIVE_NAME_RE = /^[\p{L}\p{N} _\-']+$/u;

  async function joinCase(code, detectiveName) {
    const name = (detectiveName || "").trim().slice(0, 24);
    if (!name || !DETECTIVE_NAME_RE.test(name)) {
      throw new Error("Invalid detective name");
    }
    await SandboxAPI.firebaseApp();
    const ref = firebase.firestore().collection("cases").doc(code.toUpperCase().trim())
      .collection("players").doc(name);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ joinedAt: new Date().toISOString(), clues: [], chats: {}, examined: [], accusation: null });
    }
    return ref;
  }

  return { generateCase, validateAndPatch, generatePortraits, saveCase, loadCase, joinCase };
})();
