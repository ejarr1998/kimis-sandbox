/**
 * Kimi's Sandbox — shared API helpers
 * Keys are read from localStorage (set via settings.html). Never hardcode keys here.
 *
 * Usage:
 *   const reply = await SandboxAPI.claude("Say hello");
 *   const img   = await SandboxAPI.grokImage("a cat astronaut");
 *   const audio = await SandboxAPI.elevenTTS("Hello world", voiceId);
 */

const SandboxAPI = (() => {

  function key(name) {
    const v = localStorage.getItem("sandbox_key_" + name);
    if (!v) throw new Error(`Missing API key "${name}". Set it on the Settings page (settings.html).`);
    return v;
  }

  // ---------- Claude (Anthropic) ----------
  // NOTE: Anthropic blocks direct browser calls by default (CORS).
  // We pass the 'anthropic-dangerous-direct-browser-access' header which
  // Anthropic supports for exactly this kind of client-side playground use.
  async function claude(prompt, { model = "claude-sonnet-4-5", system = "", maxTokens = 1024 } = {}) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key("claude"),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!res.ok) throw new Error("Claude error " + res.status + ": " + await res.text());
    const data = await res.json();
    return data.content.map(b => b.text || "").join("");
  }

  // ---------- Grok text (xAI) ----------
  async function grokText(prompt, { model = "grok-3-mini", system = "" } = {}) {
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt }
    ];
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + key("grok")
      },
      body: JSON.stringify({ model, messages })
    });
    if (!res.ok) throw new Error("Grok error " + res.status + ": " + await res.text());
    const data = await res.json();
    return data.choices[0].message.content;
  }

  // ---------- Grok image (xAI) ----------
  // Returns an object: { url, revised_prompt }
  async function grokImage(prompt, { model = "grok-2-image", n = 1 } = {}) {
    const res = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + key("grok")
      },
      body: JSON.stringify({ model, prompt, n, response_format: "url" })
    });
    if (!res.ok) throw new Error("Grok image error " + res.status + ": " + await res.text());
    const data = await res.json();
    return data.data[0];
  }

  // ---------- ElevenLabs TTS ----------
  // Returns an object URL you can assign to an <audio> element's src.
  // NOTE: ElevenLabs allows browser calls only if you enable it for the key,
  // otherwise this will hit a CORS error (that's when we'd add a proxy).
  async function elevenTTS(text, voiceId = "21m00Tcm4TlvDq8ikWAM", { model = "eleven_multilingual_v2" } = {}) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": key("elevenlabs")
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!res.ok) throw new Error("ElevenLabs error " + res.status + ": " + await res.text());
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  // ---------- Firebase loader ----------
  // Loads Firebase (compat CDN) on demand and initializes it with the config
  // saved in localStorage by settings.html. Returns the initialized app.
  async function firebaseApp() {
    const cfg = localStorage.getItem("sandbox_firebase_config");
    if (!cfg) throw new Error("No Firebase config saved. Set it on the Settings page.");
    if (!window.firebase) {
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js");
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js");
    }
    if (!firebase.apps.length) firebase.initializeApp(JSON.parse(cfg));
    return firebase.apps[0];
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  return { claude, grokText, grokImage, elevenTTS, firebaseApp };
})();
