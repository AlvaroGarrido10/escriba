// TranscripcionesAG — documento offscreen: SOLO graba y llama a Gemini.
// OJO: en un offscreen document NO existe chrome.storage ni chrome.downloads.
// Todo lo que necesite almacenamiento o descargas se pide al service worker
// (background.js) por mensajes.

let mediaRecorder = null, chunks = [], streams = [], audioCtx = null;
let tabTitle = "";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  (async () => {
    try {
      if (msg.cmd === "start") { await start(msg); sendResponse({ ok: true }); }
      else if (msg.cmd === "stop") { stop(); sendResponse({ ok: true }); }
      else if (msg.cmd === "selftest") { sendResponse(await selftest(msg)); }
      else sendResponse({ ok: false, error: "orden desconocida" });
    } catch (e) { sendResponse({ ok: false, error: (e && e.message) || String(e) }); }
  })();
  return true;
});

// --- puentes hacia el service worker (única vía a storage/downloads) ---
const aBg = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
const leerConfig = () => aBg("cfg");
const histCrear = (item) => aBg("histCrear", { item });
const histActualizar = (id, cambios) => aBg("histActualizar", { id, cambios });
const descargar = (url, filename) => aBg("descargar", { url, filename });
const avisar = (ok) => { try { aBg("listo", { ok }); } catch (_) {} };

// --- grabación ---
async function start({ modo, streamId, tabTitle: tt }) {
  tabTitle = tt || "";
  audioCtx = new AudioContext();
  const destino = audioCtx.createMediaStreamDestination();
  streams = [];

  if (modo === "tab_mic" && streamId) {
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    streams.push(tabStream);
    const src = audioCtx.createMediaStreamSource(tabStream);
    src.connect(destino);
    src.connect(audioCtx.destination); // que se siga oyendo la reunión
  }

  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }, video: false,
    });
    streams.push(mic);
    audioCtx.createMediaStreamSource(mic).connect(destino);
  } catch (e) {
    if (modo === "mic") throw new Error("Sin permiso de micrófono: ve a Opciones → Permitir micrófono.");
  }

  chunks = [];
  mediaRecorder = new MediaRecorder(destino.stream, {
    mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 48000,
  });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = procesar;
  mediaRecorder.start(2000);
}

function stop() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
}

async function procesar() {
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (audioCtx) audioCtx.close();
  const blob = new Blob(chunks, { type: "audio/webm" });
  const id = Date.now();
  const meta = fechaBonita(id);

  await histCrear({ id, fecha: meta.legible, titulo: tabTitle || "Reunión", estado: "transcribiendo", transcript: "", analisis: {} });

  if (!blob.size) {
    await histActualizar(id, {
      estado: "error",
      transcript: "ERROR: no se capturó nada de audio.\n\nEn modo «Pestaña + micro», la pestaña debe estar reproduciendo sonido. Para una reunión presencial usa «Solo micro» y autoriza el micrófono en Opciones.",
    });
    avisar(false);
    return;
  }

  try {
    const transcript = await transcribirGemini(blob);
    const md = `# Transcripción de reunión — ${meta.legible}\n\n` +
      (tabTitle ? `**Origen:** ${tabTitle}\n` : "") + `\n---\n\n${transcript}\n`;
    await histActualizar(id, { estado: "ok", transcript: md });
    descargar("data:text/markdown;charset=utf-8," + encodeURIComponent(md), `reuniones/reunion_${meta.fichero}.md`);
    avisar(true);
  } catch (e) {
    const detalle = (e && (e.message || String(e))) || "error desconocido";
    try {
      const url = await blobADataUrl(blob);
      descargar(url, `reuniones/reunion_${meta.fichero}_AUDIO.webm`);
    } catch (_) { /* guardar el audio es best-effort */ }
    await histActualizar(id, {
      estado: "error",
      transcript: "ERROR AL TRANSCRIBIR\n\n" + detalle +
        "\n\nQué hacer:\n· Abre Opciones y comprueba que la clave sale en verde.\n· El audio grabado se ha guardado en Descargas/reuniones (.webm), no se pierde.",
    });
    avisar(false);
  }
}

// --- prueba de 3 s de punta a punta (botón Diagnóstico) ---
async function selftest({ modo, streamId }) {
  const fuentes = [];
  const ctx = new AudioContext();
  const destino = ctx.createMediaStreamDestination();
  const activos = [];
  try {
    if (modo === "tab_mic" && streamId) {
      const t = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false,
      });
      activos.push(t);
      const s = ctx.createMediaStreamSource(t);
      s.connect(destino); s.connect(ctx.destination);
      fuentes.push("pestaña");
    }
    try {
      const m = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activos.push(m);
      ctx.createMediaStreamSource(m).connect(destino);
      fuentes.push("micrófono");
    } catch (e) {
      fuentes.push("micrófono NO (" + ((e && e.name) || "error") + ")");
    }
    if (!activos.length) return { ok: false, error: "No se pudo abrir ninguna fuente de audio." };

    const trozos = [];
    const rec = new MediaRecorder(destino.stream, { mimeType: "audio/webm;codecs=opus" });
    rec.ondataavailable = (e) => { if (e.data.size) trozos.push(e.data); };
    const fin = new Promise((res) => { rec.onstop = res; });
    rec.start();
    await new Promise((r) => setTimeout(r, 3000));
    rec.stop();
    await fin;
    activos.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    ctx.close();

    const blob = new Blob(trozos, { type: "audio/webm" });
    const res = { ok: true, bytes: blob.size, fuentes: fuentes.join(" + ") };
    if (blob.size) {
      try { res.transcripcion = await transcribirGemini(blob); }
      catch (e) { res.errorTranscripcion = (e && e.message) || String(e); }
    }
    return res;
  } catch (e) {
    activos.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    try { ctx.close(); } catch (_) {}
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// --- Gemini ---
async function transcribirGemini(blob) {
  const cfg = await leerConfig();
  const geminiKey = cfg && cfg.geminiKey;
  const geminiModel = (cfg && cfg.geminiModel) || "gemini-flash-lite-latest";
  const glosario = (cfg && cfg.glosario) || "";
  if (!geminiKey) throw new Error("Falta la clave de Gemini: ábrela en Opciones.");

  const base = "https://generativelanguage.googleapis.com";
  const auth = { "x-goog-api-key": geminiKey };
  const prompt = `Transcribe íntegramente este audio de una reunión de trabajo en español.
Reglas:
- Transcripción literal y completa, sin resumir ni omitir nada.
- Si distingues hablantes, etiqueta cada intervención como "Hablante 1:", "Hablante 2:"...
- Marca con [inaudible] lo que no se entienda.
${glosario ? `- Vocabulario del dominio (respeta esta ortografía exacta): ${glosario}.` : ""}
Devuelve SOLO la transcripción.`;

  let parteAudio;
  if (blob.size < 15 * 1048576) {
    parteAudio = { inline_data: { mime_type: "audio/webm", data: (await blobADataUrl(blob)).split(",")[1] } };
  } else {
    const up = await fetch(`${base}/upload/v1beta/files`, {
      method: "POST",
      headers: { ...auth, "X-Goog-Upload-Protocol": "raw", "X-Goog-Upload-Header-Content-Type": "audio/webm", "Content-Type": "audio/webm" },
      body: blob,
    });
    if (!up.ok) throw new Error("Subida del audio a Gemini falló: HTTP " + up.status);
    let file = (await up.json()).file;
    let n = 0;
    while (file.state === "PROCESSING" && n++ < 90) {
      await new Promise((r) => setTimeout(r, 2000));
      file = await (await fetch(`${base}/v1beta/${file.name}`, { headers: auth })).json();
    }
    if (file.state !== "ACTIVE") throw new Error("Gemini no procesó el audio (estado " + file.state + ").");
    parteAudio = { file_data: { mime_type: "audio/webm", file_uri: file.uri } };
  }

  const res = await fetch(`${base}/v1beta/models/${geminiModel}:generateContent`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, parteAudio] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
    }),
  });
  if (!res.ok) throw new Error("Gemini HTTP " + res.status + ": " + (await res.text()).slice(0, 250));
  const data = await res.json();
  const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!out) throw new Error("Gemini devolvió una respuesta vacía (¿audio en silencio?).");
  return out;
}

// --- utilidades ---
function fechaBonita(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return {
    legible: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`,
    fichero: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`,
  };
}
function blobADataUrl(blob) {
  return new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(blob); });
}
