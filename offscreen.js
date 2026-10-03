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
let altavoz = null;        // lo que devuelve la pestaña capturada a los altavoces (ver abreAltavoz)
const MS_PARCIAL = 30 * 1000;         // cada cuánto se guarda el tramo que se está grabando
let tramos = [], trozosTramo = [], tabTitle = "", medidores = [], errorMic = "";
let participantes = "";     // los que escribió el usuario al empezar (opcional)
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

// --- tiempo GRABADO (3.3) ---
// Con pausa, el reloj de pared y el audio dejan de coincidir. Las marcas de
// tiempo, los tramos y la duración se cuentan en tiempo grabado: es lo único
// que casa con el audio.
let pausado = false;
let msGrabadosAntes = 0;   // grabado hasta el inicio del tramo en curso
let msTramoPrevio = 0;     // grabado del tramo en curso antes de la última reanudación
let tActivoDesde = 0;      // cuándo empezó el trozo activo actual (sin pausa)
let durCierreMs = 0;       // duración del tramo que se está cerrando
let inicioTramoS = 0;      // dónde empieza, en la reunión, el tramo en curso
const msTramoEnCurso = () => msTramoPrevio + (pausado ? 0 : Date.now() - tActivoDesde);
const segundosGrabados = () => Math.round((msGrabadosAntes + msTramoEnCurso()) / 1000);

// Los tramos que se cierran mientras se sigue grabando se transcriben ya, de uno
// en uno. Al parar solo queda el último: el resultado llega en segundos.
let colaVivo = Promise.resolve();

// --- aviso de silencio en vivo (3.3) ---
// Una pestaña que no suena o un micro silenciado se descubrían al terminar la
// reunión. Ahora, si en dos minutos no entra voz por ninguna fuente, se avisa.
const MS_AVISO_SILENCIO = 2 * 60 * 1000;
let ultimaVoz = 0, avisadoSilencio = false, silencioTimer = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  (async () => {
    try {
      if (msg.cmd === "start") { await start(msg); sendResponse({ ok: true, id: reunionActual, titulo: tabTitle }); }
      else if (msg.cmd === "stop") { stop(); sendResponse({ ok: true }); }
      else if (msg.cmd === "pausar") { sendResponse({ ok: pausar() }); }
      else if (msg.cmd === "reanudar") { sendResponse({ ok: reanudar() }); }
      // Minuto grabado de la reunión en curso (para marcar momentos).
      else if (msg.cmd === "tiempo") {
        sendResponse({ ok: true, id: yaProcesado ? null : reunionActual, t: yaProcesado ? 0 : segundosGrabados(), pausado });
      }
      // Para el popup y el panel en vivo: nivel de cada fuente ahora mismo.
      else if (msg.cmd === "niveles") {
        despiertaMedidorRapido();
        sendResponse({
          ok: true, id: yaProcesado ? null : reunionActual, t: yaProcesado ? 0 : segundosGrabados(), pausado,
          fuentes: medidores.map((m) => ({ nombre: m.nombre, rms: m.nivel !== null ? m.nivel : (m.ultimoRms || 0) })), sinMicro: !!errorMic,
        });
      }
      else if (msg.cmd === "selftest") { sendResponse(await selftest(msg)); }
      // «¿No oyes la reunión?» del popup: cambia en vivo la forma de devolver el sonido.
      else if (msg.cmd === "altavoz") {
        const a = altavozActual();
        if (!a) sendResponse({ ok: false, modo: null });
        else sendResponse({ ok: true, modo: msg.accion === "cambiar" ? await cambiaAltavoz() : a.modo });
      }
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
    } catch (e) { sendResponse({ ok: false, error: (e && e.message) || String(e), ...(e && e.cancelado ? { cancelado: true } : {}) }); }
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

// Idioma de la interfaz para lo que este documento escribe en el historial
// (títulos, avisos del .md, errores). Aquí no hay chrome.storage, así que
// cargarIdiomaUI() solo puede quedarse con el idioma de Chrome: lo elegido en
// Opciones (idiomaUI) llega con la configuración y se aplica encima. `cfg` es
// opcional: sin él se pide una vez, sin reintentos (no puede retrasar la grabación).
async function ponIdioma(cfg) {
  await cargarIdiomaUI();
  const c = cfg !== undefined ? cfg : await aBg("cfg").catch(() => null);
  if (c && typeof c === "object" && "idiomaUI" in c) ponIdiomaUI(c.idiomaUI);
}

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
  throw marcar(new Error(t("off.sinConfig", (ultimo && ultimo.message) || ultimo)), { codigo: "interno" });
}

// --- grabación ---
// Tres formas (`modo`):
//  "orig_mic" (3.7, la principal): Chrome enseña su ventana de «elegir qué
//    compartir» y entrega el sonido de la pestaña (o de todo el equipo) SIN
//    silenciarla. Lo que se oye es el sonido original, sin pasar por aquí.
//  "tab_mic" (la rápida): la pestaña que suena, con un clic y sin preguntar. A
//    cambio Chrome la silencia y hay que devolver su sonido (abreAltavoz), y esa
//    captura pierde trozos cuando el equipo ahorra energía: con batería se oye
//    con cortes y no hay forma de evitarlo desde una extensión.
//  "mic": solo el micrófono.

// Pide a Chrome lo que el usuario quiera compartir. Este documento no se ve, pero
// la ventana de elegir la pone Chrome y no hace falta gesto (probado en Chrome y
// Edge 154). Devuelve el stream ya sin imagen y qué se eligió.
let pidiendoCompartir = false;
async function pideCompartir() {
  if (pidiendoCompartir) throw new Error(t("off.compartirYaAbierto"));
  pidiendoCompartir = true;
  let s;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      // Pestañas primero; la imagen la exige Chrome, pero no se usa.
      video: { displaySurface: "browser" },
      // Sin tocar: ni cancelación de eco ni reducción de ruido (vienen puestas por
      // defecto y están pensadas para un micro, no para el sonido de una reunión).
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",        // «toda la pantalla» puede traer el sonido del equipo (Teams de escritorio…)
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    });
  } catch (e) {
    const cancelado = !!e && e.name === "NotAllowedError";
    const err = new Error(cancelado ? t("off.compartirCancelado") : t("off.compartirFallo", (e && e.message) || String(e)));
    err.cancelado = cancelado;
    throw err;
  } finally {
    pidiendoCompartir = false;
  }
  const video = s.getVideoTracks()[0];
  const superficie = (video && video.getSettings && video.getSettings().displaySurface) || "";
  s.getVideoTracks().forEach((v) => v.stop());
  if (!s.getAudioTracks().length) {
    // Una ventana suelta no trae sonido, y en pestaña o pantalla se puede desmarcar.
    s.getTracks().forEach((p) => p.stop());
    throw new Error(t("off.compartirSinAudio"));
  }
  return { stream: s, superficie };
}

async function start({ modo, streamId, tabTitle: tt, participantes: pp }) {
  // Una sola petición, sin reintentos: no puede retrasar la grabación.
  const cfgInicio = await aBg("cfg").catch(() => null);
  await ponIdioma(cfgInicio);
  // Antes de montar nada: el usuario puede tardar en elegir, o cancelar.
  const compartido = modo === "orig_mic" ? await pideCompartir() : null;
  // Chrome no dice qué pestaña se eligió: vale el título de la que había delante.
  tabTitle = compartido && compartido.superficie !== "browser" ? t("off.tituloPantalla") : tt || "";
  participantes = (pp || "").trim();
  // "playback": este contexto no necesita respuesta inmediata, solo alimenta la
  // grabación. Con el valor por defecto trabaja en bloques de ~10 ms y cualquier
  // tirón del proceso se oye como un chasquido si algo sale por él a los altavoces.
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
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
    abreAltavoz(tabStream, cfgInicio && cfgInicio.modoAltavoz);
    clearInterval(vigiaAltavoz);
    vigiaAltavoz = setInterval(vigilaAltavoz, 2000);
    medidores.push(vigila("pestaña", g));
  }

  if (compartido) {
    streams.push(compartido.stream);
    const g = audioCtx.createGain();
    audioCtx.createMediaStreamSource(compartido.stream).connect(g);
    g.connect(mezcla);
    // Sin altavoz: aquí Chrome no silencia nada y lo que se oye es el original.
    medidores.push(vigila("pestaña", g));
    // «Dejar de compartir» en la barra de Chrome, o la pestaña cerrada: la
    // grabación termina como si se hubiera pulsado Parar.
    compartido.stream.getAudioTracks()[0].addEventListener("ended", () => {
      if (!yaProcesado && !finalizando) aBg("finCaptura").catch(() => {});
    });
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
    if (modo === "mic") throw new Error(t("off.sinPermisoMicro"));
  }

  tramos = [];
  trozosTramo = [];
  medidas = [];
  finalizando = false;
  tInicio = Date.now();
  pausado = false;
  msGrabadosAntes = 0;
  inicioTramoS = 0;
  colaVivo = Promise.resolve();
  textoVivoAnterior = "";
  ultimaVoz = tInicio;
  avisadoSilencio = false;
  clearInterval(silencioTimer);
  silencioTimer = setInterval(() => revisaSilencio(Date.now()), 10000);
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
  msTramoPrevio = 0;
  tActivoDesde = Date.now();
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
    const inicioS = inicioTramoS;
    msGrabadosAntes += durCierreMs;
    inicioTramoS = Math.round(msGrabadosAntes / 1000);
    if (blob.size) {
      // El nivel del analizador vale para el informe por fuente, pero NO para
      // decidir si un tramo es silencio: solo mira 42 ms de cada segundo, así
      // que una intervención corta se le escapa entera. Sobre ese dato se
      // descartaban tramos con voz sin llegar a preguntar al modelo.
      const entrada = { blob, pico: nivel.pico, voz: nivel.voz, inicioS };
      tramos.push(entrada); // se encola YA: así el orden de los tramos es el real
      const idx = tramos.length - 1;
      guardaAudio(reunionActual, idx, blob);
      // La medida exacta va en paralelo. Retrasar aquí el arranque del tramo
      // siguiente dejaría un hueco sin grabar en la reunión.
      const medida = medirExacto(blob).then((m) => {
        if (m) { entrada.pico = m.pico; entrada.voz = m.voz; }
        // Si no se pudo decodificar, se manda igual: mejor gastar 3 céntimos
        // que tirar un tramo que quizá tenía voz.
        else entrada.pico = Math.max(entrada.pico, PICO_SILENCIO);
      }, () => { entrada.pico = Math.max(entrada.pico, PICO_SILENCIO); });
      medidas.push(medida);
      if (!finalizando) tramoCerrado(reunionActual, idx, entrada, medida);
    }
    if (finalizando) procesar();
    else arrancaTramo(stream); // siguiente tramo, la grabación no se interrumpe
  };
  mediaRecorder.start(2000);
}

// --- devolver la pestaña a los altavoces (3.5.1) ---
// Capturar una pestaña la deja muda (Chrome no deja evitarlo: probado el 01/10),
// así que su sonido hay que devolverlo. Dos formas:
//  «audio»: un <audio> con el stream. El reproductor de Chrome para audio en
//    directo lleva su propio colchón; por el AudioContext de la grabación la
//    reunión se oía con microcortes (24/09). Es la que mejor aguantó en las
//    medidas: 0 % de huecos, también con el equipo al 100 %.
//  «contexto»: un AudioContext APARTE solo para sonar, con colchón grande
//    («playback»), sin tocar el de la grabación.
// Ninguna vale para todos los equipos (en un monitor por HDMI el <audio> salió
// troceado), así que: si cambia el dispositivo de salida se rehace; un vigía
// reinicia el <audio> que se atasca y, en automático, a los tres reinicios pasa
// al motor; y desde el popup («¿No oyes la reunión?») se cambia en vivo.
//
//  «colchon» (3.7.0, la que se usa en automático): reproductor propio con una
//    reserva de audio. Las dos de arriba suenan con microcortes SIEMPRE, también
//    con el equipo parado: medido con un tono, en 20 s el <audio> pierde o repite
//    muestras un centenar de veces y mete huecos de hasta 50 ms, y el motor mete
//    un hueco de 10 ms por segundo. Lo capturado llega entero; lo estropean ellos
//    al reproducirlo casi sin reserva. Aquí el audio va de la captura a un anillo
//    (altavoz-bomba.js, en un hilo aparte) y de ahí a los altavoces
//    (altavoz-colchon.js), con MS_COLCHON de reserva. Las otras dos quedan como
//    alternativa si Chrome no deja usar esta.
const MS_COLCHON = 60;
const colchonDisponible = () => typeof MediaStreamTrackProcessor !== "undefined" &&
  typeof AudioWorkletNode !== "undefined" && typeof Worker !== "undefined";
let vigiaAltavoz = null;
if (typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  // Se desconecta el monitor, se enchufan unos cascos…: el sonido se rehace en la salida nueva.
  navigator.mediaDevices.addEventListener("devicechange", () => { if (altavoz) reiniciaAltavoz(); });
}

// preferencia: "auto" (por defecto), "colchon", "audio" o "contexto" (Opciones o el popup).
function abreAltavoz(stream, preferencia) {
  const auto = !preferencia || preferencia === "auto";
  const modo = auto || preferencia === "colchon" ? (colchonDisponible() ? "colchon" : "audio") : preferencia;
  altavoz = { stream, modo, auto, el: null, ctx: null, copia: null, bomba: null, colchon: null, reinicios: 0, quietos: 0, ultimoT: 0 };
  enciendeAltavoz();
  return altavoz;
}

// La pestaña capturada, a los altavoces con reserva: captura → hilo aparte → anillo.
async function enciendeColchon(a) {
  const pista = a.stream.getAudioTracks()[0];
  const hz = (pista.getSettings && pista.getSettings().sampleRate) || 48000;
  // Al ritmo de la captura: si la tarjeta va a otro (44,1 kHz, 96 kHz…), Chrome
  // convierte a la salida, igual que hace el contexto de la grabación.
  const ctx = new AudioContext({ sampleRate: hz, latencyHint: "interactive" });
  a.ctx = ctx;
  await ctx.audioWorklet.addModule("altavoz-colchon.js");
  if (altavoz !== a || a.ctx !== ctx) return; // se soltó o se cambió mientras cargaba
  const nodo = new AudioWorkletNode(ctx, "escriba-altavoz", {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { hzEntrada: hz, colchonMs: MS_COLCHON },
  });
  nodo.port.onmessage = (e) => { if (e.data && e.data.estado) a.colchon = e.data.estado; };
  nodo.connect(ctx.destination);
  // El audio no pasa por este documento: va de la captura al hilo de la bomba y de
  // ahí al del sonido, por un canal entre los dos.
  const canal = new MessageChannel();
  nodo.port.postMessage({ entrada: canal.port1 }, [canal.port1]);
  a.copia = pista.clone();
  const audio = new MediaStreamTrackProcessor({ track: a.copia }).readable;
  a.bomba = new Worker("altavoz-bomba.js");
  a.bomba.onmessage = (e) => { if (e.data && e.data.remiendo) a.remiendos = (a.remiendos || 0) + 1; };
  a.bomba.postMessage({ audio, salida: canal.port2 }, [audio, canal.port2]);
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

function enciendeAltavoz() {
  const a = altavoz;
  if (!a) return;
  a.quietos = 0;
  a.ultimoT = 0; // un <audio> recién creado empieza en 0: si no se mueve de ahí, no suena
  if (a.modo === "colchon") {
    enciendeColchon(a).catch((e) => {
      if (altavoz !== a || a.modo !== "colchon") return;
      console.warn("Escriba: el altavoz con colchón no arranca, la pestaña va por el <audio>:", e);
      cambiaAltavoz("audio");
    });
    return;
  }
  if (a.modo === "contexto") {
    a.ctx = new AudioContext({ latencyHint: "playback" });
    a.ctx.createMediaStreamSource(a.stream).connect(a.ctx.destination);
    if (a.ctx.state === "suspended") a.ctx.resume().catch(() => {});
    return;
  }
  const el = new Audio();
  el.srcObject = a.stream;
  a.el = el;
  // No se espera a play(): con una pestaña callada podría tardar, y la grabación
  // no puede quedarse esperando. Si Chrome no deja sonar el <audio>, motor.
  el.play().catch((e) => {
    if (altavoz !== a || a.el !== el) return; // ya se soltó o se cambió
    console.warn("Escriba: el <audio> no pudo sonar, la pestaña va por el motor de audio:", e);
    cambiaAltavoz("contexto");
  });
}

function apagaAltavoz() {
  const a = altavoz;
  if (!a) return;
  if (a.el) { try { a.el.pause(); } catch (_) {} a.el.srcObject = null; a.el = null; }
  if (a.bomba) { try { a.bomba.terminate(); } catch (_) {} a.bomba = null; }
  if (a.copia) { try { a.copia.stop(); } catch (_) {} a.copia = null; }
  if (a.ctx) { try { a.ctx.close(); } catch (_) {} a.ctx = null; }
}

// Sin argumento, pasa a la siguiente: colchón → <audio> → motor → colchón. Devuelve
// la forma que queda (null sin grabación).
async function cambiaAltavoz(modo) {
  if (!altavoz) return null;
  apagaAltavoz();
  const orden = colchonDisponible() ? ["colchon", "audio", "contexto"] : ["audio", "contexto"];
  altavoz.modo = modo || orden[(orden.indexOf(altavoz.modo) + 1) % orden.length];
  enciendeAltavoz();
  return altavoz.modo;
}

function reiniciaAltavoz() {
  apagaAltavoz();
  enciendeAltavoz();
}

function altavozActual() { return altavoz; }

function cierraAltavoz() {
  clearInterval(vigiaAltavoz);
  vigiaAltavoz = null;
  apagaAltavoz();
  altavoz = null;
}

// Cada 2 s. Un <audio> en directo avanza siempre, aunque la reunión calle: si no
// se mueve dos vueltas seguidas, está atascado.
async function vigilaAltavoz() {
  const a = altavoz;
  if (!a) return;
  if (a.modo === "contexto" || a.modo === "colchon") {
    if (a.ctx && a.ctx.state === "suspended") a.ctx.resume().catch(() => {});
    return;
  }
  const el = a.el;
  if (!el) return;
  const atascado = el.paused || el.ended || el.readyState < 2 || el.currentTime === a.ultimoT;
  a.ultimoT = el.currentTime;
  a.quietos = atascado ? a.quietos + 1 : 0;
  if (a.quietos < 2) return;
  a.reinicios++;
  if (a.auto && a.reinicios >= 3) await cambiaAltavoz("contexto");
  else reiniciaAltavoz();
}

function cortaTramo() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    cierreEnCurso = true;
    durCierreMs = msTramoEnCurso();
    mediaRecorder.stop();
  }
}

// Pausa: el tramo en curso se queda abierto (MediaRecorder.pause) y el corte de
// tramo se reprograma al reanudar con lo que le falte de tiempo GRABADO.
function pausar() {
  if (yaProcesado || finalizando || pausado || !mediaRecorder || mediaRecorder.state !== "recording") return false;
  msTramoPrevio += Date.now() - tActivoDesde;
  pausado = true;
  clearInterval(rotaTimer);
  clearTimeout(rotaTimer);
  rotaTimer = null;
  mediaRecorder.pause();
  return true;
}

function reanudar() {
  if (!pausado || finalizando || !mediaRecorder) return false;
  pausado = false;
  tActivoDesde = Date.now();
  ultimaVoz = tActivoDesde; // la pausa no cuenta como silencio
  mediaRecorder.resume();
  const restante = Math.max(1000, MS_TRAMO - msTramoPrevio);
  rotaTimer = setTimeout(() => {
    if (pausado || finalizando) return;
    cortaTramo();
    rotaTimer = setInterval(cortaTramo, MS_TRAMO);
  }, restante);
  return true;
}

function stop() {
  if (finalizando) return;
  finalizando = true;
  clearInterval(rotaTimer);
  clearTimeout(rotaTimer);
  rotaTimer = null;
  // En pausa también hay que cerrar el tramo: si no, su audio no llega a `tramos`.
  if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
    cierreEnCurso = true;
    durCierreMs = msTramoEnCurso();
    pausado = false;
    mediaRecorder.stop();
  } else if (!cierreEnCurso) {
    procesar(); // no hay ningún tramo cerrándose: nadie más va a llamar
  }
  // Si cierreEnCurso, el onstop pendiente ya verá `finalizando` y procesará.
  // Procesar aquí perdería ese último tramo, que aún no está en `tramos`.
}

// Medidor para las barras del popup y del panel (3.6.1). El de vigila() mide una
// sola ventana de 43 ms por segundo: vale para la estadística de voz, pero en
// pantalla la barra saltaba una vez por segundo y marcaba casi cero si esa
// ventana caía entre dos palabras. Este mide cada 50 ms, sube al momento y baja
// despacio, como un vúmetro. Solo corre mientras alguien pide «niveles»: se
// apaga solo 2 s después de la última petición.
let rapidoInt = null, rapidoHasta = 0;
const PASO_RAPIDO_MS = 50, CAIDA_RAPIDO = 0.8;
function despiertaMedidorRapido() {
  rapidoHasta = Date.now() + 2000;
  if (rapidoInt) return;
  rapidoInt = setInterval(() => {
    if (Date.now() > rapidoHasta || !medidores.length) {
      clearInterval(rapidoInt);
      rapidoInt = null;
      for (const m of medidores) m.nivel = null;
      return;
    }
    for (const m of medidores) {
      const rms = m.rmsAhora();
      m.nivel = m.nivel === null || rms >= m.nivel ? rms : m.nivel * CAIDA_RAPIDO + rms * (1 - CAIDA_RAPIDO);
    }
  }, PASO_RAPIDO_MS);
}

// Mide cuánta voz entra por cada fuente. Si luego la transcripción sale llena
// de [inaudible], el informe dice cuál de las dos venía muda o baja.
function vigila(nombre, nodo) {
  const an = audioCtx.createAnalyser();
  an.fftSize = 2048;
  nodo.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rmsAhora = () => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  };
  const m = { nombre, pico: 0, muestras: 0, conVoz: 0, timer: null, picoTramo: 0, muestrasTramo: 0, vozTramo: 0, rmsAhora, nivel: null };
  m.timer = setInterval(() => {
    const rms = rmsAhora();
    m.muestras++; m.muestrasTramo++;
    m.ultimoRms = rms;
    if (rms > m.pico) m.pico = rms;
    if (rms > m.picoTramo) m.picoTramo = rms;
    if (rms > 0.008) { m.conVoz++; m.vozTramo++; registraVoz(Date.now()); }
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

// El nombre de un medidor («pestaña», «micrófono») es un identificador: el panel
// en vivo lo compara tal cual. Lo que se escribe en el informe es su traducción.
const nombreFuente = (n) => (n === "pestaña" ? t("off.fuentePestana") : n === "micrófono" ? t("off.fuenteMicro") : n);

// Resumen de niveles + aviso si una fuente no ha sonado en toda la reunión.
function informeAudio() {
  const partes = [], mudas = [];
  for (const m of medidores) {
    const pct = m.muestras ? Math.round((100 * m.conVoz) / m.muestras) : 0;
    partes.push(t("off.nivelFuente", nombreFuente(m.nombre), pct, m.pico.toFixed(2)));
    if (pct < 2) mudas.push(nombreFuente(m.nombre));
  }
  if (errorMic) partes.push(t("off.microNoDisponible"));
  let alerta = "";
  if (errorMic) alerta += `\n> ⚠️ ${t("off.alertaMicro", errorMic)}\n> ${t("off.alertaMicroTxt")}\n`;
  if (mudas.length) alerta += `\n> ⚠️ ${t("off.sinSenal", mudas.reduce((a, b) => t("off.y", a, b)))}\n`;
  return { linea: partes.join(" · "), alerta };
}

function registraVoz(ts) {
  ultimaVoz = ts;
  if (avisadoSilencio) {
    avisadoSilencio = false;
    aBg("silencio", { hay: false }).catch(() => {});
  }
}

function revisaSilencio(ahora) {
  if (yaProcesado || finalizando || pausado || avisadoSilencio) return;
  if (ahora - ultimaVoz >= MS_AVISO_SILENCIO) {
    avisadoSilencio = true;
    aBg("silencio", { hay: true }).catch(() => {});
  }
}

// El final del último tramo transcrito en vivo: se le pasa al siguiente para que
// siga con las mismas etiquetas de hablante (3.5.1). Se vacía al empezar.
let textoVivoAnterior = "";

// Las últimas líneas de un tramo, cortas: lo justo para seguir la conversación.
function finalDeTramo(texto) {
  const lineas = String(texto || "").split("\n").filter((l) => l.trim()).slice(-6).join("\n");
  return lineas.length > 600 ? lineas.slice(-600) : lineas;
}

// Un tramo recién cerrado mientras se sigue grabando: se mide, se apunta en el
// historial y se transcribe, sin esperar a que acabe la reunión. Va en cola, de
// uno en uno, detrás del anterior.
function tramoCerrado(id, idx, entrada, medida) {
  colaVivo = colaVivo.then(async () => {
    await medida; // la medida exacta decide si es silencio
    const base = { pico: entrada.pico, etiqueta: etiquetaTramo(idx), inicioS: entrada.inicioS };
    if (entrada.pico < PICO_SILENCIO) {
      await histTramo(id, idx, { ...base, estado: "mudo" });
      await olvidaAudio(id, idx);
      return;
    }
    await histTramo(id, idx, { ...base, estado: "pendiente" });
    const res = await transcribirTramo(id, idx, null, { ...base, estado: "pendiente" }, { participantes, anterior: textoVivoAnterior });
    if (res.estado === "ok") textoVivoAnterior = res.texto || "";
    const g = await histTramo(id, idx, res);
    if (g && g.ok && res.estado === "ok") await conservaAudio(id, idx, await leerConfig().catch(() => null));
    if (g && g.ok && (res.estado === "ok" || res.estado === "mudo")) await olvidaAudio(id, idx);
  }).catch((e) => console.warn("Escriba: transcripción en vivo", e));
}

function entradaNueva() {
  const f = fechaBonita(reunionActual);
  return {
    // Sin pestaña (Solo micro), el título sale de los participantes: «Reunión» a
    // secas no dice nada en una lista de veinte.
    id: reunionActual, fecha: f.legible, origen: "grabacion",
    titulo: tabTitle || (participantes ? t("off.reunionCon", participantes) : t("off.reunionPresencial")),
    estado: "grabando", progreso: "", transcript: "", analisis: {}, tramos: [], meta: { fichero: f.fichero },
    participantes,
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

// Antes de borrar el audio de un tramo ya transcrito, se copia al almacén de
// escucha si el usuario quiere poder oír la reunión desde la biblioteca.
async function conservaAudio(id, idx, cfg) {
  if (!cfg || !cfg.conservarAudio || !audios || !audios.guardarEscucha) return;
  try {
    const blob = await leeAudio(id, idx);
    if (blob) await audios.guardarEscucha(id, idx, blob);
  } catch (e) { console.warn("Escriba: no se pudo conservar el audio del tramo", idx, e); }
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
  clearInterval(silencioTimer);
  rotaTimer = null;
  if (avisadoSilencio) { avisadoSilencio = false; aBg("silencio", { hay: false }).catch(() => {}); }
  medidores.forEach((m) => clearInterval(m.timer));
  const audio = informeAudio();
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  // Para el diagnóstico de «no oigo nada»: con qué forma sonó y cuántas veces se reinició.
  const infoAltavoz = altavoz
    ? {
      modo: altavoz.modo, reinicios: altavoz.reinicios,
      // Con el colchón: huecos que se oyeron, saltos para ponerse al día y trozos que
      // perdió Chrome y hubo que remendar (con batería, hasta uno por segundo).
      ...(altavoz.modo === "colchon" ? { huecos: (altavoz.colchon || {}).vacios || 0, saltos: (altavoz.colchon || {}).tirados || 0, remiendos: altavoz.remiendos || 0 } : {}),
    }
    : null;
  cierraAltavoz();
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }

  // Ningún tramo se descarta antes de que su medida exacta esté hecha, y lo que
  // se estaba transcribiendo en vivo termina antes de leer el historial: si no,
  // su texto se pisaría con «pendiente» y se mandaría otra vez.
  await Promise.all(medidas);
  medidas = [];
  await colaVivo;
  if (ctxDecode) { try { await ctxDecode.close(); } catch (_) {} ctxDecode = null; }

  const partes = tramos.slice();
  tramos = [];
  const id = reunionActual;
  const minutos = Math.max(1, Math.round(msGrabadosAntes / 60000));
  const bytes = partes.reduce((a, p) => a + p.blob.size, 0);
  const conSonido = partes.filter((p) => p.pico >= PICO_SILENCIO);

  // La entrada se creó al empezar; si aquello falló, se crea ahora.
  const existe = await aBg("histLeer", { id }).catch(() => null);
  if (!existe) await histCrear(entradaNueva());
  // Lo que ya se transcribió (o se dio por mudo) en vivo se queda como está.
  const hechos = ((existe && existe.tramos) || []).map((t) => (t && ["ok", "mudo"].includes(t.estado) ? t : null));
  const meta = { ...((existe && existe.meta) || {}), fichero: fechaBonita(id).fichero, minutos, audioLinea: audio.linea, audioAlerta: audio.alerta, ...(infoAltavoz ? { altavoz: infoAltavoz } : {}) };

  // Silencio: NO se manda a Gemini. Ante un audio mudo el modelo no dice "no oigo
  // nada", se inventa una reunión entera con hablantes y acuerdos que no existen.
  if (!hechos.some((t) => t && t.estado === "ok") && (!bytes || !conSonido.length)) {
    await histActualizar(id, {
      estado: "error", progreso: "", meta, tramos: [],
      transcript: `# ${t("off.sinAudioTitulo")}\n\n${t("off.sinAudioTxt")}\n\n` +
        (audio.linea ? `**${t("off.nivelesMedidos")}:** ${audio.linea}\n` : "") + audio.alerta +
        `\n${t("off.queRevisar")}\n` +
        `· ${t("off.revisarPestana")}\n` +
        `· ${t("off.revisarPresencial")}\n` +
        `· ${t("off.revisarPermiso")}\n`,
    });
    for (let i = 0; i < partes.length; i++) await olvidaAudio(id, i);
    avisar(false);
    return null;
  }

  const lista = partes.map((p, i) => hechos[i] || ({
    estado: p.pico < PICO_SILENCIO ? "mudo" : "pendiente", pico: p.pico, etiqueta: etiquetaTramo(i),
    inicioS: typeof p.inicioS === "number" ? p.inicioS : i * DURACION_TRAMO_S,
  }));
  for (let i = 0; i < lista.length; i++) if (lista[i].estado === "mudo" && !hechos[i]) await olvidaAudio(id, i);
  const r = resumenTramos(lista);
  await histActualizar(id, {
    estado: "transcribiendo", meta, tramos: lista, progreso: t("com.progresoTramos", r.total - r.pendientes, r.total),
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
  const cfgRonda = cola.length ? await leerConfig().catch(() => null) : null;
  await ponIdioma(cfgRonda); // los errores de los tramos se guardan ya escritos

  // Una clave mala o ausente no se arregla en el tramo siguiente: en cuanto
  // aparece, el resto de la ronda ni se intenta (sería gastar llamadas).
  let parar = null, borrada = false;
  const trabajador = async () => {
    while (cola.length && !borrada) {
      const i = cola.shift();
      const res = parar ? { ...parar } : await transcribirTramo(id, i, total, h.tramos[i], h);
      if (!parar && res.estado === "pendiente" && CODIGOS_CLAVE.includes(res.codigo)) {
        parar = { estado: "pendiente", codigo: res.codigo, error: res.error, detalle: res.detalle };
      }
      const g = await histTramo(id, i, res);
      if (g && g.borrada) { borrada = true; break; }
      // El audio se borra DESPUÉS de que el texto esté guardado: al revés, un
      // fallo entre medias perdería las dos cosas.
      if (g && g.ok && res.estado === "ok") await conservaAudio(id, i, cfgRonda);
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

async function transcribirTramo(id, i, total, tramo, reunion) {
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
    // El tramo anterior: en vivo llega ya; en una ronda, el del historial si está transcrito.
    const previo = reunion && reunion.anterior !== undefined ? reunion.anterior
      : (reunion && Array.isArray(reunion.tramos) && reunion.tramos[i - 1] && reunion.tramos[i - 1].estado === "ok" ? reunion.tramos[i - 1].texto : "");
    const r = await transcribirGemini(blob, i + 1, total, { participantes: (reunion && reunion.participantes) || "", anterior: finalDeTramo(previo) });
    if (r.sinVoz) return { estado: "mudo", pico };
    // Las marcas del modelo cuentan desde el principio del tramo: se pasan a
    // tiempo de la reunión aquí, una vez, para que el .md, el visor y los
    // subtítulos no tengan que saber nada de tramos.
    const ok = { estado: "ok", texto: ajustarTiempos(r.texto, inicioTramo(tramo, i)), truncado: !!r.truncado, pico };
    if (r.uso) ok.uso = r.uso;
    return ok;
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
  if (fin && fin.estado === "ok") await actaAutomatica(id);
  await aBg("podar"); // aplica el límite configurado en Opciones
}

// Acta automática (Opciones). Se hace aquí y no en el service worker: Chrome
// puede parar el service worker a mitad de una llamada larga, y este documento
// sigue vivo mientras haga falta. Un fallo no toca la transcripción, que ya está
// a salvo: el acta se puede pedir a mano desde la biblioteca.
async function actaAutomatica(id) {
  let cfg;
  try { cfg = await leerConfig(); } catch (_) { return; }
  if (!cfg.autoActa || typeof analizarReunion !== "function") return;
  const plantilla = cfg.autoActaPlantilla || "acta", prov = cfg.autoActaProv || "gemini";
  const h = await aBg("histLeer", { id });
  if (!h || h.estado !== "ok") return;
  if ((h.analisis || {})[claveAnalisis(plantilla, prov)]) return; // ya la tiene
  try {
    const r = await analizarReunion(h, plantilla, prov, cfg);
    await aBg("histAnalisis", { id, clave: r.clave, texto: r.texto, uso: r.uso });
  } catch (e) {
    console.warn("Escriba: el acta automática falló", e);
    await histActualizar(id, { errorActa: String((e && e.message) || e).slice(0, 300) }).catch(() => {});
  }
}

// --- prueba de 3 s de punta a punta (botón Diagnóstico) ---
async function selftest({ modo, streamId }) {
  const cfgPrueba = await aBg("cfg").catch(() => null);
  await ponIdioma(cfgPrueba);
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
      const pest = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false,
      });
      activos.push(pest);
      const s = ctx.createMediaStreamSource(pest);
      s.connect(destino);
      abreAltavoz(pest, cfgPrueba && cfgPrueba.modoAltavoz); // igual que al grabar
      sonda(t("off.fuentePestana"), s);
      fuentes.push(t("off.fuentePestana"));
    }
    try {
      const m = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activos.push(m);
      const s = ctx.createMediaStreamSource(m);
      s.connect(destino);
      sonda(t("off.fuenteMicro"), s);
      fuentes.push(t("off.fuenteMicro"));
    } catch (e) {
      fuentes.push(t("off.microNo", (e && e.name) || "error"));
    }
    if (!activos.length) return { ok: false, error: t("off.sinFuentes") };

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
    cierraAltavoz();
    ctx.close();

    const blob = new Blob(trozos, { type: "audio/webm" });
    const picoMax = sondas.reduce((a, s) => Math.max(a, s.pico), 0);
    const res = {
      ok: true, bytes: blob.size, fuentes: fuentes.join(" + "),
      niveles: sondas.map((s) => t("off.nivelPico", s.nombre, s.pico.toFixed(3))).join(" · "),
      silencio: picoMax < PICO_SILENCIO,
    };
    if (blob.size && !res.silencio) {
      try {
        const r = await transcribirGemini(blob);
        res.transcripcion = r.sinVoz ? t("off.modeloSinVoz") : r.texto;
      } catch (e) { res.errorTranscripcion = (e && e.message) || String(e); }
    }
    return res;
  } catch (e) {
    activos.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    cierraAltavoz();
    try { ctx.close(); } catch (_) {}
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// --- Gemini ---
function marcar(err, props) { return Object.assign(err, props); }

const IDIOMAS = { es: "español", en: "inglés", ca: "catalán", pt: "portugués", fr: "francés", de: "alemán", it: "italiano" };

// opciones: { participantes, idioma }  (idioma: código de IDIOMAS o "auto")
function construirPrompt(glosario, idx, total, opciones) {
  const o = opciones || {};
  const idioma = o.idioma || "es";
  const cabecera = idioma === "auto"
    ? "Transcribe íntegramente este audio de una reunión de trabajo, en el idioma o idiomas en que se hable: si se mezclan, deja cada frase en su idioma original, sin traducir."
    // «en español» a secas hacía que, ante una reunión en inglés, el modelo
    // respondiera SIN_VOZ y se perdiera el tramo entero (01/10). El idioma elegido
    // es el esperado, no un filtro: lo que se diga en otro idioma también se transcribe.
    : `Transcribe íntegramente este audio de una reunión de trabajo, que se espera en ${IDIOMAS[idioma] || "español"}. Si se habla en otro idioma, transcríbelo igualmente en el idioma en que se diga, sin traducir: nunca lo dejes fuera ni respondas SIN_VOZ por eso.`;
  const contexto = total === null
    ? `Este audio es el TRAMO ${idx} de una reunión que sigue en curso, cortada en trozos: puede empezar y acabar a mitad de conversación. Transcribe solo lo que suene, sin introducción ni despedida propias.\n`
    : total > 1
      ? `Este audio es el TRAMO ${idx} de ${total} de una misma reunión ya cortada en trozos: empieza y acaba a mitad de conversación. Transcribe solo lo que suene, sin introducción ni despedida propias.\n`
      : "";
  // La etiqueta genérica va en el idioma de la interfaz («Hablante 1» / «Speaker 1»):
  // es lo que verá el usuario. comun.js reconoce las dos.
  const h1 = etiquetaGenerica(1), h2 = etiquetaGenerica(2);
  // Los nombres solo con prueba: un nombre mal puesto es peor que «Hablante 2»,
  // porque parece un dato y nadie lo revisa.
  const nombres = o.participantes
    ? `- Asistentes de la reunión: ${o.participantes}. Usa el nombre de una persona SOLO si se presenta o alguien la llama por su nombre de forma clara; si hay la menor duda, usa "${h1}", "${h2}"… y mantén la misma etiqueta para la misma voz.\n`
    : "";
  // El modelo no oye el tramo anterior, pero con su final puede seguir la
  // conversación y no renumerar a quien ya hablaba (3.5.1).
  const previo = o.anterior
    ? `- Así terminaba el tramo anterior de esta misma reunión (solo como referencia; NO lo repitas en tu respuesta):\n«${o.anterior}»\n  Si siguen hablando las mismas personas, mantén sus mismas etiquetas.\n`
    : "";
  return `${cabecera}
${contexto}Reglas:
- Si el audio está en silencio, solo tiene ruido de fondo o no contiene ninguna voz inteligible, responde EXACTAMENTE la palabra SIN_VOZ y nada más. No inventes una reunión bajo ningún concepto.
- Transcripción literal y COMPLETA, desde el primer segundo hasta el último. No resumas, no omitas y no te detengas antes de que termine el audio.
- Cada intervención en su propia línea, empezando por la marca de tiempo [MM:SS] contada desde el principio de ESTE audio y la etiqueta del hablante: "[MM:SS] ${h1}: texto".
- Si distingues hablantes, etiquétalos como "${h1}:", "${h2}:"...
${nombres}${previo}- Marca con [inaudible] únicamente lo que de verdad no se entienda.
${glosario ? `- Vocabulario del dominio (respeta esta ortografía exacta): ${glosario}.` : ""}
Devuelve SOLO la transcripción.`;
}

// opciones: { participantes } de la reunión; el idioma sale de la configuración.
async function transcribirGemini(blob, idx = 1, total = 1, opciones) {
  const cfg = await leerConfig();
  const key = cfg.geminiKey;
  if (!key) throw marcar(new Error(t("off.faltaClave")), { codigo: "sin_clave" });
  const preferido = (cfg && cfg.geminiModel) || MODELOS_RESERVA[0];
  const modelos = [preferido, ...MODELOS_RESERVA.filter((m) => m !== preferido)];

  const { parte: parteAudio, fileName } = await prepararAudio(blob, key);
  const prompt = construirPrompt((cfg && cfg.glosario) || "", idx, total,
    { participantes: (opciones && opciones.participantes) || "", idioma: cfg.idioma || "es", anterior: (opciones && opciones.anterior) || "" });

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
    throw ultimo || new Error(t("off.noTranscrito"));
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
    throw marcar(new Error(t("off.sinConexion", (e && e.message) || e)), { reintentable: true, codigo: "red" });
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
    throw marcar(new Error(razon ? t("off.textoVacioRazon", razon) : t("off.textoVacio")),
      { reintentable: true, codigo: "otro" });
  }
  // El modelo confirma que no hay voz: se respeta, no se reintenta.
  if (/^\s*SIN_VOZ[\s.]*$/i.test(texto)) return { texto: "", sinVoz: true };
  const u = data.usageMetadata || {};
  return { texto, truncado: razon === "MAX_TOKENS", uso: { entrada: u.promptTokenCount || 0, salida: u.candidatesTokenCount || 0 } };
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
    throw marcar(new Error(t("off.sinConexionSubida", (e && e.message) || e)), { codigo: "red" });
  }
  if (!up.ok) {
    const e = new Error(t("off.subidaFallo", up.status));
    if (up.status === 401 || up.status === 403) throw marcar(e, { codigo: "clave_invalida" });
    throw marcar(e, { codigo: up.status >= 500 || up.status === 429 ? "saturado" : "otro" });
  }
  let file = (await up.json()).file;
  let n = 0;
  while (file.state === "PROCESSING" && n++ < 90) {
    await espera(2000);
    file = await (await fetch(`${BASE}/v1beta/${file.name}`, { headers: auth })).json();
  }
  if (file.state !== "ACTIVE") throw marcar(new Error(t("off.noProcesado", file.state)), { codigo: "otro" });
  return { parte: { file_data: { mime_type: mime, file_uri: file.uri } }, fileName: file.name };
}

// --- utilidades ---
function blobADataUrl(blob) {
  return new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(blob); });
}
