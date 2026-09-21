// Escriba — documento offscreen: SOLO graba y llama a Gemini.
// OJO: en un offscreen document NO existe chrome.storage ni chrome.downloads.
// Todo lo que necesite almacenamiento o descargas se pide al service worker
// (background.js) por mensajes.
//
// La grabación NO se manda a Gemini de una pieza: se corta en tramos de pocos
// minutos y cada tramo se transcribe por separado. Con la reunión entera en una
// sola llamada el modelo se rendía a los pocos minutos (y el fallo de una
// llamada se llevaba por delante la reunión completa).
//
// Cada tramo se guarda en IndexedDB (comun.js) en cuanto se cierra, y solo se
// borra cuando su texto ya está en el historial. Así un fallo de transcripción,
// o un cierre de Chrome a mitad de reunión, no se lleva el audio por delante: el
// mismo motor (transcribirReunion) sirve para la primera pasada, para los
// reintentos y para los archivos importados.

const MS_TRAMO = DURACION_TRAMO_S * 1000; // duración de cada tramo de grabación
const CONCURRENCIA = 2;               // tramos transcribiéndose a la vez
const ESPERAS = [3000, 8000, 20000];  // backoff entre reintentos de un tramo
const LIMITE_INLINE = 6 * 1048576;    // por encima, subida por Files API
const BASE = "https://generativelanguage.googleapis.com";
// Si el modelo elegido falla, se prueban estos por orden antes de rendirse.
const MODELOS_RESERVA = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];

let mediaRecorder = null, streams = [], audioCtx = null, rotaTimer = null, parcialTimer = null;
const MS_PARCIAL = 30 * 1000;         // cada cuánto se guarda el tramo que se está grabando
let tramos = [], trozosTramo = [], tabTitle = "", medidores = [], errorMic = "";
let medidas = [];          // medidas exactas de tramo aún en vuelo
let ctxDecode = null;      // contexto dedicado a decodificar, aparte del de grabación
// PICO_SILENCIO y UMBRAL_VOZ viven en comun.js: la página de importar los usa igual.
let finalizando = false, yaProcesado = true, tInicio = 0;
// true entre que se pide parar un tramo y llega su onstop: en esa ventana el
// recorder ya no está "recording" pero su audio todavía no está en `tramos`.
let cierreEnCurso = false;
let reunionActual = null;  // id en el historial de la grabación en marcha
let cerrando = false;      // procesar() en marcha, antes de que empiece la ronda
// Copia en memoria de los tramos de ESTA sesión, por si IndexedDB falla (cuota,
// disco lleno): la primera pasada puede seguir aunque no se haya podido guardar.
const memoria = new Map();
const enCurso = new Set(); // reuniones con una ronda de transcripción en marcha

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  (async () => {
    try {
      if (msg.cmd === "start") { await start(msg); sendResponse({ ok: true, id: reunionActual }); }
      else if (msg.cmd === "stop") { stop(); sendResponse({ ok: true }); }
      else if (msg.cmd === "selftest") { sendResponse(await selftest(msg)); }
      else if (msg.cmd === "transcribir") {
        // Se responde YA: una ronda puede durar minutos y quien la pide (una
        // alarma, el popup) no tiene por qué esperar.
        const yaEnCurso = enCurso.has(msg.id);
        if (!yaEnCurso) transcribirReunion(msg.id).catch((e) => console.error("Escriba: ronda fallida", e));
        sendResponse({ ok: true, yaEnCurso });
      }
      else if (msg.cmd === "estado") {
        // Mientras se cierra una grabación (medir tramos, pasar la entrada a
        // «transcribiendo») sigue contando como viva: si no, el service worker
        // la tomaría por una grabación interrumpida.
        sendResponse({ ok: true, grabandoId: yaProcesado && !cerrando ? null : reunionActual, enCurso: [...enCurso] });
      }
      else sendResponse({ ok: false, error: "orden desconocida" });
    } catch (e) { sendResponse({ ok: false, error: (e && e.message) || String(e) }); }
  })();
  return true;
});

// --- puentes hacia el service worker (única vía a storage/downloads) ---
const aBg = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
const histCrear = (item) => aBg("histCrear", { item });
const histActualizar = (id, cambios) => aBg("histActualizar", { id, cambios });
const histTramo = (id, i, datos) => aBg("histTramo", { id, i, datos });
const descargar = (url, filename) => aBg("descargar", { url, filename });
const avisar = (ok) => { try { aBg("listo", { ok }); } catch (_) {} };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// La configuración llega por mensaje desde el service worker. Si ese mensaje
// falla o vuelve vacío (el service worker se estaba reiniciando, por ejemplo),
// la 3.0 lo tomaba por «no hay clave» y daba por perdidos todos los tramos. Aquí
// se reintenta, y si aun así no llega, se dice que es un fallo interno.
async function leerConfig() {
  let ultimo = null;
  for (const ms of [0, 500, 2000, 5000]) {
    if (ms) await espera(ms);
    try {
      const c = await aBg("cfg");
      if (c && typeof c === "object" && "geminiKey" in c) return c;
      ultimo = new Error("respuesta sin configuración: " + String(JSON.stringify(c)).slice(0, 120));
    } catch (e) { ultimo = e; }
  }
  throw marcar(new Error("No se pudo leer la configuración de Escriba (" + ((ultimo && ultimo.message) || ultimo) + ")"),
    { codigo: "interno" });
}

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
  medidas = [];
  finalizando = false;
  tInicio = Date.now();
  // La entrada del historial nace YA, no al terminar: si Chrome se cierra a
  // mitad de reunión, el service worker la encuentra en «grabando» al volver y
  // transcribe lo que haya quedado guardado.
  reunionActual = tInicio;
  try {
    await histCrear(entradaNueva());
  } catch (e) {
    // Sin entrada se graba igual: procesar() la crea al terminar si no existe.
    console.warn("Escriba: no se pudo crear la entrada al empezar:", e);
  }
  yaProcesado = false;
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
  // Lo que va del tramo en curso se guarda cada 30 s. Si Chrome se cierra a
  // mitad, se recupera todo menos el último medio minuto (sin esto se perdía el
  // tramo entero: hasta 5 minutos, o la reunión completa si era corta). El
  // índice es el que tendrá el tramo al cerrarse; el guardado final lo pisa.
  clearInterval(parcialTimer);
  parcialTimer = setInterval(() => {
    if (trozosTramo.length) guardaAudio(reunionActual, tramos.length, new Blob(trozosTramo, { type: "audio/webm" }));
  }, MS_PARCIAL);
  mediaRecorder.onstop = () => {
    clearInterval(parcialTimer);
    cierreEnCurso = false;
    const blob = new Blob(trozosTramo, { type: "audio/webm" });
    trozosTramo = [];
    const nivel = cierraMedidaTramo(); // siempre, aunque el blob venga vacío
    if (blob.size) {
      // El nivel del analizador vale para el informe por fuente, pero NO para
      // decidir si un tramo es silencio: solo mira 42 ms de cada segundo, así
      // que una intervención corta se le escapa entera. Sobre ese dato se
      // descartaban tramos con voz sin llegar a preguntar al modelo.
      const entrada = { blob, pico: nivel.pico, voz: nivel.voz };
      tramos.push(entrada); // se encola YA: así el orden de los tramos es el real
      guardaAudio(reunionActual, tramos.length - 1, blob);
      // La medida exacta va en paralelo. Retrasar aquí el arranque del tramo
      // siguiente dejaría un hueco sin grabar en la reunión.
      medidas.push(medirExacto(blob).then((m) => {
        if (m) { entrada.pico = m.pico; entrada.voz = m.voz; }
        // Si no se pudo decodificar, se manda igual: mejor gastar 3 céntimos
        // que tirar un tramo que quizá tenía voz.
        else entrada.pico = Math.max(entrada.pico, PICO_SILENCIO);
      }, () => { entrada.pico = Math.max(entrada.pico, PICO_SILENCIO); }));
    }
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

// Medida EXACTA del tramo ya grabado: decodifica el .webm y recorre todas las
// muestras en ventanas de 20 ms. Es la única cifra sobre la que se decide
// descartar un tramo, porque es la única que ve el audio entero. Se usa un
// AudioContext propio, a 16 kHz: decodificar no necesita más y así no depende
// del contexto de grabación, que se cierra al terminar.
async function medirExacto(blob) {
  if (!ctxDecode) ctxDecode = new AudioContext({ sampleRate: 16000 });
  const audio = await ctxDecode.decodeAudioData(await blob.arrayBuffer());
  return medirMuestras(audio.getChannelData(0), audio.sampleRate, UMBRAL_VOZ);
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

function entradaNueva() {
  const f = fechaBonita(reunionActual);
  return {
    id: reunionActual, fecha: f.legible, titulo: tabTitle || "Reunión", origen: "grabacion",
    estado: "grabando", progreso: "", transcript: "", analisis: {}, tramos: [], meta: { fichero: f.fichero },
  };
}

// Guarda un tramo recién grabado. Si IndexedDB falla, queda al menos en memoria
// para la primera pasada; lo que no se puede es parar la grabación por esto.
function guardaAudio(id, idx, blob) {
  const clave = id + ":" + idx;
  memoria.set(clave, blob);
  if (!audios) return;
  audios.guardar(id, idx, blob).then(
    // Ya está en disco: no hace falta retenerlo en memoria (una reunión de dos
    // horas son decenas de MB).
    () => { if (memoria.get(clave) === blob) memoria.delete(clave); },
    (e) => console.warn("Escriba: no se pudo guardar el tramo", idx, e));
}

async function olvidaAudio(id, idx) {
  memoria.delete(id + ":" + idx);
  if (audios) { try { await audios.borrar(id, idx); } catch (_) { /* se limpia al arrancar */ } }
}

async function leeAudio(id, idx) {
  const enMemoria = memoria.get(id + ":" + idx);
  if (enMemoria) return enMemoria;
  return audios ? audios.leer(id, idx) : null;
}

async function procesar() {
  if (yaProcesado) return; // stop() y onstop pueden llegar los dos; solo uno pasa
  yaProcesado = true;
  cerrando = true;
  try {
    const id = await cierraGrabacion();
    // Sin await entre medias: transcribirReunion marca la reunión como «en
    // curso» de forma síncrona, así que no queda ningún hueco sin cubrir.
    cerrando = false;
    if (id !== null) await transcribirReunion(id);
  } finally {
    cerrando = false;
  }
}

// Devuelve el id a transcribir, o null si no hay nada que mandar al modelo.
async function cierraGrabacion() {
  clearInterval(rotaTimer);
  clearInterval(parcialTimer);
  rotaTimer = null;
  medidores.forEach((m) => clearInterval(m.timer));
  const audio = informeAudio();
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }

  // Ningún tramo se descarta antes de que su medida exacta esté hecha.
  await Promise.all(medidas);
  medidas = [];
  if (ctxDecode) { try { await ctxDecode.close(); } catch (_) {} ctxDecode = null; }

  const partes = tramos.slice();
  tramos = [];
  const id = reunionActual;
  const minutos = Math.max(1, Math.round((Date.now() - tInicio) / 60000));
  const bytes = partes.reduce((a, p) => a + p.blob.size, 0);
  const conSonido = partes.filter((p) => p.pico >= PICO_SILENCIO);

  // La entrada se creó al empezar; si aquello falló, se crea ahora.
  const existe = await aBg("histLeer", { id }).catch(() => null);
  if (!existe) await histCrear(entradaNueva());
  const meta = { ...((existe && existe.meta) || {}), fichero: fechaBonita(id).fichero, minutos, audioLinea: audio.linea, audioAlerta: audio.alerta };

  // Silencio: NO se manda a Gemini. Ante un audio mudo el modelo no dice "no oigo
  // nada", se inventa una reunión entera con hablantes y acuerdos que no existen.
  if (!bytes || !conSonido.length) {
    await histActualizar(id, {
      estado: "error", progreso: "", meta, tramos: [],
      transcript: "# No se grabó audio\n\n" +
        "**No se ha transcrito nada a propósito:** la grabación está muda y, si se le manda silencio, " +
        "el modelo se inventa una reunión que nunca ocurrió.\n\n" +
        (audio.linea ? `**Niveles medidos:** ${audio.linea}\n` : "") + audio.alerta +
        "\nQué revisar:\n" +
        "· En «Pestaña + micro» la pestaña tiene que estar SONANDO (una página abierta sin audio no vale).\n" +
        "· Para una reunión presencial usa «Solo micro».\n" +
        "· Comprueba el permiso de micrófono en Opciones y que no esté silenciado en Windows.\n",
    });
    for (let i = 0; i < partes.length; i++) await olvidaAudio(id, i);
    avisar(false);
    return null;
  }

  const lista = partes.map((p, i) => ({
    estado: p.pico < PICO_SILENCIO ? "mudo" : "pendiente", pico: p.pico, etiqueta: etiquetaTramo(i),
  }));
  for (let i = 0; i < lista.length; i++) if (lista[i].estado === "mudo") await olvidaAudio(id, i);
  await histActualizar(id, {
    estado: "transcribiendo", meta, tramos: lista, progreso: `${lista.length - conSonido.length}/${lista.length} tramos`,
  });
  return id;
}

// --- motor de transcripción --------------------------------------------------
// Transcribe los tramos PENDIENTES de una reunión del historial. Sirve igual
// para la primera pasada, un reintento o un archivo importado: todo lo que
// necesita está en el historial (qué falta) y en IndexedDB (el audio).
async function transcribirReunion(id) {
  if (enCurso.has(id)) return { ok: true, yaEnCurso: true };
  enCurso.add(id);
  try {
    await ronda(id);
    return { ok: true };
  } finally {
    enCurso.delete(id);
  }
}

async function ronda(id) {
  const h = await aBg("histLeer", { id });
  if (!h || !Array.isArray(h.tramos)) return;
  const total = h.tramos.length;
  const cola = h.tramos.map((t, i) => (t.estado === "pendiente" ? i : -1)).filter((i) => i >= 0);
  if (cola.length) await histActualizar(id, { estado: "transcribiendo" });

  // Una clave mala o ausente no se arregla en el tramo siguiente: en cuanto
  // aparece, el resto de la ronda ni se intenta (sería gastar llamadas).
  let parar = null, borrada = false;
  const trabajador = async () => {
    while (cola.length && !borrada) {
      const i = cola.shift();
      const res = parar ? { ...parar } : await transcribirTramo(id, i, total, h.tramos[i]);
      if (!parar && res.estado === "pendiente" && CODIGOS_CLAVE.includes(res.codigo)) {
        parar = { estado: "pendiente", codigo: res.codigo, error: res.error, detalle: res.detalle };
      }
      const g = await histTramo(id, i, res);
      if (g && g.borrada) { borrada = true; break; }
      // El audio se borra DESPUÉS de que el texto esté guardado: al revés, un
      // fallo entre medias perdería las dos cosas.
      if (g && g.ok && (res.estado === "ok" || res.estado === "mudo")) await olvidaAudio(id, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, cola.length) }, trabajador));
  if (ctxDecode) { try { await ctxDecode.close(); } catch (_) {} ctxDecode = null; }
  if (borrada) {
    // El usuario borró la reunión mientras se transcribía: no queda nada que guardar.
    if (audios) await audios.borrarReunion(id).catch(() => {});
    return;
  }
  await cierraRonda(id);
}

async function transcribirTramo(id, i, total, tramo) {
  const pendiente = (codigo, e) => ({
    estado: "pendiente", codigo, error: textoError(codigo),
    detalle: String((e && e.message) || e || "").slice(0, 300),
  });
  let blob;
  try {
    blob = await leeAudio(id, i);
  } catch (e) {
    return pendiente("interno", e); // IndexedDB no responde: el audio puede seguir ahí
  }
  if (!blob) return { estado: "perdido", error: textoError("perdido") };

  let pico = tramo && typeof tramo.pico === "number" ? tramo.pico : null;
  if (pico === null) {
    // Tramo recuperado de una grabación interrumpida: nadie lo midió.
    try { pico = (await medirExacto(blob)).pico; } catch (_) { pico = PICO_SILENCIO; }
  }
  if (pico < PICO_SILENCIO) return { estado: "mudo", pico };

  try {
    const r = await transcribirGemini(blob, i + 1, total);
    if (r.sinVoz) return { estado: "mudo", pico };
    return { estado: "ok", texto: r.texto, truncado: !!r.truncado, pico };
  } catch (e) {
    return { ...pendiente((e && e.codigo) || "otro", e), pico };
  }
}

// Fin de ronda: copia de seguridad en Descargas del audio que sigue pendiente,
// .md rehecho desde el historial y, si falta algo, el service worker programa
// el siguiente intento.
async function cierraRonda(id) {
  const h = await aBg("histLeer", { id });
  if (!h) return;
  const fichero = (h.meta && h.meta.fichero) || fechaBonita(id).fichero;
  for (let i = 0; i < h.tramos.length; i++) {
    const t = h.tramos[i];
    if (t.estado !== "pendiente" || typeof t.dlAudio === "number") continue;
    try {
      const blob = await leeAudio(id, i);
      if (!blob) continue;
      const ext = /wav/.test(blob.type || "") ? "wav" : "webm";
      const r = await descargar(await blobADataUrl(blob),
        `reuniones/audio_${fichero}/tramo${String(i + 1).padStart(2, "0")}.${ext}`);
      if (r && typeof r.id === "number") await histTramo(id, i, { dlAudio: r.id });
    } catch (_) { /* best-effort: el audio sigue en IndexedDB */ }
  }
  const fin = await aBg("finRonda", { id });
  avisar(!!(fin && fin.estado === "ok"));
  await aBg("podar"); // aplica el límite configurado en Opciones
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
  const key = cfg.geminiKey;
  if (!key) throw marcar(new Error("Falta la clave de Gemini: ábrela en Opciones."), { codigo: "sin_clave" });
  const preferido = (cfg && cfg.geminiModel) || MODELOS_RESERVA[0];
  const modelos = [preferido, ...MODELOS_RESERVA.filter((m) => m !== preferido)];

  const { parte: parteAudio, fileName } = await prepararAudio(blob, key);
  const prompt = construirPrompt((cfg && cfg.glosario) || "", idx, total);

  try {
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
  } finally {
    // Lo subido por Files API caduca a las 48 h, pero mientras tanto ocupa
    // cuota de la clave del usuario. Se borra en cuanto deja de hacer falta.
    if (fileName) {
      try {
        await fetch(`${BASE}/v1beta/${fileName}`, { method: "DELETE", headers: { "x-goog-api-key": key } });
      } catch (_) { /* si no se puede, caducará solo */ }
    }
  }
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
    throw marcar(new Error("Sin conexión con Gemini: " + ((e && e.message) || e)), { reintentable: true, codigo: "red" });
  }

  if (!res.ok) {
    const txt = (await res.text()).slice(0, 400);
    const e = new Error(`Gemini HTTP ${res.status} (${modelo}): ${txt}`);
    if ([408, 429, 500, 502, 503, 504].includes(res.status)) {
      const d = /"retryDelay"\s*:\s*"(\d+)s"/.exec(txt);
      throw marcar(e, { reintentable: true, codigo: "saturado", esperaMs: d ? Number(d[1]) * 1000 : 0 });
    }
    // Clave mala o sin permisos: cambiar de modelo no arregla nada.
    if (res.status === 401 || res.status === 403 || /API key/i.test(txt)) throw marcar(e, { fatal: true, codigo: "clave_invalida" });
    throw marcar(e, { codigo: "otro" }); // el resto (404…) deja probar el siguiente modelo
  }

  const data = await res.json();
  const cand = (data.candidates || [])[0];
  const razon = cand && cand.finishReason;
  const texto = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").trim();
  if (!texto) {
    throw marcar(new Error("Gemini devolvió texto vacío" + (razon ? ` (finishReason: ${razon})` : "") + " — ¿tramo en silencio?"),
      { reintentable: true, codigo: "otro" });
  }
  // El modelo confirma que no hay voz: se respeta, no se reintenta.
  if (/^\s*SIN_VOZ[\s.]*$/i.test(texto)) return { texto: "", sinVoz: true };
  return { texto, truncado: razon === "MAX_TOKENS" };
}

// Audio pequeño va en el propio cuerpo; grande, por la Files API.
// Devuelve la parte lista para la petición y, si se subió por Files API, el
// nombre del fichero remoto para poder borrarlo después.
async function prepararAudio(blob, key) {
  // Lo grabado es webm; lo importado se convierte a wav (importar.js).
  const mime = /wav/.test(blob.type || "") ? "audio/wav" : "audio/webm";
  if (blob.size < LIMITE_INLINE) {
    return { parte: { inline_data: { mime_type: mime, data: (await blobADataUrl(blob)).split(",")[1] } }, fileName: "" };
  }
  const auth = { "x-goog-api-key": key };
  let up;
  try {
    up = await fetch(`${BASE}/upload/v1beta/files`, {
      method: "POST",
      headers: { ...auth, "X-Goog-Upload-Protocol": "raw", "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": mime },
      body: blob,
    });
  } catch (e) {
    throw marcar(new Error("Sin conexión con Gemini al subir el audio: " + ((e && e.message) || e)), { codigo: "red" });
  }
  if (!up.ok) {
    const e = new Error("Subida del audio a Gemini falló: HTTP " + up.status);
    if (up.status === 401 || up.status === 403) throw marcar(e, { codigo: "clave_invalida" });
    throw marcar(e, { codigo: up.status >= 500 || up.status === 429 ? "saturado" : "otro" });
  }
  let file = (await up.json()).file;
  let n = 0;
  while (file.state === "PROCESSING" && n++ < 90) {
    await espera(2000);
    file = await (await fetch(`${BASE}/v1beta/${file.name}`, { headers: auth })).json();
  }
  if (file.state !== "ACTIVE") throw marcar(new Error("Gemini no procesó el audio (estado " + file.state + ")."), { codigo: "otro" });
  return { parte: { file_data: { mime_type: mime, file_uri: file.uri } }, fileName: file.name };
}

// --- utilidades ---
function blobADataUrl(blob) {
  return new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(blob); });
}
