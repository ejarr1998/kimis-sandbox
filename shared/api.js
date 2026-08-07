/**
 * Kimi's Sandbox — shared API helpers
 * Keys are read from localStorage (set via settings.html). Never hardcode keys here.
 * (Firebase config is safe to commit — it's a public identifier, not a secret.)
 *
 * Usage:
 *   const reply = await SandboxAPI.claude("Say hello");
 *   const img   = await SandboxAPI.grokImage("a cat astronaut");
 *   const audio = await SandboxAPI.elevenTTS("Hello world", voiceId);
 *   const sfx   = await SandboxAPI.elevenSFX("rain on a tin roof");
 *   const app   = await SandboxAPI.firebaseApp();
 */

const SandboxAPI = (() => {

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCi5NLrrw11qfwknM6gF22kYnJT2m7ZZ_w",
    authDomain: "kimi-sandbox-a7043.firebaseapp.com",
    projectId: "kimi-sandbox-a7043",
    storageBucket: "kimi-sandbox-a7043.firebasestorage.app",
    messagingSenderId: "137052341093",
    appId: "1:137052341093:web:c897d57ff8a3df6eb6d78c"
  };

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

  // ---------- Grok image (xAI Imagine API) ----------
  // grok-2-image was deprecated Feb 2026; grok-imagine-image is the current model.
  // Returns an object: { url, revised_prompt }
  async function grokImage(prompt, { model = "grok-imagine-image", n = 1 } = {}) {
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

  // ---------- ElevenLabs sound effects ----------
  // Returns an object URL for the generated audio.
  // Endpoint is /v1/sound-generation (/v1/sound-effects does not exist — 404s).
  async function elevenSFX(description, { durationSeconds = 3 } = {}) {
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
      method: "POST",
      headers: {
        "xi-api-key": key("elevenlabs"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: description, duration_seconds: durationSeconds })
    });
    if (!res.ok) throw new Error("ElevenLabs SFX " + res.status + ": " + (await res.text()).slice(0, 120));
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  // ---------- Firebase loader ----------
  // Loads Firebase (compat CDN) on demand and initializes it with the baked-in
  // config (a localStorage override from settings.html takes priority if present).
  async function firebaseApp() {
    const override = localStorage.getItem("sandbox_firebase_config");
    const cfg = override ? JSON.parse(override) : FIREBASE_CONFIG;
    if (!window.firebase) {
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js");
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js");
    }
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    return firebase.apps[0];
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  return { claude, grokText, grokImage, elevenTTS, elevenSFX, firebaseApp };
})();
