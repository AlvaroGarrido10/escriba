// TranscriptorGod — documento offscreen: SOLO graba y llama a Gemini.
// OJO: en un offscreen document NO existe chrome.storage ni chrome.downloads.
// Todo lo que necesite almacenamiento o descargas se pide al service worker
// (background.js) por mensajes.
//
// La grabación NO se manda a Gemini de una pieza: se corta en tramos de pocos
// minutos y cada tramo se transcribe por separado. Con la reunión entera en una
// sola llamada el modelo se rendía a los pocos minutos (y el fallo de una
// llamada se llevaba por delante la reunión completa).

const MS_TRAMO = 5 * 60 * 1000;       // duración de cada tramo de grabación
const CONCURRENCIA = 2;               // tramos transcribiéndose a la vez
const ESPERAS = [3000, 8000, 20000];  // backoff entre reintentos de un tramo
const LIMITE_INLINE = 6 * 1048576;    // por encima, subida por Files API
const BASE = "https://generativelanguage.googleapis.com";
// Si el modelo elegido falla, se prueban estos por orden antes de rendirse.
const MODELOS_RESERVA = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];

let mediaRecorder = null, streams = [], audioCtx = null, rotaTimer = null;
let tramos = [], trozosTramo = [], tabTitle = "", medidores = [], errorMic = "";
// Por debajo de este pico un tramo es silencio digital. NO se manda al modelo:
// Gemini, ante silencio, se inventa una reunion entera de cero.
const PICO_SILENCIO = 0.005;
let finalizando = false, yaProcesado = true, tInicio = 0;
// true entre que se pide parar un tramo y llega su onstop: en esa ventana el
// recorder ya no está "recording" pero su audio todavía no está en `tramos`.
let cierreEnCurso = false;

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
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// --- grabación ---
async function start({ modo, streamId, tabTitle: tt }) {
  tabTitle = tt || "";
  audioCtx = new AudioContext({ sampleRate: 48000 });
  streams = [];
  medidores.forEach((m) => clearInterval(m.timer));
  medidores = [];
  errorMic = "";

  // Se graba en MONO: transcribir no gana nada con estéreo, y así una fuente
  // floja no se queda enterrada en un canal.
  const destino = audioCtx.createMediaStreamDestination();
  destino.channelCount = 1;
  destino.channelCountMode = "explicit";

  // Compresor antes de grabar: iguala al que grita con el que habla lejos del
  // micro. De ahí salía buena parte de los [inaudible].
  const mezcla = audioCtx.createDynamicsCompressor();
  mezcla.threshold.value = -35;
  mezcla.knee.value = 30;
  mezcla.ratio.value = 6;
  mezcla.attack.value = 0.003;
  mezcla.release.value = 0.25;
  const salida = audioCtx.createGain();
  salida.gain.value = 1.6; // recupera el volumen que se come el compresor
  mezcla.connect(salida);
  salida.connect(destino);

  if (modo === "tab_mic" && streamId) {
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    streams.push(tabStream);
    const src = audioCtx.createMediaStreamSource(tabStream);
    const g = audioCtx.createGain();
    src.connect(g);
    g.connect(mezcla);
    // Capturar una pestaña la silencia: hay que devolver el sonido a los altavoces.
    src.connect(audioCtx.destination);
    medidores.push(vigila("pestaña", g));
  }

  if (modo === "pc_mic" && streamId) {
    // Chrome no entrega audio de escritorio sin pedir también vídeo. Se pide al
    // mínimo y no se usa: si se corta la pista de vídeo, se acaba la captura.
    const pcStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } },
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId, maxWidth: 160, maxHeight: 120, maxFrameRate: 1 } },
    });
    streams.push(pcStream);
    if (!pcStream.getAudioTracks().length) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      throw new Error("La pantalla se compartió sin audio. Repite y marca «Compartir también el audio del sistema».");
    }
    const g = audioCtx.createGain();
    audioCtx.createMediaStreamSource(pcStream).connect(g);
    g.connect(mezcla);
    // OJO: aquí NO se reenvía a los altavoces. El audio del sistema ya está
    // sonando; devolverlo crearía un bucle de realimentación.
    medidores.push(vigila("PC", g));
  }

  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    streams.push(mic);
    const g = audioCtx.createGain();
    audioCtx.createMediaStreamSource(mic).connect(g);
    g.connect(mezcla);
    medidores.push(vigila("micrófono", g));
  } catch (e) {
    // En modo «pestaña + micro» esto se tragaba en silencio: si ademas la
    // pestaña no sonaba, la grabacion salia muda sin que nadie lo dijera.
    errorMic = (e && (e.name ? `${e.name}: ${e.message}` : e.message)) || String(e);
    if (modo === "mic") throw new Error("Sin permiso de micrófono: ve a Opciones → Permitir micrófono.");
  }

  tramos = [];
  trozosTramo = [];
  finalizando = false;
  yaProcesado = false;
  tInicio = Date.now();
  arrancaTramo(destino.stream);
  rotaTimer = setInterval(cortaTramo, MS_TRAMO);
}

// Cada tramo es un MediaRecorder propio, así que sale un .webm completo y
// autónomo (con cabeceras) que Gemini puede leer por su cuenta.
function arrancaTramo(stream) {
  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000,
  });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) trozosTramo.push(e.data); };
  mediaRecorder.onstop = () => {
    cierreEnCurso = false;
    const blob = new Blob(trozosTramo, { type: "audio/webm" });
    trozosTramo = [];
    const nivel = cierraMedidaTramo(); // siempre, aunque el blob venga vacío
    if (blob.size) tramos.push({ blob, pico: nivel.pico, voz: nivel.voz });
    if (finalizando) procesar();
    else arrancaTramo(stream); // siguiente tramo, la grabación no se interrumpe
  };
  mediaRecorder.start(2000);
}

function cortaTramo() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    cierreEnCurso = true;
    mediaRecorder.stop();
  }
}

function stop() {
  if (finalizando) return;
  finalizando = true;
  clearInterval(rotaTimer);
  rotaTimer = null;
  if (mediaRecorder && mediaRecorder.state === "recording") {
    cierreEnCurso = true;
    mediaRecorder.stop();
  } else if (!cierreEnCurso) {
    procesar(); // no hay ningún tramo cerrándose: nadie más va a llamar
  }
  // Si cierreEnCurso, el onstop pendiente ya verá `finalizando` y procesará.
  // Procesar aquí perdería ese último tramo, que aún no está en `tramos`.
}

// Mide cuánta voz entra por cada fuente. Si luego la transcripción sale llena
// de [inaudible], el informe dice cuál de las dos venía muda o baja.
function vigila(nombre, nodo) {
  const an = audioCtx.createAnalyser();
  an.fftSize = 2048;
  nodo.connect(an);
  const buf = new Float32Array(an.fftSize);
  const m = { nombre, pico: 0, muestras: 0, conVoz: 0, timer: null, picoTramo: 0, muestrasTramo: 0, vozTramo: 0 };
  m.timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const rms = Math.sqrt(s / buf.length);
    m.muestras++; m.muestrasTramo++;
    if (rms > m.pico) m.pico = rms;
    if (rms > m.picoTramo) m.picoTramo = rms;
    if (rms > 0.008) { m.conVoz++; m.vozTramo++; }
  }, 1000);
  return m;
}

// Cierra la medida del tramo que acaba y arranca la del siguiente. Devuelve el
// pico y la fraccion con voz de la fuente que mejor sono durante ese tramo.
function cierraMedidaTramo() {
  let pico = 0, voz = 0;
  for (const m of medidores) {
    if (m.picoTramo > pico) pico = m.picoTramo;
    if (m.muestrasTramo) voz = Math.max(voz, m.vozTramo / m.muestrasTramo);
    m.picoTramo = 0; m.muestrasTramo = 0; m.vozTramo = 0;
  }
  return { pico, voz };
}

// Resumen de niveles + aviso si una fuente no ha sonado en toda la reunión.
function informeAudio() {
  const partes = [], mudas = [];
  for (const m of medidores) {
    const pct = m.muestras ? Math.round((100 * m.conVoz) / m.muestras) : 0;
    partes.push(`${m.nombre} ${pct}% con voz (pico ${m.pico.toFixed(2)})`);
    if (pct < 2) mudas.push(m.nombre);
  }
  if (errorMic) partes.push("micrófono NO disponible");
  let alerta = "";
  if (errorMic) {
    alerta += `\n> ⚠️ **No se pudo abrir el micrófono:** ${errorMic}\n` +
      "> Solo se ha grabado el audio de la pestaña. Abre Opciones → Permitir micrófono.\n";
  }
  if (mudas.length) {
    alerta += `\n> ⚠️ **Sin señal en: ${mudas.join(" y ")}.** Revisa que se capturó la pestaña correcta ` +
      "(tiene que estar sonando) y que el micro no está silenciado.\n";
  }
  return { linea: partes.join(" · "), alerta };
}

async function procesar() {
  if (yaProcesado) return; // stop() y onstop pueden llegar los dos; solo uno pasa
  yaProcesado = true;
  clearInterval(rotaTimer);
  rotaTimer = null;
  medidores.forEach((m) => clearInterval(m.timer));
  const audio = informeAudio();
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }

  const partes = tramos.slice();
  tramos = [];
  const id = Date.now();
  const meta = fechaBonita(id);
  const minutos = Math.max(1, Math.round((id - tInicio) / 60000));
  const bytes = partes.reduce((a, p) => a + p.blob.size, 0);
  const conSonido = partes.filter((p) => p.pico >= PICO_SILENCIO);

  await histCrear({
    id, fecha: meta.legible, titulo: tabTitle || "Reunión", estado: "transcribiendo",
    progreso: `0/${conSonido.length} tramos`, transcript: "", analisis: {},
  });

  // Silencio: NO se manda a Gemini. Ante un audio mudo el modelo no dice "no oigo
  // nada", se inventa una reunión entera con hablantes y acuerdos que no existen.
  if (!bytes || !conSonido.length) {
    await histActualizar(id, {
      estado: "error", progreso: "",
      transcript: "# No se grabó audio\n\n" +
        "**No se ha transcrito nada a propósito:** la grabación está muda y, si se le manda silencio, " +
        "el modelo se inventa una reunión que nunca ocurrió.\n\n" +
        (audio.linea ? `**Niveles medidos:** ${audio.linea}\n` : "") + audio.alerta +
        "\nQué revisar:\n" +
        "· En «Pestaña + micro» la pestaña tiene que estar SONANDO (una página abierta sin audio no vale).\n" +
        "· Para una reunión presencial usa «Solo micro».\n" +
        "· Comprueba el permiso de micrófono en Opciones y que no esté silenciado en Windows.\n",
    });
    avisar(false);
    return;
  }

  const textos = new Array(partes.length).fill(null);
  const mudos = new Set();
  const fallos = [];
  let hechas = 0, siguiente = 0;

  const trabajador = async () => {
    for (let i = siguiente++; i < partes.length; i = siguiente++) {
      if (partes[i].pico < PICO_SILENCIO) { mudos.add(i); continue; } // ni se pregunta
      try {
        const r = await transcribirGemini(partes[i].blob, i + 1, partes.length);
        if (r.sinVoz) mudos.add(i);
        else textos[i] = r.texto + (r.truncado ? "\n\n> ⚠️ Este tramo se cortó por límite de longitud del modelo." : "");
      } catch (e) {
        fallos.push({ i, error: (e && e.message) || String(e) });
      }
      hechas++;
      await histActualizar(id, { progreso: `${hechas}/${conSonido.length} tramos` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, conSonido.length) }, trabajador));

  // El audio de los tramos fallidos se guarda: es lo único irrecuperable.
  const filesAudio = [];
  for (const f of fallos) {
    try {
      const r = await descargar(await blobADataUrl(partes[f.i].blob),
        `reuniones/audio_${meta.fichero}/tramo${String(f.i + 1).padStart(2, "0")}.webm`);
      if (r && typeof r.id === "number") filesAudio.push(r.id);
    } catch (_) { /* best-effort */ }
  }

  const minTramo = Math.round(MS_TRAMO / 60000);
  const cuerpo = textos.map((t, i) => {
    if (t !== null) return t;
    if (mudos.has(i)) return `> _(Tramo ${i + 1}: sin voz — no se transcribe para no inventar texto.)_`;
    const fallo = fallos.find((f) => f.i === i) || {};
    return `> ⚠️ **Tramo ${i + 1} de ${partes.length} (≈ minuto ${i * minTramo} al ${(i + 1) * minTramo}) no se pudo transcribir.**\n` +
      `> ${fallo.error || "error desconocido"}\n` +
      `> Su audio está en Descargas/reuniones/audio_${meta.fichero}/.`;
  }).join("\n\n");

  let aviso = fallos.length
    ? `\n> ⚠️ **${fallos.length} de ${partes.length} tramos fallaron.** Su audio se ha guardado en Descargas/reuniones/audio_${meta.fichero}/.\n`
    : "";
  if (mudos.size) {
    aviso += `\n> ℹ️ **${mudos.size} de ${partes.length} tramos venían sin voz** y se han dejado en blanco a propósito.\n`;
  }
  const md = `# Transcripción de reunión — ${meta.legible}\n\n` +
    (tabTitle ? `**Origen:** ${tabTitle}\n` : "") +
    `**Duración:** ${minutos} min · ${partes.length} tramo${partes.length === 1 ? "" : "s"}\n` +
    (audio.linea ? `**Audio:** ${audio.linea}\n` : "") +
    audio.alerta + aviso + `\n---\n\n${cuerpo}\n`;

  const salvado = textos.some((t) => t !== null);
  // Se descarga primero para poder guardar el id: sin id, luego no hay forma de
  // borrar ese fichero concreto.
  let fileMd = null;
  try {
    const r = await descargar("data:text/markdown;charset=utf-8," + encodeURIComponent(md),
      `reuniones/reunion_${meta.fichero}.md`);
    if (r && typeof r.id === "number") fileMd = r.id;
  } catch (_) {}
  await histActualizar(id, {
    estado: salvado ? "ok" : "error", progreso: "", transcript: md, fileMd, filesAudio,
  });
  await aBg("podar"); // aplica el límite configurado en Opciones
  avisar(salvado && !fallos.length);
}

// --- prueba de 3 s de punta a punta (botón Diagnóstico) ---
async function selftest({ modo, streamId }) {
  const fuentes = [];
  const ctx = new AudioContext();
  const destino = ctx.createMediaStreamDestination();
  const activos = [];
  try {
    // Mide cada fuente por separado: saber CUAL no suena es medio diagnostico.
    const sondas = [];
    const sonda = (nombre, nodo) => {
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      nodo.connect(an);
      const buf = new Float32Array(an.fftSize);
      const s = { nombre, pico: 0 };
      s.timer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let a = 0;
        for (let i = 0; i < buf.length; i++) a += buf[i] * buf[i];
        s.pico = Math.max(s.pico, Math.sqrt(a / buf.length));
      }, 100);
      sondas.push(s);
    };

    if (modo === "tab_mic" && streamId) {
      const t = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false,
      });
      activos.push(t);
      const s = ctx.createMediaStreamSource(t);
      s.connect(destino); s.connect(ctx.destination);
      sonda("pestaña", s);
      fuentes.push("pestaña");
    }
    if (modo === "pc_mic" && streamId) {
      const t = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId, maxWidth: 160, maxHeight: 120, maxFrameRate: 1 } },
      });
      activos.push(t);
      if (t.getAudioTracks().length) {
        const s = ctx.createMediaStreamSource(t);
        s.connect(destino); // sin reenviar a los altavoces: haría bucle
        sonda("PC", s);
        fuentes.push("audio del PC");
      } else {
        fuentes.push("audio del PC NO (no marcaste «compartir audio del sistema»)");
      }
    }
    try {
      const m = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activos.push(m);
      const s = ctx.createMediaStreamSource(m);
      s.connect(destino);
      sonda("micrófono", s);
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
    await espera(3000);
    rec.stop();
    await fin;
    sondas.forEach((s) => clearInterval(s.timer));
    activos.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    ctx.close();

    const blob = new Blob(trozos, { type: "audio/webm" });
    const picoMax = sondas.reduce((a, s) => Math.max(a, s.pico), 0);
    const res = {
      ok: true, bytes: blob.size, fuentes: fuentes.join(" + "),
      niveles: sondas.map((s) => `${s.nombre} pico ${s.pico.toFixed(3)}`).join(" · "),
      silencio: picoMax < PICO_SILENCIO,
    };
    if (blob.size && !res.silencio) {
      try {
        const r = await transcribirGemini(blob);
        res.transcripcion = r.sinVoz ? "(el modelo no oyó voz)" : r.texto;
      } catch (e) { res.errorTranscripcion = (e && e.message) || String(e); }
    }
    return res;
  } catch (e) {
    activos.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    try { ctx.close(); } catch (_) {}
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// --- Gemini ---
function marcar(err, props) { return Object.assign(err, props); }

function construirPrompt(glosario, idx, total) {
  const contexto = total > 1
    ? `Este audio es el TRAMO ${idx} de ${total} de una misma reunión ya cortada en trozos: empieza y acaba a mitad de conversación. Transcribe solo lo que suene, sin introducción ni despedida propias.\n`
    : "";
  return `Transcribe íntegramente este audio de una reunión de trabajo en español.
${contexto}Reglas:
- Si el audio está en silencio, solo tiene ruido de fondo o no contiene ninguna voz inteligible, responde EXACTAMENTE la palabra SIN_VOZ y nada más. No inventes una reunión bajo ningún concepto.
- Transcripción literal y COMPLETA, desde el primer segundo hasta el último. No resumas, no omitas y no te detengas antes de que termine el audio.
- Si distingues hablantes, etiqueta cada intervención como "Hablante 1:", "Hablante 2:"...
- Marca con [inaudible] únicamente lo que de verdad no se entienda.
${glosario ? `- Vocabulario del dominio (respeta esta ortografía exacta): ${glosario}.` : ""}
Devuelve SOLO la transcripción.`;
}

async function transcribirGemini(blob, idx = 1, total = 1) {
  const cfg = await leerConfig();
  const key = cfg && cfg.geminiKey;
  if (!key) throw new Error("Falta la clave de Gemini: ábrela en Opciones.");
  const preferido = (cfg && cfg.geminiModel) || MODELOS_RESERVA[0];
  const modelos = [preferido, ...MODELOS_RESERVA.filter((m) => m !== preferido)];

  const parteAudio = await prepararAudio(blob, key);
  const prompt = construirPrompt((cfg && cfg.glosario) || "", idx, total);

  let ultimo = null;
  for (const modelo of modelos) {
    for (let intento = 0; ; intento++) {
      try {
        return await generar(key, modelo, prompt, parteAudio);
      } catch (e) {
        ultimo = e;
        if (e.fatal) throw e;
        if (e.reintentable && intento < ESPERAS.length) {
          await espera(e.esperaMs || ESPERAS[intento]);
          continue;
        }
        break; // agotado con este modelo → probar el siguiente de reserva
      }
    }
  }
  throw ultimo || new Error("No se pudo transcribir el tramo.");
}

async function generar(key, modelo, prompt, parteAudio) {
  // Nada de thinkingConfig: gemini-flash-latest lo rechaza con un 400 genérico
  // ("Request contains an invalid argument"), sin decir cuál es el argumento.
  // El presupuesto va holgado para que el razonamiento no se coma la salida:
  // un tramo de 5 min son ~1.000 tokens de transcripción.
  const generationConfig = { temperature: 0, maxOutputTokens: 32768 };

  let res;
  try {
    res = await fetch(`${BASE}/v1beta/models/${modelo}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, parteAudio] }], generationConfig }),
    });
  } catch (e) {
    throw marcar(new Error("Sin conexión con Gemini: " + ((e && e.message) || e)), { reintentable: true });
  }

  if (!res.ok) {
    const txt = (await res.text()).slice(0, 400);
    const e = new Error(`Gemini HTTP ${res.status} (${modelo}): ${txt}`);
    if ([408, 429, 500, 502, 503, 504].includes(res.status)) {
      const d = /"retryDelay"\s*:\s*"(\d+)s"/.exec(txt);
      throw marcar(e, { reintentable: true, esperaMs: d ? Number(d[1]) * 1000 : 0 });
    }
    // Clave mala o sin permisos: cambiar de modelo no arregla nada.
    if (res.status === 401 || res.status === 403 || /API key/i.test(txt)) throw marcar(e, { fatal: true });
    throw e; // el resto (404…) deja probar el siguiente modelo
  }

  const data = await res.json();
  const cand = (data.candidates || [])[0];
  const razon = cand && cand.finishReason;
  const texto = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").trim();
  if (!texto) {
    throw marcar(new Error("Gemini devolvió texto vacío" + (razon ? ` (finishReason: ${razon})` : "") + " — ¿tramo en silencio?"),
      { reintentable: true });
  }
  // El modelo confirma que no hay voz: se respeta, no se reintenta.
  if (/^\s*SIN_VOZ[\s.]*$/i.test(texto)) return { texto: "", sinVoz: true };
  return { texto, truncado: razon === "MAX_TOKENS" };
}

// Audio pequeño va en el propio cuerpo; grande, por la Files API.
async function prepararAudio(blob, key) {
  if (blob.size < LIMITE_INLINE) {
    return { inline_data: { mime_type: "audio/webm", data: (await blobADataUrl(blob)).split(",")[1] } };
  }
  const auth = { "x-goog-api-key": key };
  const up = await fetch(`${BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: { ...auth, "X-Goog-Upload-Protocol": "raw", "X-Goog-Upload-Header-Content-Type": "audio/webm", "Content-Type": "audio/webm" },
    body: blob,
  });
  if (!up.ok) {
    const e = new Error("Subida del audio a Gemini falló: HTTP " + up.status);
    throw marcar(e, { reintentable: up.status >= 500 || up.status === 429 });
  }
  let file = (await up.json()).file;
  let n = 0;
  while (file.state === "PROCESSING" && n++ < 90) {
    await espera(2000);
    file = await (await fetch(`${BASE}/v1beta/${file.name}`, { headers: auth })).json();
  }
  if (file.state !== "ACTIVE") throw new Error("Gemini no procesó el audio (estado " + file.state + ").");
  return { file_data: { mime_type: "audio/webm", file_uri: file.uri } };
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
