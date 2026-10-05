// Suite de Escriba. Sin dependencias: `node tests/run.js`.
//
// Cada caso carga el fichero real de la extensión en un contexto aislado con el
// navegador simulado de stubs.js. Los marcados REGRESIÓN cubren un fallo que
// llegó a estar en producción; si vuelven a ponerse en rojo, ha vuelto.

"use strict";

const assert = require("assert");
const { cargar, registroDe, mensajero } = require("./load");
const {
  nuevoChrome, nuevoFetch, fetchPorUrl, respuestaHttp, respGemini, nuevoAudioContext, nuevoAudioElemento, nuevoColchon, nuevosMedios, blobDe, nuevoBlob, nuevoFormData,
  nuevosAudios, espera0,
} = require("./stubs");
const comun = require("../comun.js");

// --- mini runner ------------------------------------------------------------
const casos = [];
const test = (nombre, fn) => casos.push({ nombre, fn });
let grupoActual = "";
const grupo = (n) => { grupoActual = n; casos.push({ grupo: n }); };

// --- utilidades -------------------------------------------------------------
function lectorDeFicheros() {
  return function FileReader() {
    return {
      onload: null, onerror: null, result: null,
      readAsDataURL() {
        this.result = "data:audio/webm;base64,QUJD";
        setImmediate(() => this.onload && this.onload());
      },
    };
  };
}

// Globales que necesita offscreen.js. setTimeout inmediato: si no, los backoff
// de 3/8/20 s harían que la suite tardara un minuto por caso.
function entornoOffscreen(chrome, fetch) {
  return {
    chrome, fetch,
    AudioContext: nuevoAudioContext(),
    FileReader: lectorDeFicheros(),
    Blob: nuevoBlob(),
    FormData: nuevoFormData(),
    navigator: { mediaDevices: {} },
    setTimeout: (fn) => setImmediate(fn),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
}

const entradaHist = (id, extra = {}) =>
  ({ id, fecha: "01/01/2026 10:00", titulo: "Reunión " + id, estado: "ok", transcript: "texto", analisis: {}, ...extra });

// ============================================================================
grupo("config.js — dónde se guarda cada cosa");

test("leerConfig junta lo local y lo sincronizado", async () => {
  const chrome = nuevoChrome({ local: { geminiKey: "K" }, sync: { limite: 5 } });
  global.chrome = chrome;
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  const d = await cfg.leerConfig();
  assert.strictEqual(d.geminiKey, "K");
  assert.strictEqual(d.limite, 5);
  assert.strictEqual(d.openaiModel, "gpt-4o", "los valores por defecto siguen ahí");
});

test("guardarConfig manda cada campo a su almacén: claves a local, ajustes a sync", async () => {
  const chrome = nuevoChrome();
  global.chrome = chrome;
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  await cfg.guardarConfig({ geminiKey: "SECRETO", limite: 3 });
  assert.strictEqual(chrome.storage.local._volcado().geminiKey, "SECRETO");
  assert.strictEqual(chrome.storage.sync._volcado().geminiKey, undefined,
    "una clave de API NUNCA puede acabar en storage.sync: se replica a la cuenta de Google");
  assert.strictEqual(chrome.storage.sync._volcado().limite, 3);
});

test("REGRESIÓN: migrarConfig saca de sync las claves de versiones antiguas", async () => {
  const chrome = nuevoChrome({ sync: { geminiKey: "VIEJA", openaiKey: "VIEJA2", limite: 7 } });
  global.chrome = chrome;
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  const r = await cfg.migrarConfig();
  assert.strictEqual(r.migradas, 2);
  assert.strictEqual(chrome.storage.local._volcado().geminiKey, "VIEJA");
  assert.strictEqual(chrome.storage.sync._volcado().geminiKey, undefined);
  assert.strictEqual(chrome.storage.sync._volcado().limite, 7, "los ajustes no sensibles se quedan en sync");
});

test("migrarConfig no pisa una clave ya guardada en local", async () => {
  const chrome = nuevoChrome({ local: { geminiKey: "NUEVA" }, sync: { geminiKey: "VIEJA" } });
  global.chrome = chrome;
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  await cfg.migrarConfig();
  assert.strictEqual(chrome.storage.local._volcado().geminiKey, "NUEVA");
  assert.strictEqual(chrome.storage.sync._volcado().geminiKey, undefined);
});

test("migrarConfig es idempotente", async () => {
  const chrome = nuevoChrome({ local: { geminiKey: "K" } });
  global.chrome = chrome;
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  assert.strictEqual((await cfg.migrarConfig()).migradas, 0);
  assert.strictEqual((await cfg.migrarConfig()).migradas, 0);
  assert.strictEqual(chrome.storage.local._volcado().geminiKey, "K");
});

// ============================================================================
grupo("background.js — historial y cola de escritura");

function bg(opciones = {}) {
  const chrome = nuevoChrome(opciones);
  const ctx = cargar("background.js", { chrome, fetch: async () => { throw new Error("bg no debe llamar a la red"); } });
  ctx.audios = nuevosAudios(opciones.audios || []);
  return { chrome, ctx, audios: ctx.audios, enviar: mensajero(chrome) };
}

test("cfg devuelve la configuración combinada al documento offscreen", async () => {
  const { enviar } = bg({ local: { geminiKey: "K", glosario: "Odoo" }, sync: { limite: 4 } });
  const r = await enviar({ target: "bg", cmd: "cfg" });
  assert.strictEqual(r.geminiKey, "K");
  assert.strictEqual(r.glosario, "Odoo");
  assert.strictEqual(r.limite, 4);
});

test("histCrear y histActualizar guardan lo que dicen guardar", async () => {
  const { chrome, enviar } = bg();
  await enviar({ target: "bg", cmd: "histCrear", item: entradaHist(1, { estado: "transcribiendo" }) });
  await enviar({ target: "bg", cmd: "histActualizar", id: 1, cambios: { estado: "ok", progreso: "3/3" } });
  const [h] = chrome.storage.local._volcado().historial;
  assert.strictEqual(h.estado, "ok");
  assert.strictEqual(h.progreso, "3/3");
});

test("histActualizar sobre una entrada que ya no existe avisa, no revienta", async () => {
  const { enviar } = bg();
  const r = await enviar({ target: "bg", cmd: "histActualizar", id: 999, cambios: { estado: "ok" } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /historial/i);
});

test("REGRESIÓN: un análisis cuya entrada se podó se informa en vez de perderse con un TypeError", async () => {
  const { enviar } = bg();
  const r = await enviar({ target: "bg", cmd: "histAnalisis", id: 4242, prov: "gemini", texto: "acta" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ya no está/i);
});

test("histAnalisis guarda el acta y devuelve la entrada actualizada", async () => {
  const { chrome, enviar } = bg();
  await enviar({ target: "bg", cmd: "histCrear", item: entradaHist(1) });
  const r = await enviar({ target: "bg", cmd: "histAnalisis", id: 1, prov: "claude", texto: "ACTA" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.item.analisis.claude, "ACTA");
  assert.strictEqual(chrome.storage.local._volcado().historial[0].analisis.claude, "ACTA");
});

test("REGRESIÓN: doce escrituras a la vez no se pisan entre ellas", async () => {
  // Dos trabajadores actualizando progreso + el popup guardando análisis.
  // Sin serializar, cada read-modify-write parte de una copia obsoleta y solo
  // sobrevive el último.
  const { chrome, enviar } = bg();
  await enviar({ target: "bg", cmd: "histCrear", item: entradaHist(1) });
  const campos = Array.from({ length: 12 }, (_, i) => "campo" + i);
  await Promise.all(campos.map((c) => enviar({ target: "bg", cmd: "histActualizar", id: 1, cambios: { [c]: true } })));
  const h = chrome.storage.local._volcado().historial[0];
  const perdidos = campos.filter((c) => h[c] !== true);
  assert.deepStrictEqual(perdidos, [], "se han perdido escrituras: la cola no está serializando");
});

test("el historial se recorta al tope y el sobrante se borra también del disco", async () => {
  const viejas = Array.from({ length: 100 }, (_, i) => entradaHist(1000 + i, { fileMd: 500 + i }));
  const { chrome, enviar } = bg({ local: { historial: viejas } });
  await enviar({ target: "bg", cmd: "histCrear", item: entradaHist(1, { fileMd: 9 }) });
  const hist = chrome.storage.local._volcado().historial;
  assert.strictEqual(hist.length, 100);
  assert.strictEqual(hist[0].id, 1, "la nueva va la primera");
  assert.ok(chrome._registro.borrados.includes(599), "el fichero de la entrada que se cae debe borrarse");
});

test("borrar quita entradas y ficheros; sin conAudio, el audio de respaldo se queda", async () => {
  const hist = [entradaHist(1, { fileMd: 10, filesAudio: [11, 12] }), entradaHist(2, { fileMd: 20 })];
  const { chrome, enviar } = bg({ local: { historial: hist } });
  const r = await enviar({ target: "bg", cmd: "borrar", ids: [1], conAudio: false });
  assert.strictEqual(r.entradas, 1);
  assert.deepStrictEqual(chrome._registro.borrados, [10]);
  assert.strictEqual(chrome.storage.local._volcado().historial.length, 1);
});

test("podar deja las N configuradas, y con límite 0 no borra nada", async () => {
  const hist = Array.from({ length: 6 }, (_, i) => entradaHist(i, { fileMd: 100 + i }));
  const a = bg({ local: { historial: hist.slice() }, sync: { limite: 2 } });
  await a.enviar({ target: "bg", cmd: "podar" });
  assert.strictEqual(a.chrome.storage.local._volcado().historial.length, 2);

  const b = bg({ local: { historial: hist.slice() }, sync: { limite: 0 } });
  await b.enviar({ target: "bg", cmd: "podar" });
  assert.strictEqual(b.chrome.storage.local._volcado().historial.length, 6);
  assert.deepStrictEqual(b.chrome._registro.borrados, []);
});

// ============================================================================
grupo("offscreen.js — clasificación de silencio");

function offscreen(fetchStub, cfg = { geminiKey: "K", geminiModel: "gemini-flash-latest", glosario: "" }) {
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? cfg : { ok: true });
  return cargar(["proveedores.js", "comun.js","offscreen.js"], entornoOffscreen(chrome, fetchStub));
}

// 60 s a 16 kHz con ruido de fondo y una única intervención corta.
function tramoConVozBreve(segundosVoz = 0.3) {
  const sr = 16000, n = sr * 60;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = 0.0004 * Math.sin(i / 7); // ruido de sala
  const desde = sr * 30, hasta = desde + Math.round(sr * segundosVoz);
  for (let i = desde; i < hasta; i++) m[i] = 0.3 * Math.sin(i / 3);
  return m;
}

test("REGRESIÓN: una intervención de 300 ms en un tramo de 60 s se detecta", async () => {
  // El medidor viejo leía 2048 muestras una vez por segundo: veía el 4 % del
  // audio, así que una frase corta caía entre muestras y el tramo se
  // descartaba entero sin llegar a preguntarle al modelo.
  // El pico es un rms por ventana, así que una senoide de amplitud 0,3 mide
  // 0,3/√2 ≈ 0,21. Lo que importa es que quede muy por encima del umbral de
  // silencio (0,005) y del ruido de fondo del tramo (≈0,0003).
  const ctx = offscreen(nuevoFetch([]));
  const m = await ctx.medirExacto(blobDe(tramoConVozBreve()));
  assert.ok(m.pico > 0.2, "el pico exacto debe ver la intervención, pico=" + m.pico);
  assert.ok(m.voz > 0, "y contar alguna ventana con voz");
});

test("una intervención de 40 ms, más corta que una ventana del medidor viejo, también se ve", async () => {
  const ctx = offscreen(nuevoFetch([]));
  const m = await ctx.medirExacto(blobDe(tramoConVozBreve(0.04)));
  assert.ok(m.pico > 0.2, "pico=" + m.pico);
  assert.ok(m.voz > 0);
});

test("el silencio de verdad sigue clasificándose como silencio", async () => {
  const ctx = offscreen(nuevoFetch([]));
  const mudo = new Float32Array(16000 * 60).fill(0.0001);
  const m = await ctx.medirExacto(blobDe(mudo));
  assert.ok(m.pico < 0.005, "pico=" + m.pico);
  assert.strictEqual(m.voz, 0);
});

// ============================================================================
grupo("offscreen.js — lo que suena por los altavoces mientras se graba");

// Documento offscreen listo para grabar de verdad: getUserMedia, MediaRecorder y
// <audio> simulados. `fallaPlay` imita un Chrome que no deja sonar el <audio>.
function grabador({ fallaPlay = false, modoAltavoz } = {}) {
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? { geminiKey: "K", ...(modoAltavoz ? { modoAltavoz } : {}) } : { ok: true });
  const medios = nuevosMedios();
  const entorno = {
    ...entornoOffscreen(chrome, nuevoFetch([])),
    navigator: { mediaDevices: medios.mediaDevices },
    MediaRecorder: medios.MediaRecorder,
    Audio: nuevoAudioElemento({ falla: fallaPlay }),
  };
  return { ctx: cargar(["proveedores.js", "comun.js","offscreen.js"], entorno), entorno };
}
const vaAAltavoces = (ac) => ac._fuentes.some((f) => f._destinos.includes(ac.destination));

test("REGRESIÓN 24/09: la pestaña vuelve a los altavoces por un <audio>, no por el AudioContext", async () => {
  // Por el AudioContext la reunión se oía con microcortes y chasquidos.
  const { ctx, entorno } = grabador();
  await ctx.start({ modo: "tab_mic", streamId: "s1", tabTitle: "Infomaniak Meet" });
  const ac = entorno.AudioContext._instancias[0];
  const [el] = entorno.Audio._creados;
  assert.ok(el, "tiene que crearse un <audio>");
  assert.strictEqual(el.paused, false, "y estar sonando");
  assert.strictEqual(el.srcObject._c.audio.mandatory.chromeMediaSource, "tab", "con el sonido de la pestaña");
  assert.ok(!vaAAltavoces(ac), "el AudioContext no puede ir a los altavoces: por ahí salían los chasquidos");
});

test("al parar la grabación el <audio> se suelta", async () => {
  const { ctx, entorno } = grabador();
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  const [el] = entorno.Audio._creados;
  ctx.stop();
  await hasta(() => el.paused && el.srcObject === null, "que se soltara el <audio>");
});

test("si Chrome no deja sonar el <audio>, la pestaña se oye por un motor de audio APARTE, con colchón", async () => {
  const { ctx, entorno } = grabador({ fallaPlay: true });
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  await hasta(() => entorno.AudioContext._instancias.length === 2, "el contexto de salida");
  const [grab, salida] = entorno.AudioContext._instancias;
  await hasta(() => vaAAltavoces(salida), "que la reunión se oyera por el motor de audio");
  assert.ok(!vaAAltavoces(grab), "el contexto de la grabación no va a los altavoces");
  assert.strictEqual(salida._opciones.latencyHint, "playback",
    "con el valor por defecto trabaja en bloques de ~10 ms y cualquier tirón suena");
  assert.strictEqual(ctx.altavozActual().modo, "contexto");
});

// ---------------------------------------------------------------------------- 3.5.1
test("cambiar la forma de devolver el sonido en vivo: del <audio> al motor y vuelta", async () => {
  const { ctx, entorno } = grabador();
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  const [el1] = entorno.Audio._creados;
  assert.strictEqual(await ctx.cambiaAltavoz(), "contexto");
  assert.ok(el1.paused && el1.srcObject === null, "el <audio> se suelta");
  const salida = entorno.AudioContext._instancias[1];
  assert.ok(vaAAltavoces(salida), "suena por el motor");
  assert.strictEqual(await ctx.cambiaAltavoz(), "audio");
  assert.strictEqual(salida.state, "closed", "el motor se cierra");
  const el2 = entorno.Audio._creados[1];
  assert.ok(el2 && !el2.paused && el2.srcObject, "un <audio> nuevo, sonando");
});

test("si cambia el dispositivo de salida (se desconecta el monitor…), el sonido se rehace en el nuevo", async () => {
  const { ctx, entorno } = grabador();
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  const [el1] = entorno.Audio._creados;
  entorno.navigator.mediaDevices._dispara("devicechange");
  await hasta(() => entorno.Audio._creados.length === 2, "un <audio> nuevo");
  assert.ok(el1.srcObject === null, "el viejo se suelta");
  assert.strictEqual(entorno.Audio._creados[1].paused, false);
  assert.strictEqual(ctx.altavozActual().modo, "audio", "en la misma forma");
});

test("vigía: un <audio> que deja de avanzar se reinicia, y tras tres reinicios pasa al motor (en automático)", async () => {
  const { ctx, entorno } = grabador();
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  // Sano: el tiempo avanza → no se toca.
  for (let i = 1; i <= 3; i++) { entorno.Audio._creados[0].currentTime = i; await ctx.vigilaAltavoz(); }
  assert.strictEqual(entorno.Audio._creados.length, 1, "un <audio> que avanza no se reinicia");
  // Atascado: dos vueltas sin avanzar → reinicio. Tres reinicios → motor.
  for (let r = 0; r < 3; r++) { await ctx.vigilaAltavoz(); await ctx.vigilaAltavoz(); }
  assert.strictEqual(ctx.altavozActual().modo, "contexto");
  assert.strictEqual(ctx.altavozActual().reinicios, 3);
});

test("el service worker pasa «¿No oyes la reunión?» al grabador y recuerda la forma elegida", async () => {
  const { chrome, enviar } = bg();
  chrome._registro.offscreen = 1;
  const pedidos = [];
  chrome.runtime.sendMessage = async (m) => { pedidos.push(m); return m.target === "offscreen" ? { ok: true, modo: "contexto" } : { ok: true }; };
  const r = await enviar({ target: "bg", cmd: "altavoz", accion: "cambiar" });
  assert.deepStrictEqual({ ...r }, { ok: true, modo: "contexto" });
  assert.deepStrictEqual(pedidos.map((m) => [m.target, m.cmd, m.accion]), [["offscreen", "altavoz", "cambiar"]]);
  assert.strictEqual(chrome.storage.sync._volcado().modoAltavoz, "contexto", "la próxima grabación empieza así");
  const sinGrabar = bg();
  assert.deepStrictEqual({ ...(await sinGrabar.enviar({ target: "bg", cmd: "altavoz", accion: "cambiar" })) }, { ok: false, modo: null });
});

test("con la forma fijada en Opciones, el vigía reinicia pero no la cambia", async () => {
  const { ctx } = grabador({ modoAltavoz: "audio" });
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  for (let r = 0; r < 5; r++) { await ctx.vigilaAltavoz(); await ctx.vigilaAltavoz(); }
  assert.strictEqual(ctx.altavozActual().modo, "audio");
});

test("«motor de audio» elegido en Opciones se usa desde el principio, y al parar se cierra", async () => {
  const { ctx, entorno } = grabador({ modoAltavoz: "contexto" });
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  assert.strictEqual(entorno.Audio._creados.length, 0);
  const salida = entorno.AudioContext._instancias[1];
  assert.ok(vaAAltavoces(salida));
  ctx.stop();
  await hasta(() => salida.state === "closed", "que se cerrara el motor");
});

test("la orden «altavoz» del popup cambia la forma y dice cuál queda; sin grabación, no hace nada", async () => {
  const { ctx, entorno } = grabador();
  const enviar = mensajero(entorno.chrome);
  assert.deepStrictEqual({ ...(await enviar({ target: "offscreen", cmd: "altavoz", accion: "cambiar" })) }, { ok: false, modo: null });
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  assert.deepStrictEqual({ ...(await enviar({ target: "offscreen", cmd: "altavoz", accion: "cambiar" })) }, { ok: true, modo: "contexto" });
  assert.deepStrictEqual({ ...(await enviar({ target: "offscreen", cmd: "altavoz", accion: "estado" })) }, { ok: true, modo: "contexto" });
});

test("«Solo micro» no devuelve nada a los altavoces: haría eco", async () => {
  const { ctx, entorno } = grabador();
  await ctx.start({ modo: "mic", streamId: "" });
  const ac = entorno.AudioContext._instancias[0];
  assert.strictEqual(entorno.Audio._creados.length, 0, "no debe crear <audio>");
  assert.ok(!vaAAltavoces(ac), "nada al AudioContext de los altavoces");
});

test("el Diagnóstico también devuelve la pestaña por un <audio> y lo suelta al acabar", async () => {
  const { ctx, entorno } = grabador();
  const r = await ctx.selftest({ modo: "tab_mic", streamId: "s1" });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const ac = entorno.AudioContext._instancias[0];
  const [el] = entorno.Audio._creados;
  assert.ok(el, "tiene que crearse un <audio>");
  assert.ok(!vaAAltavoces(ac));
  assert.ok(el.paused && el.srcObject === null, "al acabar la prueba se suelta");
});

// ---------------------------------------------------------------------------- 3.7.0
// Con el portátil en batería Chrome pierde trozos de la captura, y sus dos
// reproductores de audio en directo lo convierten en microcortes (medido el
// 03/10). El altavoz con colchón no pasa por ninguno de los dos.
function grabadorConColchon({ fallaModulo = false, modoAltavoz } = {}) {
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? { geminiKey: "K", ...(modoAltavoz ? { modoAltavoz } : {}) } : { ok: true });
  const medios = nuevosMedios();
  const colchon = nuevoColchon();
  const entorno = {
    ...entornoOffscreen(chrome, nuevoFetch([])),
    AudioContext: nuevoAudioContext({ fallaModulo }),
    navigator: { mediaDevices: medios.mediaDevices },
    MediaRecorder: medios.MediaRecorder,
    Audio: nuevoAudioElemento(),
    MediaStreamTrackProcessor: colchon.MediaStreamTrackProcessor, Worker: colchon.Worker,
    AudioWorkletNode: colchon.AudioWorkletNode, MessageChannel: colchon.MessageChannel,
  };
  return { ctx: cargar(["proveedores.js", "comun.js","offscreen.js"], entorno), entorno, piezas: colchon._reg };
}

test("REGRESIÓN 03/10: en automático la pestaña suena por el reproductor con colchón, no por los de Chrome", async () => {
  const { ctx, entorno, piezas } = grabadorConColchon();
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  await hasta(() => piezas.hilos.length === 1, "que arrancara la bomba");
  assert.strictEqual(ctx.altavozActual().modo, "colchon");
  assert.strictEqual(entorno.Audio._creados.length, 0, "sin <audio>: con la captura a trompicones tira muestras y mete huecos");
  const [grab, salida] = entorno.AudioContext._instancias;
  assert.ok(!vaAAltavoces(grab) && !vaAAltavoces(salida), "la pista no va directa a ningún AudioContext: ahí suena sin reserva");
  assert.strictEqual(salida._opciones.sampleRate, 48000, "al ritmo de la captura: sin remuestrear de más");
  assert.deepStrictEqual([...salida._modulos], ["altavoz-colchon.js"]);
  const [nodo] = piezas.nodos;
  assert.ok(nodo._destinos.includes(salida.destination), "el reproductor propio sí va a los altavoces");
  assert.strictEqual(nodo.opciones.processorOptions.colchonMs, 60);
  const [hilo] = piezas.hilos, [proc] = piezas.procesadores;
  assert.strictEqual(hilo.url, "altavoz-bomba.js");
  assert.strictEqual(hilo.mensajes[0].audio, proc.readable, "el audio va de la captura al hilo, sin pasar por el documento que graba");
  assert.strictEqual(proc.track._copiaDe, ctx.altavozActual().stream.getAudioTracks()[0], "se lee una copia de la pista: la grabación no se entera");
  assert.ok(nodo.port.mensajes[0].entrada && hilo.mensajes[0].salida, "y del hilo al sonido por un canal directo");
});

test("al parar, el reproductor con colchón se desmonta entero", async () => {
  const { ctx, entorno, piezas } = grabadorConColchon();
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  await hasta(() => piezas.hilos.length === 1, "que arrancara la bomba");
  const salida = entorno.AudioContext._instancias[1];
  ctx.stop();
  await hasta(() => piezas.hilos[0].terminado && piezas.procesadores[0].track.parada && salida.state === "closed", "que se soltaran el hilo, la copia y el motor");
});

test("si el reproductor con colchón no arranca, la pestaña suena por el <audio>: nunca se queda muda", async () => {
  const { ctx, entorno, piezas } = grabadorConColchon({ fallaModulo: true });
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  await hasta(() => entorno.Audio._creados.length === 1, "el <audio> de reserva");
  assert.strictEqual(ctx.altavozActual().modo, "audio");
  assert.strictEqual(entorno.Audio._creados[0].paused, false);
  assert.strictEqual(piezas.hilos.length, 0);
  assert.strictEqual(entorno.AudioContext._instancias[1].state, "closed", "el motor a medio montar se cierra");
});

test("«¿No oyes la reunión?» recorre las tres formas: colchón, <audio>, motor y vuelta", async () => {
  const { ctx, piezas } = grabadorConColchon();
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  await hasta(() => piezas.hilos.length === 1, "que arrancara la bomba");
  assert.strictEqual(await ctx.cambiaAltavoz(), "audio");
  assert.ok(piezas.hilos[0].terminado, "la bomba se para al cambiar");
  assert.strictEqual(await ctx.cambiaAltavoz(), "contexto");
  assert.strictEqual(await ctx.cambiaAltavoz(), "colchon");
  await hasta(() => piezas.hilos.length === 2, "una bomba nueva");
});

test("con «Reproductor de Chrome» fijado en Opciones no se usa el colchón", async () => {
  const { ctx, entorno, piezas } = grabadorConColchon({ modoAltavoz: "audio" });
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  assert.strictEqual(ctx.altavozActual().modo, "audio");
  assert.strictEqual(entorno.Audio._creados.length, 1);
  assert.strictEqual(piezas.hilos.length, 0);
});

// --- «Pestaña + micro» sin silenciar (3.7.0) ---
// Tapar los cortes no bastó: con batería Chrome llega a perder tres trozos por
// segundo y el relleno se oye. La forma principal pide la captura con la ventana
// de Chrome de «elegir qué compartir», que no silencia nada: lo que se oye es el
// sonido original, en cualquier equipo. La rápida queda como alternativa.
test("REGRESIÓN 03/10: «Pestaña + micro» pide a Chrome la captura sin silenciar y no devuelve nada a los altavoces", async () => {
  const s = sistemaGrabando();
  let pedidasRapidas = 0;
  s.chrome.tabCapture.getMediaStreamId = async () => { pedidasRapidas++; return "x"; };
  const r = await s.enviar({ target: "bg", cmd: "start", modo: "orig_mic", participantes: "" });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(pedidasRapidas, 0, "la captura rápida (la que silencia) no se toca");
  const [cap] = s.medios.mediaDevices._compartidos;
  assert.strictEqual(cap._c.audio.suppressLocalAudioPlayback, false, "Chrome no debe silenciar lo que se graba");
  assert.deepStrictEqual([cap._c.audio.echoCancellation, cap._c.audio.noiseSuppression, cap._c.audio.autoGainControl], [false, false, false],
    "el sonido de la reunión, sin los filtros de micro que Chrome pone por defecto");
  assert.strictEqual(cap._c.systemAudio, "include", "con «toda la pantalla» puede venir el sonido del equipo");
  assert.ok(cap.getVideoTracks()[0].parada, "la imagen no se usa: se suelta");
  assert.ok(!cap.getAudioTracks()[0].parada, "el sonido sigue");
  assert.strictEqual(s.off.altavozActual(), null, "nada que devolver: la pestaña suena por sí sola");
  assert.strictEqual(s.entorno.Audio._creados.length, 0);
  assert.strictEqual(s.entorno.AudioContext._instancias.length, 1, "solo el contexto de la grabación");
  const ses = s.chrome.storage.session._volcado();
  assert.strictEqual(ses.grabando, true);
  assert.strictEqual(ses.ultimoModo, "orig_mic");
  assert.ok(s.chrome._registro.badges.includes("REC"));
});

test("«Pestaña + micro»: de título, la pestaña que había delante; si se comparte toda la pantalla, «Pantalla compartida»", async () => {
  const s = sistemaGrabando();
  s.chrome.tabs.query = async () => [{ id: 3, title: "Reunión de equipo - Meet" }];
  await s.enviar({ target: "bg", cmd: "start", modo: "orig_mic" });
  assert.strictEqual(s.historial()[0].titulo, "Reunión de equipo - Meet");
  assert.strictEqual(s.chrome.storage.session._volcado().tabTitle, "Reunión de equipo - Meet");
  const p = sistemaGrabando({ compartir: "pantalla" });
  p.chrome.tabs.query = async () => [{ id: 3, title: "Correo" }];
  await p.enviar({ target: "bg", cmd: "start", modo: "orig_mic" });
  assert.strictEqual(p.historial()[0].titulo, "Pantalla compartida", "el título de la pestaña de delante engañaría");
  assert.strictEqual(p.chrome.storage.session._volcado().tabTitle, "Pantalla compartida");
});

test("cancelar en la ventana de Chrome no graba ni avisa; elegir algo sin sonido lo dice, porque el popup ya está cerrado", async () => {
  const c = sistemaGrabando({ compartir: "cancela" });
  const r = await c.enviar({ target: "bg", cmd: "start", modo: "orig_mic" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.cancelado, true);
  assert.ok(!c.chrome.storage.session._volcado().grabando);
  assert.strictEqual(c.chrome._registro.notificaciones.length, 0, "cancelar es cosa del usuario: sin aviso");
  assert.strictEqual(c.historial().length, 0);
  assert.strictEqual(c.entorno.AudioContext._instancias.length, 0, "no se monta nada antes de saber qué se graba");

  const v = sistemaGrabando({ compartir: "ventana" });
  const rv = await v.enviar({ target: "bg", cmd: "start", modo: "orig_mic" });
  assert.strictEqual(rv.ok, false);
  assert.ok(/no trae sonido/.test(rv.error), rv.error);
  assert.ok(!v.chrome.storage.session._volcado().grabando);
  assert.deepStrictEqual(v.chrome._registro.notificaciones.map((n) => [n.id, n.message]), [["escriba-captura", rv.error]]);
  assert.ok(v.medios.mediaDevices._compartidos[0].getTracks().every((p) => p.parada), "lo compartido se suelta: Chrome quita su barra");
  assert.strictEqual(v.historial().length, 0);
});

test("«Dejar de compartir» en la barra de Chrome cierra la grabación como el botón de parar", async () => {
  const s = sistemaGrabando({ fetch: fetchPorTramo({ 1: [respGemini("hola")] }) });
  await s.enviar({ target: "bg", cmd: "start", modo: "orig_mic" });
  s.medios.mediaDevices._compartidos[0].getAudioTracks()[0]._dispara("ended");
  await hasta(() => s.chrome.storage.session._volcado().grabando === false, "que la grabación se cerrara");
  await hasta(() => s.historial()[0] && s.historial()[0].estado === "ok", "y que se transcribiera lo grabado");
});

test("el atajo de teclado graba con la forma elegida en el popup; de fábrica, «Pestaña + micro»", async () => {
  const s = sistemaGrabando();
  s.chrome._oyentes.comando.forEach((f) => f("grabar"));
  await hasta(() => s.chrome.storage.session._volcado().grabando === true, "que empezara a grabar");
  assert.strictEqual(s.chrome.storage.session._volcado().ultimoModo, "orig_mic");
  assert.strictEqual(s.medios.mediaDevices._compartidos.length, 1);
  const m = sistemaGrabando({ sync: { modoGrabar: "mic" } });
  m.chrome._oyentes.comando.forEach((f) => f("grabar"));
  await hasta(() => m.chrome.storage.session._volcado().grabando === true, "que empezara a grabar");
  assert.strictEqual(m.chrome.storage.session._volcado().ultimoModo, "mic");
  assert.strictEqual(m.medios.mediaDevices._compartidos.length, 0);
});

test("mientras Chrome espera a que se elija qué compartir, una segunda orden de grabar no abre otra ventana", async () => {
  const s = sistemaGrabando();
  let suelta;
  const original = s.medios.mediaDevices.getDisplayMedia;
  s.medios.mediaDevices.getDisplayMedia = (c) => new Promise((ok) => { suelta = () => ok(original(c)); });
  const primera = s.off.start({ modo: "orig_mic" });
  await espera0();
  await assert.rejects(s.off.start({ modo: "orig_mic" }), /ya está esperando/);
  suelta();
  await primera;
  assert.strictEqual(s.medios.mediaDevices._compartidos.length, 1);
});

// --- el reproductor (AudioWorklet) y la bomba (Worker), con audio de verdad ---
function cargaColchon(opciones = {}, hzSalida = 48000) {
  const registro = {}, mensajes = [];
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage: (m) => mensajes.push(m) }; } }
  cargar("altavoz-colchon.js", { sampleRate: hzSalida, AudioWorkletProcessor, registerProcessor: (n, c) => { registro[n] = c; } });
  const p = new registro["escriba-altavoz"]({ processorOptions: { hzEntrada: 48000, colchonMs: 80, ...opciones } });
  const mete = (l) => p.port.onmessage({ data: { l, r: null } });
  const saca = () => { const L = new Float32Array(128), R = new Float32Array(128); p.process([], [[L, R]]); return L; };
  return { p, mete, saca, mensajes };
}
const tono = (hz, desde, n) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * (desde + i) / 48000));

test("colchón: calla hasta tener la reserva y luego devuelve lo que entró, muestra a muestra", () => {
  const { mete, saca } = cargaColchon();
  const salida = [];
  for (let b = 0; b < 300; b++) { mete(tono(1000, b * 128, 128)); salida.push(...saca()); }
  const reserva = 0.08 * 48000;
  assert.ok(salida.slice(0, reserva - 128).every((v) => v === 0), "silencio mientras se llena la reserva (80 ms)");
  const esperado = tono(1000, 0, salida.length - (reserva - 128));
  const sonado = salida.slice(reserva - 128);
  assert.ok(Math.abs(sonado[12]) < Math.abs(esperado[12]) * 0.1, "entra subiendo: arrancar a media onda sería un chasquido");
  let peor = 0;
  for (let i = 256; i < esperado.length; i++) peor = Math.max(peor, Math.abs(sonado[i] - esperado[i]));
  assert.ok(peor < 1e-5, `pasados los 5 ms de entrada, con los dos relojes iguales el sonido sale intacto (peor diferencia ${peor})`);
});

test("colchón: si la captura va algo más rápida o más lenta que la tarjeta, estira o encoge sin cortar", () => {
  for (const ritmo of [1.002, 0.998]) {
    const { p, mete, saca } = cargaColchon();
    let entrado = 0, debe = 0, peorBrinco = 0, previo = null;
    for (let b = 0; b < 15000; b++) {             // 40 s
      debe += 128 * ritmo;
      const n = Math.floor(debe - entrado);
      mete(tono(440, entrado, n));
      entrado += n;
      for (const v of saca()) { if (previo !== null) peorBrinco = Math.max(peorBrinco, Math.abs(v - previo)); previo = v; }
    }
    assert.strictEqual(p.vacios, 0, `ritmo ${ritmo}: ni un hueco`);
    assert.strictEqual(p.tirados, 0, `ritmo ${ritmo}: ni un salto`);
    // Un tono de 440 Hz a media escala cambia como mucho 0,029 entre dos muestras.
    assert.ok(peorBrinco < 0.04, `ritmo ${ritmo}: la onda sale continua (mayor brinco ${peorBrinco.toFixed(4)})`);
    const reservaMs = (p.w - p.r) / 48;
    assert.ok(reservaMs > 5 && reservaMs < 300, `ritmo ${ritmo}: la reserva se queda en su sitio (${reservaMs.toFixed(0)} ms)`);
  }
});

test("colchón: con la tarjeta a otro ritmo que la captura (44,1 o 96 kHz) el tono sale afinado, al mismo volumen y sin cortes", () => {
  for (const hzSalida of [44100, 96000]) {
    const { p, mete, saca } = cargaColchon({}, hzSalida);
    const salida = [];
    let entrado = 0, debe = 0;
    for (let b = 0; b < 3000; b++) {
      debe += 128 * 48000 / hzSalida;               // la captura sigue llegando a 48 kHz
      const n = Math.floor(debe - entrado);
      mete(tono(1000, entrado, n));
      entrado += n;
      salida.push(...saca());
    }
    assert.strictEqual(p.vacios, 0, `${hzSalida} Hz: ni un hueco`);
    assert.strictEqual(p.tirados, 0, `${hzSalida} Hz: ni un salto`);
    // La última décima de segundo se ajusta a un seno de 1000 Hz al ritmo de la
    // tarjeta (amplitud y fase libres): lo que no encaje es distorsión o desafine.
    const n = Math.round(hzSalida / 10), desde = salida.length - n, k = 2 * Math.PI * 1000 / hzSalida;
    let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.sin(k * i), c = Math.cos(k * i), y = salida[desde + i];
      ss += s * s; cc += c * c; sc += s * c; ys += y * s; yc += y * c;
    }
    const det = ss * cc - sc * sc, a = (ys * cc - yc * sc) / det, b = (yc * ss - ys * sc) / det;
    let resto = 0;
    for (let i = 0; i < n; i++) resto = Math.max(resto, Math.abs(salida[desde + i] - a * Math.sin(k * i) - b * Math.cos(k * i)));
    assert.ok(Math.abs(Math.hypot(a, b) - 0.5) < 0.005, `${hzSalida} Hz: mismo volumen (${Math.hypot(a, b).toFixed(4)} frente a 0,5)`);
    assert.ok(resto < 0.005, `${hzSalida} Hz: sigue siendo un tono limpio de 1000 Hz (lo que sobra: ${resto.toFixed(4)})`);
  }
});

test("colchón: si se queda sin audio pone silencio y espera a tener reserva otra vez; un atracón lo salta", () => {
  const { p, mete, saca } = cargaColchon();
  for (let b = 0; b < 40; b++) { mete(tono(440, b * 128, 128)); saca(); }
  for (let b = 0; b < 40; b++) saca();            // deja de llegar audio
  assert.strictEqual(p.vacios, 1, "un hueco, no uno por cada bloque");
  assert.ok(saca().every((v) => v === 0), "silencio, no ruido");
  mete(tono(440, 0, 1000));
  assert.ok(saca().every((v) => v === 0), "con 20 ms no arranca: volvería a quedarse sin audio enseguida");
  mete(tono(440, 1000, 4000));
  assert.ok(saca().some((v) => v !== 0), "con la reserva llena vuelve a sonar");
  mete(tono(440, 5000, 48000));                   // un segundo de golpe tras un parón
  assert.strictEqual(p.tirados, 1);
  assert.ok(Math.abs((p.w - p.r) - 0.08 * 48000) < 1, "se pone al día en vez de ir un segundo por detrás");
});

function cargaBomba() {
  const avisos = [];
  const ctx = cargar("altavoz-bomba.js", { postMessage: (m) => avisos.push(m) });
  return async (trozos) => {
    const sal = [];
    let i = 0;
    const audio = { getReader: () => ({ read: async () => (i < trozos.length ? { value: trozos[i++], done: false } : { done: true }) }) };
    await ctx.onmessage({ data: { audio, salida: { postMessage: (m) => sal.push(...m.l) } } });
    return { muestras: sal, avisos };
  };
}
// Trozos como los que entrega Chrome: 441 muestras a 48 kHz, cada uno con su hora (µs).
function enTrozos(muestras, saltos = {}) {
  const dura = Math.round(441 / 48000 * 1e6), trozos = [];
  let hora = 5e6;
  for (let p = 0, j = 0; p + 441 <= muestras.length; p += 441, j++) {
    hora += saltos[j] || 0;
    const datos = muestras.subarray(p, p + 441);
    trozos.push({ numberOfFrames: 441, sampleRate: 48000, numberOfChannels: 1, timestamp: hora, duration: dura, copyTo: (d) => d.set(datos), close() {} });
    hora += dura;
  }
  return trozos;
}
// Sonido periódico con armónicos (ciclo de 240 muestras), como una vocal sostenida.
const vocal = (n) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(2 * Math.PI * i / 240) + 0.15 * Math.sin(6 * Math.PI * i / 240 + 1));

test("bomba: sin pérdidas, a los altavoces llega exactamente lo capturado", async () => {
  const x = vocal(441 * 60);
  const { muestras, avisos } = await cargaBomba()(enTrozos(x));
  assert.strictEqual(muestras.length, x.length);
  assert.ok(muestras.every((v, i) => v === x[i]), "ni una muestra cambiada");
  assert.strictEqual(avisos.length, 0);
});

test("REGRESIÓN 03/10 (batería): el trozo que Chrome pierde se rellena y el sonido sigue donde debía, sin chasquido", async () => {
  // Como se midió: la hora salta 9,2 ms en un trozo y el corte de verdad cae unos
  // milisegundos dentro de ese trozo (aquí, 100 muestras).
  const ideal = vocal(441 * 60), corte = 441 * 30 + 100;
  const recibido = new Float32Array(ideal.length - 441);
  recibido.set(ideal.subarray(0, corte));
  recibido.set(ideal.subarray(corte + 441), corte);
  const { muestras, avisos } = await cargaBomba()(enTrozos(recibido, { 30: 9213 }));
  assert.strictEqual(avisos.length, 1, "un remiendo");
  assert.strictEqual(muestras.length, recibido.length + 441, "se repone justo lo que faltaba: lo que suena no se adelanta");
  let peor = 0, peorBrinco = 0;
  for (let i = 0; i < muestras.length; i++) {
    peor = Math.max(peor, Math.abs(muestras[i] - ideal[i]));
    if (i) peorBrinco = Math.max(peorBrinco, Math.abs(muestras[i] - muestras[i - 1]));
  }
  assert.ok(peor < 0.01, `el relleno coincide con lo que se perdió (peor diferencia ${peor.toFixed(4)})`);
  assert.ok(peorBrinco < 0.03, `sin escalones: el mayor brinco entre muestras (${peorBrinco.toFixed(4)}) es el de la propia onda`);
  // Sin remendar, pegar los dos lados deja un escalón.
  let sinRemendar = 0;
  for (let i = corte - 2; i < corte + 2; i++) sinRemendar = Math.max(sinRemendar, Math.abs(recibido[i] - recibido[i - 1]));
  assert.ok(sinRemendar > 0.2, "la prueba tiene que tener un corte que se oiga");
});

test("bomba: la holgura de las horas no se remienda, y un parón largo tampoco", async () => {
  const x = vocal(441 * 60);
  const holgura = await cargaBomba()(enTrozos(x, { 20: 900, 40: -700 }));
  assert.strictEqual(holgura.avisos.length, 0);
  assert.ok(holgura.muestras.every((v, i) => v === x[i]));
  const paron = await cargaBomba()(enTrozos(x, { 30: 2000000 }));
  assert.strictEqual(paron.avisos.length, 0, "dos segundos sin audio no se inventan");
  assert.strictEqual(paron.muestras.length, x.length);
});

// ============================================================================
grupo("offscreen.js — reintentos, cascada y limpieza");

test("un 503 se reintenta y el tramo acaba transcrito", async () => {
  const f = nuevoFetch([
    { status: 503, cuerpo: '{"error":{"retryDelay":"1s"}}' },
    respGemini("Hola, esto es la reunión."),
  ]);
  const ctx = offscreen(f);
  const r = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1);
  assert.strictEqual(r.texto, "Hola, esto es la reunión.");
  assert.strictEqual(f._llamadas.length, 2);
});

test("REGRESIÓN: una clave inválida es fatal — ni se reintenta ni se prueban modelos de reserva", async () => {
  const f = nuevoFetch([{ status: 401, cuerpo: '{"error":{"message":"API key not valid"}}' }]);
  const ctx = offscreen(f);
  await assert.rejects(() => ctx.transcribirGemini(blobDe(null, 1000), 1, 1), /401/);
  assert.strictEqual(f._llamadas.length, 1, "una clave mala no se arregla cambiando de modelo");
});

test("si el modelo elegido no existe se pasa al siguiente de la cascada", async () => {
  const f = nuevoFetch([
    { status: 404, cuerpo: "modelo no encontrado" },
    respGemini("transcrito con el de reserva"),
  ]);
  const ctx = offscreen(f);
  const r = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1);
  assert.strictEqual(r.texto, "transcrito con el de reserva");
  assert.notStrictEqual(f._llamadas[0].url, f._llamadas[1].url, "debe cambiar de modelo, no repetir");
});

test("SIN_VOZ se respeta: no se reintenta ni se inventa texto", async () => {
  const f = nuevoFetch([respGemini("SIN_VOZ")]);
  const ctx = offscreen(f);
  const r = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1);
  assert.strictEqual(r.sinVoz, true);
  assert.strictEqual(r.texto, "");
  assert.strictEqual(f._llamadas.length, 1);
});

test("un tramo cortado por longitud se marca como truncado", async () => {
  const f = nuevoFetch([respGemini("mitad de la frase", "MAX_TOKENS")]);
  const ctx = offscreen(f);
  const r = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1);
  assert.strictEqual(r.truncado, true);
});

test("REGRESIÓN: el audio subido por Files API se borra al terminar", async () => {
  const grande = 7 * 1048576;
  const f = nuevoFetch([
    { cuerpo: { file: { name: "files/abc123", uri: "https://x/files/abc123", state: "ACTIVE" } } },
    respGemini("transcripción del audio grande"),
    { cuerpo: {} }, // DELETE
  ]);
  const ctx = offscreen(f);
  const r = await ctx.transcribirGemini(blobDe(null, grande), 1, 1);
  assert.strictEqual(r.texto, "transcripción del audio grande");
  const borrado = f._llamadas.find((l) => l.metodo === "DELETE");
  assert.ok(borrado, "debe borrarse el fichero remoto");
  assert.match(borrado.url, /files\/abc123$/);
});

test("el prompt avisa al modelo de que el audio es un tramo suelto", async () => {
  const f = nuevoFetch([respGemini("texto")]);
  const ctx = offscreen(f);
  await ctx.transcribirGemini(blobDe(null, 1000), 3, 12);
  const cuerpo = JSON.parse(f._llamadas[0].opts.body);
  const prompt = cuerpo.contents[0].parts[0].text;
  assert.match(prompt, /TRAMO 3 de 12/);
  assert.match(prompt, /SIN_VOZ/, "el contrato anti-alucinación tiene que ir en todos los tramos");
});

test("el glosario configurado llega al prompt", async () => {
  const f = nuevoFetch([respGemini("texto")]);
  const ctx = offscreen(f, { geminiKey: "K", geminiModel: "gemini-flash-latest", glosario: "Odoo, SegElevia" });
  await ctx.transcribirGemini(blobDe(null, 1000), 1, 1);
  const prompt = JSON.parse(f._llamadas[0].opts.body).contents[0].parts[0].text;
  assert.match(prompt, /Odoo, SegElevia/);
});

test("sin clave configurada se avisa antes de tocar la red", async () => {
  const f = nuevoFetch([]);
  const ctx = offscreen(f, { geminiKey: "", geminiModel: "", glosario: "" });
  await assert.rejects(() => ctx.transcribirGemini(blobDe(null, 1000), 1, 1), /clave/i);
  assert.strictEqual(f._llamadas.length, 0);
});

test("REGRESIÓN 21/09: si el service worker no contesta a la primera, se reintenta en vez de decir «falta la clave»", async () => {
  // La reunión del 21/09 perdió sus tres tramos con «Falta la clave de Gemini»
  // teniendo clave: la 3.0 tomaba una respuesta vacía del service worker por
  // una configuración sin clave.
  const chrome = nuevoChrome();
  let llamadas = 0;
  chrome.runtime.sendMessage = async (msg) => {
    if (msg.cmd !== "cfg") return { ok: true };
    return ++llamadas === 1 ? undefined : { geminiKey: "K", geminiModel: "gemini-flash-latest", glosario: "" };
  };
  const f = nuevoFetch([respGemini("texto del tramo")]);
  const ctx = cargar(["proveedores.js", "comun.js","offscreen.js"], entornoOffscreen(chrome, f));
  const r = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1);
  assert.strictEqual(r.texto, "texto del tramo");
  assert.strictEqual(llamadas, 2);
});

test("si la configuración no llega nunca, el error es «interno», no «falta la clave»", async () => {
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? { ok: false, error: "reiniciando" } : { ok: true });
  const f = nuevoFetch([]);
  const ctx = cargar(["proveedores.js", "comun.js","offscreen.js"], entornoOffscreen(chrome, f));
  const e = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1).then(() => null, (x) => x);
  assert.ok(e, "tenía que fallar");
  assert.strictEqual(e.codigo, "interno");
  assert.doesNotMatch(e.message, /falta la clave/i);
  assert.strictEqual(f._llamadas.length, 0);
});

test("cada fallo de Gemini lleva su código: saturado, clave rechazada, sin red", async () => {
  const saturado = [];
  for (let i = 0; i < 12; i++) saturado.push({ status: 503, cuerpo: "{}" });
  const casos = [
    [saturado, "saturado"],
    [[{ status: 400, cuerpo: '{"error":{"message":"API key not valid"}}' }], "clave_invalida"],
    [Array.from({ length: 12 }, () => ({ lanza: "ECONNRESET" })), "red"],
  ];
  for (const [respuestas, codigo] of casos) {
    const ctx = offscreen(nuevoFetch(respuestas));
    const e = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1).then(() => null, (x) => x);
    assert.strictEqual(e && e.codigo, codigo);
  }
});

// ============================================================================
grupo("comun.js — markdown, troceado y WAV");

const tramoOk = (texto) => ({ estado: "ok", texto });
const tramoPend = (codigo) => ({ estado: "pendiente", codigo, error: comun.textoError(codigo) });

test("el estado de una reunión sale de sus tramos", () => {
  assert.strictEqual(comun.estadoFinal([tramoOk("a"), { estado: "mudo" }]), "ok");
  assert.strictEqual(comun.estadoFinal([tramoOk("a"), tramoPend("saturado")]), "pendiente");
  assert.strictEqual(comun.estadoFinal([{ estado: "mudo" }, { estado: "perdido" }]), "error");
});

test("el .md de una reunión incompleta marca el hueco y dice que se reintentará", () => {
  const md = comun.construirMarkdown({
    fecha: "21/09/2026 11:50", titulo: "Infomaniak Meet", meta: { minutos: 13 },
    tramos: [tramoOk("Hola a todos."), tramoPend("saturado"), { estado: "mudo" }],
  });
  assert.match(md, /Hola a todos\./);
  assert.match(md, /1 de 3 tramos sigue sin transcribir/);
  assert.match(md, /Tramo 2 de 3 .*pendiente/);
  assert.match(md, /saturada/);
  assert.match(md, /Tramo 3 de 3.*sin voz/);
});

test("el .md de una reunión completa no arrastra avisos de intentos anteriores", () => {
  const md = comun.construirMarkdown({ fecha: "x", titulo: "t", meta: { minutos: 10 }, tramos: [tramoOk("uno"), tramoOk("dos")] });
  assert.doesNotMatch(md, /pendiente|reintent|⚠️|⏳/);
  assert.ok(md.indexOf("uno") < md.indexOf("dos"), "en orden");
});

test("trocear: tramos de tamaño fijo y un resto corto se pega al anterior", () => {
  assert.deepStrictEqual(comun.trocear(100, 40, 10), [[0, 40], [40, 80], [80, 100]]);
  assert.deepStrictEqual(comun.trocear(85, 40, 10), [[0, 40], [40, 85]]);
  assert.deepStrictEqual(comun.trocear(5, 40, 10), [[0, 5]], "un audio corto es un solo tramo");
});

test("planificarTramos etiqueta cada tramo con su archivo cuando hay varios", () => {
  const sr = 16000, min = 60 * sr;
  const plan = comun.planificarTramos([
    { nombre: "tramo01.webm", longitud: 5 * min, sampleRate: sr },
    { nombre: "tramo02.webm", longitud: 12 * min, sampleRate: sr },
  ]);
  assert.strictEqual(plan.length, 4); // 5 min → 1; 12 min → 5 + 5 + 2
  assert.strictEqual(plan[0].etiqueta, "tramo01.webm, minuto 0 al 5");
  assert.strictEqual(plan[3].etiqueta, "tramo02.webm, minuto 10 al 12");
});

test("codificarWav produce un WAV PCM 16 bits mono válido", () => {
  const m = new Float32Array([0, 1, -1, 2, 0.5]);
  const v = new DataView(comun.codificarWav(m, 16000));
  const txt = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  assert.strictEqual(txt(0), "RIFF");
  assert.strictEqual(txt(8), "WAVE");
  assert.strictEqual(v.getUint16(22, true), 1, "mono");
  assert.strictEqual(v.getUint32(24, true), 16000);
  assert.strictEqual(v.getUint32(40, true), m.length * 2);
  assert.strictEqual(v.getInt16(44 + 2, true), 32767);
  assert.strictEqual(v.getInt16(44 + 4, true), -32768);
  assert.strictEqual(v.getInt16(44 + 6, true), 32767, "lo que se sale de rango se recorta, no da la vuelta");
});

// ============================================================================
// Sistema completo: service worker + documento offscreen hablándose, con el
// mismo almacén de audio. Es lo que pasa de verdad en Chrome.
function sistema({ local = {}, sync = {}, audios: ini = [], fetch: fetchStub = nuevoFetch([]) } = {}) {
  const chrome = nuevoChrome({ local: { geminiKey: "K", geminiModel: "gemini-flash-latest", ...local }, sync });
  const aud = nuevosAudios(ini);
  const bgCtx = cargar("background.js", { chrome, fetch: async () => { throw new Error("bg no debe llamar a la red"); } });
  bgCtx.audios = aud;
  const enviarBg = mensajero(chrome);
  const offChrome = nuevoChrome();
  offChrome.runtime.sendMessage = (msg) => enviarBg(msg);
  const off = cargar(["proveedores.js", "comun.js","ia.js", "offscreen.js"], entornoOffscreen(offChrome, fetchStub));
  off.audios = aud;
  const enviarOff = mensajero(offChrome);
  chrome.runtime.sendMessage = (msg) => (msg.target === "offscreen" ? enviarOff(msg) : enviarBg(msg));
  const historial = () => chrome.storage.local._volcado().historial || [];
  const entrada = (id) => historial().find((h) => h.id === id);
  return { chrome, bgCtx, off, audios: aud, fetch: fetchStub, enviar: enviarBg, historial, entrada };
}

// Espera a que una ronda lanzada en segundo plano termine.
async function hasta(cond, que = "la condición") {
  for (let i = 0; i < 5000; i++) {
    if (cond()) return;
    await espera0();
  }
  throw new Error("No se cumplió " + que);
}

const reunion = (id, n, extra = {}) => ({
  id, fecha: "21/09/2026 11:50", titulo: "Infomaniak Meet", origen: "grabacion", estado: "transcribiendo",
  transcript: "", analisis: {}, meta: { fichero: "2026-09-21_1150", minutos: 13 },
  tramos: Array.from({ length: n }, (_, i) => ({ estado: "pendiente", pico: 0.3, etiqueta: comun.etiquetaTramo(i) })),
  ...extra,
});
const audioDe = (id, n) => Array.from({ length: n }, (_, i) => [id, i, blobDe(null, 1000)]);

// Respuestas por tramo: el prompt dice «TRAMO i de N», así cada tramo recibe las
// suyas aunque dos se transcriban a la vez. A los proveedores que reciben el
// audio en un formulario (3.8) no se les manda ese prompt: ahí el tramo sale del
// nombre del fichero («tramo02.webm»).
function fetchPorTramo(porTramo) {
  const colas = {};
  for (const [k, v] of Object.entries(porTramo)) colas[k] = v.slice();
  const llamadas = [];
  const fn = async (url, opts = {}) => {
    const campos = opts.body && opts.body._campos;
    const fichero = campos ? (campos.find(([n]) => n === "file") || [])[2] || "" : "";
    const prompt = campos ? "" : JSON.parse(opts.body || "{}").contents?.[0]?.parts?.[0]?.text || "";
    const m = campos ? /^tramo(\d+)\./.exec(fichero) : /TRAMO (\d+) de/.exec(prompt);
    const idx = m ? Number(m[1]) : 1;
    llamadas.push({ url: String(url), idx, opts });
    const r = (colas[idx] || []).shift();
    if (!r) throw new Error("fetch inesperado para el tramo " + idx);
    if (r.lanza) throw new Error(r.lanza);
    return respuestaHttp(r);
  };
  fn._llamadas = llamadas;
  fn.anade = (idx, ...rs) => { colas[idx] = (colas[idx] || []).concat(rs); };
  return fn;
}
const saturadoSiempre = () => Array.from({ length: 12 }, () => ({ status: 503, cuerpo: "{}" }));

grupo("motor de transcripción — reintentos y audio a salvo");

test("una ronda completa: todos los tramos transcritos, audio borrado y .md limpio", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")], 2: [respGemini("dos")], 3: [respGemini("tres")] });
  const s = sistema({ local: { historial: [reunion(7, 3)] }, audios: audioDe(7, 3), fetch: f });
  await s.off.transcribirReunion(7);
  const h = s.entrada(7);
  assert.strictEqual(h.estado, "ok");
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["uno", "dos", "tres"]);
  assert.strictEqual(s.audios._datos.size, 0, "con el texto a salvo, el audio sobra");
  assert.match(h.transcript, /uno[\s\S]*dos[\s\S]*tres/);
  assert.doesNotMatch(h.transcript, /pendiente/);
  assert.strictEqual(typeof h.fileMd, "number", "el .md se descarga");
  assert.deepStrictEqual(Object.keys(s.chrome._registro.alarmas), []);
});

test("REGRESIÓN 21/09: sin clave no se pierde nada, y al guardarla se transcribe sola", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")], 2: [respGemini("dos")], 3: [respGemini("tres")] });
  const s = sistema({ local: { geminiKey: "", historial: [reunion(8, 3)] }, audios: audioDe(8, 3), fetch: f });
  await s.off.transcribirReunion(8);
  let h = s.entrada(8);
  assert.strictEqual(h.estado, "pendiente");
  assert.ok(h.tramos.every((t) => t.codigo === "sin_clave"));
  assert.strictEqual(f._llamadas.length, 0, "sin clave no se toca la red");
  assert.strictEqual(s.audios._datos.size, 3, "el audio sigue guardado");
  assert.ok(h.reintento.esperaClave);
  assert.deepStrictEqual(Object.keys(s.chrome._registro.alarmas), [], "esperar no arregla una clave: nada de alarmas");

  // El usuario pega la clave en Opciones.
  await s.chrome.storage.local.set({ geminiKey: "NUEVA" });
  await hasta(() => s.entrada(8).estado === "ok", "que se transcribiera al poner la clave");
  h = s.entrada(8);
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["uno", "dos", "tres"]);
  assert.strictEqual(s.audios._datos.size, 0);
});

test("un tramo que no sale se queda pendiente con su audio, se programa el reintento y la alarma lo completa", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")], 2: saturadoSiempre() });
  const s = sistema({ local: { historial: [reunion(9, 2)] }, audios: audioDe(9, 2), fetch: f });
  await s.off.transcribirReunion(9);
  let h = s.entrada(9);
  assert.strictEqual(h.estado, "pendiente");
  assert.strictEqual(h.tramos[0].texto, "uno");
  assert.strictEqual(h.tramos[1].codigo, "saturado");
  assert.deepStrictEqual([...s.audios._datos.keys()], ["9:1"], "solo queda el audio del tramo que falta");
  assert.strictEqual(s.chrome._registro.alarmas["reintento:9"].delayInMinutes, 1, "primer reintento al minuto");
  assert.match(h.transcript, /uno/);
  assert.match(h.transcript, /1 de 2 tramos sigue sin transcribir/);
  const mdViejo = h.fileMd;
  assert.ok(s.chrome._registro.descargas.some((d) => /audio_2026-09-21_1150\/tramo02\.webm$/.test(d.filename)),
    "copia de seguridad del audio pendiente en Descargas");

  // Salta la alarma y Gemini ya responde.
  f.anade(2, respGemini("dos"));
  s.chrome._oyentes.alarma.forEach((fn) => fn({ name: "reintento:9" }));
  await hasta(() => s.entrada(9).estado === "ok", "que la alarma completara la reunión");
  h = s.entrada(9);
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["uno", "dos"]);
  assert.doesNotMatch(h.transcript, /pendiente/);
  assert.ok(s.chrome._registro.borrados.includes(mdViejo), "el .md incompleto se sustituye, no se acumula");
  assert.strictEqual(s.chrome._registro.alarmas["reintento:9"], undefined);
  assert.strictEqual(s.audios._datos.size, 0);
});

test("una clave rechazada detiene la ronda: no se gastan llamadas en el resto de tramos", async () => {
  const f = fetchPorTramo({
    1: [{ status: 400, cuerpo: '{"error":{"message":"API key not valid"}}' }],
    2: [{ status: 400, cuerpo: '{"error":{"message":"API key not valid"}}' }],
    3: [], 4: [],
  });
  const s = sistema({ local: { historial: [reunion(10, 4)] }, audios: audioDe(10, 4), fetch: f });
  await s.off.transcribirReunion(10);
  const h = s.entrada(10);
  assert.ok(f._llamadas.length <= 2, "como mucho los dos tramos que ya estaban en vuelo; hubo " + f._llamadas.length);
  assert.ok(h.tramos.every((t) => t.codigo === "clave_invalida"));
  assert.strictEqual(s.audios._datos.size, 4);
});

test("si IndexedDB no responde, el tramo queda pendiente (fallo interno), no se da por perdido", async () => {
  const s = sistema({ local: { historial: [reunion(11, 1)] }, audios: audioDe(11, 1) });
  s.audios.fallaLectura = true;
  await s.off.transcribirReunion(11);
  const t = s.entrada(11).tramos[0];
  assert.strictEqual(t.estado, "pendiente");
  assert.strictEqual(t.codigo, "interno");
});

test("un tramo cuyo audio ya no existe se marca como perdido, sin llamar al modelo", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")] });
  const s = sistema({ local: { historial: [reunion(12, 2)] }, audios: audioDe(12, 1), fetch: f });
  await s.off.transcribirReunion(12);
  const h = s.entrada(12);
  assert.strictEqual(h.tramos[1].estado, "perdido");
  assert.strictEqual(h.estado, "ok", "lo que se pudo transcribir vale");
  assert.match(h.transcript, /no se pueden recuperar/);
});

test("dos peticiones de transcribir la misma reunión a la vez hacen UNA sola ronda", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")] });
  const s = sistema({ local: { historial: [reunion(13, 1)] }, audios: audioDe(13, 1), fetch: f });
  await Promise.all([
    s.enviar({ target: "bg", cmd: "transcribir", id: 13 }),
    s.enviar({ target: "bg", cmd: "transcribir", id: 13 }),
    s.enviar({ target: "bg", cmd: "reintentar", id: 13 }).catch(() => {}),
  ]);
  await hasta(() => s.entrada(13).estado === "ok");
  assert.strictEqual(f._llamadas.length, 1);
});

test("si el usuario borra la reunión mientras se transcribe, se para y se borra su audio", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")], 2: [respGemini("dos")], 3: [respGemini("tres")] });
  const s = sistema({ local: { historial: [reunion(14, 3)] }, audios: audioDe(14, 3), fetch: f });
  const ronda = s.off.transcribirReunion(14);
  await s.enviar({ target: "bg", cmd: "borrar", ids: [14], conAudio: true });
  await ronda;
  assert.strictEqual(s.entrada(14), undefined);
  assert.strictEqual(s.audios._datos.size, 0);
});

test("tras seis reintentos automáticos fallidos se deja de insistir (y queda el botón)", async () => {
  const { chrome, enviar } = bg({ local: { historial: [reunion(15, 1, { tramos: [tramoPend("saturado")] })] } });
  for (let i = 0; i < 6; i++) {
    await enviar({ target: "bg", cmd: "finRonda", id: 15 });
    assert.ok(chrome._registro.alarmas["reintento:15"], "intento " + (i + 1) + " programado");
  }
  await enviar({ target: "bg", cmd: "finRonda", id: 15 });
  const h = chrome.storage.local._volcado().historial[0];
  assert.strictEqual(h.reintento.agotado, true);
  assert.strictEqual(chrome._registro.alarmas["reintento:15"], undefined);
});

grupo("service worker — recuperación y limpieza");

test("una grabación cortada por un cierre de Chrome se transcribe con lo que llegó a guardarse", async () => {
  const f = fetchPorTramo({ 1: [respGemini("primeros cinco minutos")], 2: [respGemini("segundos cinco")] });
  const cortada = { ...reunion(20, 0), estado: "grabando", tramos: [] };
  const s = sistema({ local: { historial: [cortada] }, audios: audioDe(20, 2), fetch: f });
  await s.enviar({ target: "bg", cmd: "revisarPendientes" });
  await hasta(() => s.entrada(20).estado === "ok", "que se recuperara la grabación");
  const h = s.entrada(20);
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["primeros cinco minutos", "segundos cinco"]);
  assert.strictEqual(h.meta.interrumpida, true);
  assert.match(h.transcript, /se cortó antes de tiempo/);
});

test("una grabación EN CURSO no se toca aunque su entrada diga «grabando»", async () => {
  const s = sistema({ local: { historial: [{ ...reunion(21, 0), estado: "grabando", tramos: [] }] }, audios: audioDe(21, 1) });
  // El documento offscreen existe y dice que está grabando la 21.
  s.chrome._registro.offscreen = 1;
  const enrutar = s.chrome.runtime.sendMessage;
  s.chrome.runtime.sendMessage = (msg) => (msg.target === "offscreen" && msg.cmd === "estado"
    ? Promise.resolve({ ok: true, grabandoId: 21, enCurso: [] }) : enrutar(msg));
  await s.enviar({ target: "bg", cmd: "revisarPendientes" });
  for (let i = 0; i < 50; i++) await espera0();
  assert.strictEqual(s.entrada(21).estado, "grabando");
  assert.strictEqual(s.audios._datos.size, 1);
});

test("una grabación cortada antes del primer tramo acaba en error explicado, no colgada", async () => {
  const s = sistema({ local: { historial: [{ ...reunion(22, 0), estado: "grabando", tramos: [] }] } });
  await s.enviar({ target: "bg", cmd: "revisarPendientes" });
  const h = s.entrada(22);
  assert.strictEqual(h.estado, "error");
  assert.match(h.transcript, /interrumpió/);
});

test("una entrada de la 3.0 que se quedó «transcribiendo» se cierra con un error, no queda colgada", async () => {
  const vieja = { ...entradaHist(23), estado: "transcribiendo" }; // sin tramos: formato anterior
  const s = sistema({ local: { historial: [vieja] } });
  await s.enviar({ target: "bg", cmd: "revisarPendientes" });
  assert.strictEqual(s.entrada(23).estado, "error");
  assert.match(s.entrada(23).transcript, /se interrumpió/);
});

test("al arrancar se borra el audio que ya no pertenece a ninguna reunión viva", async () => {
  const hist = [reunion(30, 1, { estado: "pendiente" }), entradaHist(31)];
  const { ctx, audios } = bg({ local: { historial: hist }, audios: [[30, 0, blobDe(null)], [31, 0, blobDe(null)], [99, 0, blobDe(null)]] });
  await ctx.limpiarHuerfanos();
  assert.deepStrictEqual([...audios._datos.keys()], ["30:0"]);
});

test("podar nunca se lleva una reunión que espera un reintento", async () => {
  const hist = [entradaHist(1), entradaHist(2), reunion(3, 1, { estado: "pendiente" }), entradaHist(4)];
  const { chrome, enviar, audios } = bg({ local: { historial: hist }, sync: { limite: 1 }, audios: [[3, 0, blobDe(null)]] });
  await enviar({ target: "bg", cmd: "podar" });
  const ids = chrome.storage.local._volcado().historial.map((h) => h.id);
  assert.deepStrictEqual(ids, [1, 3]);
  assert.strictEqual(audios._datos.size, 1);
});

test("borrar una reunión borra también su audio interno y su reintento programado", async () => {
  const { chrome, enviar, audios } = bg({ local: { historial: [reunion(40, 2, { estado: "pendiente" })] }, audios: audioDe(40, 2) });
  chrome._registro.alarmas["reintento:40"] = { delayInMinutes: 5 };
  await enviar({ target: "bg", cmd: "borrar", ids: [40], conAudio: false });
  assert.strictEqual(audios._datos.size, 0);
  assert.strictEqual(chrome._registro.alarmas["reintento:40"], undefined);
});

test("REGRESIÓN: dos tramos que terminan a la vez no se pisan en el historial", async () => {
  const { chrome, enviar } = bg({ local: { historial: [reunion(50, 6)] } });
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    enviar({ target: "bg", cmd: "histTramo", id: 50, i, datos: { estado: "ok", texto: "t" + i } })));
  const h = chrome.storage.local._volcado().historial[0];
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["t0", "t1", "t2", "t3", "t4", "t5"]);
  assert.strictEqual(h.progreso, "6/6 tramos");
});

// ============================================================================
// 3.2 — sacar partido a la reunión grabada (docs/2026-09-30-plan-mejoras.md)
// ============================================================================
grupo("3.2 · marcas de tiempo y hablantes (comun.js)");

test("formatoTiempo: minutos:segundos, y horas cuando pasa de una", () => {
  assert.strictEqual(comun.formatoTiempo(65), "01:05");
  assert.strictEqual(comun.formatoTiempo(0), "00:00");
  assert.strictEqual(comun.formatoTiempo(3725), "1:02:05");
});

test("ajustarTiempos suma el inicio del tramo a las marcas que da el modelo", () => {
  const txt = "[00:05] Hablante 1: hola\n[1:10] Hablante 2: adiós\nsigue sin marca\n[0:01:02] Hablante 1: fin";
  const r = comun.ajustarTiempos(txt, 600);
  assert.strictEqual(r, "[10:05] Hablante 1: hola\n[11:10] Hablante 2: adiós\nsigue sin marca\n[11:02] Hablante 1: fin");
  assert.strictEqual(comun.ajustarTiempos("[59:30] X: a", 300), "[1:04:30] X: a", "pasa a horas");
  assert.strictEqual(comun.ajustarTiempos("sin marcas", 300), "sin marcas");
});

test("inicioTramo usa el inicio guardado y, en entradas antiguas, lo deduce del índice", () => {
  assert.strictEqual(comun.inicioTramo({ inicioS: 42 }, 3), 42);
  assert.strictEqual(comun.inicioTramo({}, 3), 3 * comun.DURACION_TRAMO_S);
});

test("hablantesDe saca las etiquetas en orden y sin repetir", () => {
  const txt = "[00:01] Hablante 1: hola\n[00:04] Hablante 2: qué tal\nHablante 1: bien\n[inaudible]\nTexto suelto sin etiqueta";
  assert.deepStrictEqual(comun.hablantesDe(txt), ["Hablante 1", "Hablante 2"]);
});

test("aplicarHablantes renombra solo la etiqueta de inicio de línea, nunca el texto", () => {
  const txt = "[00:01] Hablante 1: le paso la palabra a Hablante 2\nHablante 10: yo no soy el 1\nHablante 1: vale";
  const r = comun.aplicarHablantes(txt, { "Hablante 1": "Marcos", "Hablante 2": "" });
  assert.strictEqual(r, "[00:01] Marcos: le paso la palabra a Hablante 2\nHablante 10: yo no soy el 1\nMarcos: vale");
});

test("lineasTranscripcion separa marca, hablante y texto", () => {
  const ls = comun.lineasTranscripcion("[01:05] Marcos: hola\ncontinúa\n[1:00:00] Ana: fin");
  assert.deepStrictEqual(ls.map((l) => [l.t, l.hablante, l.texto]), [[65, "Marcos", "hola"], [null, "", "continúa"], [3600, "Ana", "fin"]]);
});

test("el .md lleva los participantes y los hablantes renombrados", () => {
  const md = comun.construirMarkdown({
    fecha: "30/09/2026 10:00", titulo: "Comité", participantes: "Marcos, Ana", hablantes: { "Hablante 1": "Marcos" },
    meta: { minutos: 5 }, tramos: [{ estado: "ok", texto: "[00:03] Hablante 1: arrancamos" }],
  });
  assert.match(md, /\*\*Participantes:\*\* Marcos, Ana/);
  assert.match(md, /\[00:03\] Marcos: arrancamos/);
  assert.doesNotMatch(md, /Hablante 1/);
});

// ----------------------------------------------------------------------------
grupo("3.2 · exportar (exportar.js)");
const exportar = require("../exportar.js");

test("crc32 da el valor de referencia", () => {
  assert.strictEqual(exportar.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

// Lee un zip sin comprimir: nombres y contenido de cada fichero del directorio central.
function leerZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fin = bytes.length - 22;
  while (fin >= 0 && v.getUint32(fin, true) !== 0x06054b50) fin--;
  assert.ok(fin >= 0, "falta el fin de directorio central");
  const n = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const ficheros = {};
  for (let i = 0; i < n; i++) {
    assert.strictEqual(v.getUint32(p, true), 0x02014b50, "cabecera central");
    const crc = v.getUint32(p + 16, true), tam = v.getUint32(p + 20, true);
    const ln = v.getUint16(p + 28, true), le = v.getUint16(p + 30, true), lc = v.getUint16(p + 32, true);
    const loc = v.getUint32(p + 42, true);
    const nombre = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + ln));
    assert.strictEqual(v.getUint32(loc, true), 0x04034b50, "cabecera local de " + nombre);
    const lnl = v.getUint16(loc + 26, true), lel = v.getUint16(loc + 28, true);
    const datos = bytes.subarray(loc + 30 + lnl + lel, loc + 30 + lnl + lel + tam);
    assert.strictEqual(exportar.crc32(datos), crc, "crc de " + nombre);
    ficheros[nombre] = new TextDecoder().decode(datos);
    p += 46 + ln + le + lc;
  }
  return ficheros;
}

test("zip genera un archivo válido que se puede volver a leer", () => {
  const z = exportar.zip([{ nombre: "a.txt", datos: "hola" }, { nombre: "carpeta/b.xml", datos: "<x>ñ</x>" }]);
  const f = leerZip(z);
  assert.deepStrictEqual(Object.keys(f), ["a.txt", "carpeta/b.xml"]);
  assert.strictEqual(f["carpeta/b.xml"], "<x>ñ</x>");
});

test("docx: un Word de verdad, con títulos, listas y el texto escapado", () => {
  const f = leerZip(exportar.docx("Acta & <prueba>", "## Decisiones\n- Aprobar **presupuesto** & plazo\n\nTexto normal"));
  for (const k of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]) assert.ok(f[k], "falta " + k);
  const doc = f["word/document.xml"];
  assert.match(doc, /Acta &amp; &lt;prueba&gt;/);
  assert.match(doc, /Heading2[\s\S]*Decisiones/);
  assert.match(doc, /<w:b\/>[\s\S]*presupuesto/);
  assert.doesNotMatch(doc, /\*\*/, "las marcas de markdown no pueden llegar al Word");
});

test("srt: una entrada por intervención con marca, tiempos crecientes", () => {
  const srt = exportar.srt("[00:05] Marcos: hola\nsigue\n[01:10] Ana: adiós");
  assert.strictEqual(srt, "1\n00:00:05,000 --> 00:01:10,000\nMarcos: hola sigue\n\n2\n00:01:10,000 --> 00:01:16,000\nAna: adiós\n");
  assert.strictEqual(exportar.srt("sin marcas de tiempo"), "", "sin marcas no hay subtítulos");
});

test("mdAHtml pinta títulos, listas, tablas y negrita, y nunca ejecuta HTML", () => {
  const h = exportar.mdAHtml("## Tareas\n| Quién | Qué |\n|---|---|\n| Ana | **Enviar** |\n\n- uno\n- <script>alert(1)</script>");
  assert.match(h, /<h2>Tareas<\/h2>/);
  assert.match(h, /<table>[\s\S]*<td>Ana<\/td><td><b>Enviar<\/b><\/td>/);
  assert.match(h, /<li>uno<\/li>/);
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
});

test("textoPlano quita las marcas de markdown", () => {
  assert.strictEqual(exportar.textoPlano("## Título\n- **uno**\n> cita"), "Título\n• uno\ncita");
});

// ----------------------------------------------------------------------------
grupo("3.2 · plantillas y preguntas a la IA (ia.js)");

function ia(fetchStub) {
  return cargar(["proveedores.js", "comun.js","ia.js"], { fetch: fetchStub, setTimeout: (fn) => setImmediate(fn) });
}
const cfgIA = { geminiKey: "G", geminiModel: "gemini-flash-latest", openaiKey: "O", openaiModel: "gpt-x", claudeKey: "C", claudeModel: "claude-x", glosario: "Odoo, Acme" };

test("cada plantilla pide lo suyo y todas llevan participantes y glosario", () => {
  const ctx = ia(nuevoFetch([]));
  const t = ctx.promptPlantilla("tareas", { glosario: "Odoo", participantes: "Marcos, Ana" });
  assert.match(t, /responsable/i);
  assert.match(t, /Marcos, Ana/);
  assert.match(t, /Odoo/);
  assert.match(ctx.promptPlantilla("correo", {}), /correo/i);
  assert.match(ctx.promptPlantilla("personalizada", { personalizada: "Saca solo los riesgos" }), /Saca solo los riesgos/);
  assert.strictEqual(ctx.promptPlantilla("no-existe", {}), ctx.promptPlantilla("acta", {}), "una plantilla desconocida cae en el acta");
});

test("Gemini: petición correcta y tokens gastados", async () => {
  const f = nuevoFetch([{ cuerpo: { candidates: [{ content: { parts: [{ text: "ACTA" }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120 } } }]);
  const r = await ia(f).llamarIA("gemini", cfgIA, "SISTEMA", "TRANSCRIPCIÓN");
  assert.deepStrictEqual([r.texto, r.uso.entrada, r.uso.salida], ["ACTA", 900, 120]);
  const ll = f._llamadas[0];
  assert.match(ll.url, /models\/gemini-flash-latest:generateContent$/);
  assert.strictEqual(ll.opts.headers["x-goog-api-key"], "G");
  assert.match(ll.opts.body, /SISTEMA[\s\S]*TRANSCRIPCIÓN/);
});

test("GPT: petición correcta y tokens gastados", async () => {
  const f = nuevoFetch([{ cuerpo: { choices: [{ message: { content: "ACTA" } }], usage: { prompt_tokens: 50, completion_tokens: 7 } } }]);
  const r = await ia(f).llamarIA("gpt", cfgIA, "S", "U");
  assert.deepStrictEqual([r.texto, r.uso.entrada, r.uso.salida], ["ACTA", 50, 7]);
  const cuerpo = JSON.parse(f._llamadas[0].opts.body);
  assert.strictEqual(f._llamadas[0].opts.headers.Authorization, "Bearer O");
  assert.strictEqual(cuerpo.model, "gpt-x");
  assert.deepStrictEqual(cuerpo.messages.map((m) => m.role), ["system", "user"]);
});

test("Claude: petición correcta y tokens gastados", async () => {
  const f = nuevoFetch([{ cuerpo: { content: [{ type: "text", text: "ACTA" }], usage: { input_tokens: 30, output_tokens: 4 } } }]);
  const r = await ia(f).llamarIA("claude", cfgIA, "S", "U");
  assert.deepStrictEqual([r.texto, r.uso.entrada, r.uso.salida], ["ACTA", 30, 4]);
  const h = f._llamadas[0].opts.headers;
  assert.strictEqual(h["x-api-key"], "C");
  assert.strictEqual(h["anthropic-dangerous-direct-browser-access"], "true");
  assert.strictEqual(JSON.parse(f._llamadas[0].opts.body).system, "S");
});

test("un 503 se reintenta avisando, y sin clave se dice cuál falta sin tocar la red", async () => {
  const f = nuevoFetch([{ status: 503, cuerpo: "{}" }, { cuerpo: { choices: [{ message: { content: "OK" } }] } }]);
  const avisos = [];
  const r = await ia(f).llamarIA("gpt", cfgIA, "S", "U", { alEstado: (t) => avisos.push(t) });
  assert.strictEqual(r.texto, "OK");
  assert.strictEqual(avisos.length, 1);
  const vacio = nuevoFetch([]);
  await assert.rejects(ia(vacio).llamarIA("claude", { ...cfgIA, claudeKey: "" }, "S", "U"), /Anthropic/);
  assert.strictEqual(vacio._llamadas.length, 0);
});

test("analizarReunion manda la transcripción con los nombres puestos y guarda por plantilla y proveedor", async () => {
  const f = nuevoFetch([{ cuerpo: { candidates: [{ content: { parts: [{ text: "RESUMEN" }] } }] } }]);
  const h = { transcript: "[00:01] Hablante 1: hola", hablantes: { "Hablante 1": "Marcos" }, participantes: "Marcos" };
  const r = await ia(f).analizarReunion(h, "resumen", "gemini", cfgIA);
  assert.strictEqual(r.clave, "resumen·gemini");
  assert.strictEqual(r.texto, "RESUMEN");
  assert.match(f._llamadas[0].opts.body, /Marcos: hola/);
  assert.doesNotMatch(f._llamadas[0].opts.body, /Hablante 1: hola/);
});

test("preguntarReunion arrastra la conversación anterior", async () => {
  const f = nuevoFetch([{ cuerpo: { choices: [{ message: { content: "El 15 de octubre." } }] } }]);
  const h = { transcript: "[00:01] Ana: entregamos el 15 de octubre", chat: [{ p: "¿Quién habla?", r: "Ana." }] };
  const r = await ia(f).preguntarReunion(h, "¿Y cuándo se entrega?", "gpt", cfgIA);
  assert.strictEqual(r.texto, "El 15 de octubre.");
  const msgs = JSON.parse(f._llamadas[0].opts.body).messages;
  assert.deepStrictEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.match(msgs[0].content, /entregamos el 15 de octubre/);
  assert.strictEqual(msgs[3].content, "¿Y cuándo se entrega?");
});

// ----------------------------------------------------------------------------
grupo("3.2 · transcripción con tiempos, nombres e idioma (offscreen.js)");

test("el prompt pide marcas de tiempo, usa los participantes con cautela y respeta el idioma", () => {
  const ctx = offscreen(nuevoFetch([]));
  const p = ctx.construirPrompt("", 2, 3, { participantes: "Marcos, Ana", idioma: "es" });
  assert.match(p, /\[MM:SS\]/);
  assert.match(p, /Marcos, Ana/);
  assert.match(p, /Hablante 1/, "si hay duda, sigue la etiqueta genérica");
  assert.match(p, /español/);
  const auto = ctx.construirPrompt("", 1, 1, { idioma: "auto" });
  assert.doesNotMatch(auto, /reunión de trabajo en español/);
  assert.match(auto, /idioma/i);
});

test("REGRESIÓN 01/10: con un idioma fijado, lo que se hable en otro se transcribe; SIN_VOZ es solo para el silencio", () => {
  // Con «en español» a secas, una entrevista en inglés volvió como SIN_VOZ y el tramo se perdió.
  const p = offscreen(nuevoFetch([])).construirPrompt("", 1, 1, { idioma: "es" });
  assert.match(p, /se espera en español/);
  assert.match(p, /otro idioma, transcríbelo igualmente/);
  assert.match(p, /nunca lo dejes fuera ni respondas SIN_VOZ por eso/);
});

test("cada tramo guarda su texto con el tiempo de la reunión y los tokens gastados", async () => {
  const conUso = (t) => ({ cuerpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: t }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } } });
  const f = fetchPorTramo({ 1: [conUso("[00:10] Hablante 1: uno")], 2: [conUso("[00:20] Hablante 2: dos")] });
  const r = reunion(60, 2);
  r.tramos[1].inicioS = 300;
  const s = sistema({ local: { historial: [r] }, audios: audioDe(60, 2), fetch: f });
  await s.off.transcribirReunion(60);
  const h = s.entrada(60);
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["[00:10] Hablante 1: uno", "[05:20] Hablante 2: dos"]);
  assert.deepStrictEqual({ ...h.tramos[1].uso }, { entrada: 10, salida: 3 });
});

test("los participantes de la reunión llegan al prompt de cada tramo", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")] });
  const s = sistema({ local: { historial: [reunion(61, 1, { participantes: "Marcos, Ana" })] }, audios: audioDe(61, 1), fetch: f });
  let prompt = "";
  const fetchOriginal = s.off.fetch;
  s.off.fetch = async (url, opts) => { prompt = JSON.parse(opts.body).contents[0].parts[0].text; return fetchOriginal(url, opts); };
  await s.off.transcribirReunion(61);
  assert.match(prompt, /Marcos, Ana/);
});

test("acta automática: encendida, una sola llamada al terminar y se guarda en la reunión", async () => {
  const llamadasIA = [];
  const f = fetchPorTramo({ 1: [respGemini("[00:01] Hablante 1: hola")] });
  const envoltorio = async (url, opts) => {
    if (/generateContent/.test(url) && !/TRAMO|Transcribe/.test(opts.body)) {
      llamadasIA.push(url);
      return { ok: true, status: 200, async text() { return ""; }, async json() { return { candidates: [{ content: { parts: [{ text: "ACTA AUTO" }] } }] }; } };
    }
    return f(url, opts);
  };
  const s = sistema({ local: { historial: [reunion(62, 1)] }, sync: { autoActa: true, autoActaProv: "gemini", autoActaPlantilla: "acta" }, audios: audioDe(62, 1), fetch: envoltorio });
  await s.off.transcribirReunion(62);
  await hasta(() => (s.entrada(62).analisis || {})["acta·gemini"], "que se guardara el acta automática");
  assert.strictEqual(llamadasIA.length, 1);
  assert.strictEqual(s.entrada(62).analisis["acta·gemini"], "ACTA AUTO");
});

test("acta automática: apagada no gasta, y una reunión incompleta no la dispara", async () => {
  const f = fetchPorTramo({ 1: [respGemini("hola")] });
  const s = sistema({ local: { historial: [reunion(63, 1)] }, audios: audioDe(63, 1), fetch: f });
  await s.off.transcribirReunion(63);
  assert.strictEqual(f._llamadas.length, 1, "solo la transcripción");
  assert.deepStrictEqual(s.entrada(63).analisis, {});

  const g = fetchPorTramo({ 1: saturadoSiempre() });
  const s2 = sistema({ local: { historial: [reunion(64, 1)] }, sync: { autoActa: true }, audios: audioDe(64, 1), fetch: g });
  await s2.off.transcribirReunion(64);
  assert.strictEqual(s2.entrada(64).estado, "pendiente");
  assert.deepStrictEqual(s2.entrada(64).analisis, {}, "sin transcripción completa no hay acta");
});

// ----------------------------------------------------------------------------
grupo("3.2 · editar la reunión desde la biblioteca (background.js)");

test("histEditar solo cambia título, participantes y hablantes, y rehace el .md", async () => {
  const h0 = reunion(70, 1, { estado: "ok", fileMd: 5, tramos: [{ estado: "ok", texto: "[00:01] Hablante 1: hola" }] });
  const { chrome, enviar } = bg({ local: { historial: [h0] } });
  const r = await enviar({ target: "bg", cmd: "histEditar", id: 70, cambios: { titulo: "Comité", hablantes: { "Hablante 1": "Marcos" }, estado: "error" } });
  assert.strictEqual(r.ok, true);
  const h = chrome.storage.local._volcado().historial[0];
  assert.strictEqual(h.titulo, "Comité");
  assert.strictEqual(h.estado, "ok", "el estado no se toca desde fuera");
  assert.match(h.transcript, /Marcos: hola/);
  assert.ok(chrome._registro.borrados.includes(5), "el .md viejo se sustituye");
  assert.notStrictEqual(h.fileMd, 5);
});

test("histAnalisis guarda cada plantilla aparte, conserva las actas antiguas y apunta el uso", async () => {
  const { chrome, enviar } = bg({ local: { historial: [entradaHist(71, { analisis: { gemini: "ACTA VIEJA" } })] } });
  await enviar({ target: "bg", cmd: "histAnalisis", id: 71, clave: "tareas·claude", texto: "TAREAS", uso: { entrada: 5, salida: 2 } });
  const h = chrome.storage.local._volcado().historial[0];
  assert.deepStrictEqual({ ...h.analisis }, { gemini: "ACTA VIEJA", "tareas·claude": "TAREAS" });
  assert.strictEqual(h.usoIA[0].clave, "tareas·claude");
  assert.strictEqual(h.usoIA[0].entrada, 5);
});

test("histChat va añadiendo la conversación", async () => {
  const { chrome, enviar } = bg({ local: { historial: [entradaHist(72)] } });
  await enviar({ target: "bg", cmd: "histChat", id: 72, mensaje: { p: "¿Qué se decidió?", r: "Nada.", prov: "gpt" } });
  await enviar({ target: "bg", cmd: "histChat", id: 72, mensaje: { p: "¿Seguro?", r: "Sí.", prov: "gpt" } });
  const h = chrome.storage.local._volcado().historial[0];
  assert.deepStrictEqual([...h.chat.map((m) => m.p)], ["¿Qué se decidió?", "¿Seguro?"]);
});

test("una grabación recuperada tras un cierre sabe dónde empieza cada tramo", async () => {
  const { chrome, ctx } = bg({
    local: { historial: [{ id: 73, fecha: "x", titulo: "t", estado: "grabando", tramos: [], meta: {} }] },
    audios: [[73, 0, blobDe(null)], [73, 1, blobDe(null)]],
  });
  chrome.runtime.sendMessage = async () => ({ ok: true, grabandoId: null, enCurso: [] });
  chrome._registro.offscreen = 1;
  await ctx.recuperar();
  const h = chrome.storage.local._volcado().historial[0];
  assert.deepStrictEqual([...h.tramos.map((t) => t.inicioS)], [0, comun.DURACION_TRAMO_S]);
});

// ============================================================================
// 3.3 — grabar mejor (docs/2026-09-30-plan-mejoras.md, tanda B)
// ============================================================================
function relojFalso(reloj) {
  return class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(reloj.t); }
    static now() { return reloj.t; }
  };
}

// Service worker + documento offscreen GRABANDO de verdad (con los stubs de
// medios), hablándose como en Chrome. Con `reloj`, Date.now lo decide el test;
// con `retenerTimeouts`, los setTimeout se guardan en vez de ejecutarse.
function sistemaGrabando({ fetch: fetchStub = nuevoFetch([]), local = {}, sync = {}, reloj = null, retenerTimeouts = false, compartir = "pestana" } = {}) {
  const chrome = nuevoChrome({ local: { geminiKey: "K", geminiModel: "gemini-flash-latest", ...local }, sync });
  const aud = nuevosAudios();
  const bgCtx = cargar("background.js", { chrome, fetch: async () => { throw new Error("bg no debe llamar a la red"); } });
  bgCtx.audios = aud;
  const enviarBg = mensajero(chrome);
  const offChrome = nuevoChrome();
  offChrome.runtime.sendMessage = (msg) => enviarBg(msg);
  const medios = nuevosMedios({ conAudio: true, compartir });
  const timeouts = [];
  const entorno = {
    ...entornoOffscreen(offChrome, fetchStub),
    navigator: { mediaDevices: medios.mediaDevices },
    MediaRecorder: medios.MediaRecorder,
    Audio: nuevoAudioElemento(),
  };
  if (reloj) entorno.Date = relojFalso(reloj);
  if (retenerTimeouts) entorno.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };
  const off = cargar(["proveedores.js", "comun.js","ia.js", "offscreen.js"], entorno);
  off.audios = aud;
  const enviarOff = mensajero(offChrome);
  chrome.runtime.sendMessage = (msg) => (msg.target === "offscreen" ? enviarOff(msg) : enviarBg(msg));
  chrome._registro.offscreen = 1;
  const historial = () => chrome.storage.local._volcado().historial || [];
  return { chrome, bgCtx, off, entorno, audios: aud, medios, timeouts, enviar: enviarBg, historial, entrada: (id) => historial().find((h) => h.id === id) };
}

grupo("3.3 · transcribir mientras se graba");

test("cada tramo se transcribe en cuanto se cierra, sin esperar a parar", async () => {
  const f = fetchPorTramo({ 1: [respGemini("[00:10] Hablante 1: uno")], 2: [respGemini("[00:05] Hablante 1: dos")] });
  const reloj = { t: 3000000 };
  const s = sistemaGrabando({ fetch: f, reloj });
  await s.off.start({ modo: "mic" });
  const id = s.historial()[0].id;
  reloj.t += comun.DURACION_TRAMO_S * 1000; // el tramo dura lo que dura uno de verdad
  s.off.cortaTramo();
  await hasta(() => ((s.entrada(id).tramos || [])[0] || {}).estado === "ok", "que el primer tramo se transcribiera en vivo");
  reloj.t += 60000;
  assert.strictEqual(s.entrada(id).estado, "grabando", "la reunión sigue grabándose");
  assert.strictEqual(s.entrada(id).tramos[0].texto, "[00:10] Hablante 1: uno");
  s.off.stop();
  await hasta(() => s.entrada(id).estado === "ok", "que terminara al parar");
  assert.deepStrictEqual([...s.entrada(id).tramos.map((t) => t.texto)], ["[00:10] Hablante 1: uno", "[05:05] Hablante 1: dos"]);
  assert.strictEqual(f._llamadas.length, 2, "lo ya transcrito no se vuelve a mandar al parar");
  assert.strictEqual(s.audios._datos.size, 0);
});

test("al transcribir en vivo el prompt dice que la reunión sigue en curso", async () => {
  const ctx = offscreen(nuevoFetch([]));
  assert.match(ctx.construirPrompt("", 3, null, {}), /TRAMO 3 de una reunión que sigue en curso/);
});

test("si Chrome se cierra a mitad, lo que ya estaba transcrito se conserva", async () => {
  const { chrome, ctx } = bg({
    local: { historial: [{ id: 80, fecha: "x", titulo: "t", estado: "grabando", meta: {},
      tramos: [{ estado: "ok", texto: "uno", inicioS: 0 }] }] },
    audios: [[80, 1, blobDe(null)]],
  });
  chrome.runtime.sendMessage = async () => ({ ok: true, grabandoId: null, enCurso: [] });
  chrome._registro.offscreen = 1;
  await ctx.recuperar();
  const h = chrome.storage.local._volcado().historial[0];
  assert.deepStrictEqual([...h.tramos.map((t) => t.estado)], ["ok", "pendiente"]);
  assert.strictEqual(h.tramos[0].texto, "uno", "el texto del tramo ya transcrito no se pierde");
});

grupo("3.3 · pausa");

test("pausar para el tramo y el tiempo: las marcas no cuentan la pausa", async () => {
  const reloj = { t: 1000000 };
  const f = fetchPorTramo({ 1: [respGemini("[00:30] Hablante 1: antes")], 2: [respGemini("[00:10] Hablante 1: después")] });
  const s = sistemaGrabando({ fetch: f, reloj, retenerTimeouts: true });
  await s.off.start({ modo: "mic" });
  const id = s.historial()[0].id;
  reloj.t += 60000;
  s.off.pausar();
  assert.strictEqual(s.medios.MediaRecorder._creados[0].state, "paused");
  reloj.t += 140000; // dos minutos y veinte en pausa
  s.off.reanudar();
  const corte = s.timeouts.find((x) => x.ms > 1000);
  assert.strictEqual(corte.ms, comun.DURACION_TRAMO_S * 1000 - 60000, "el tramo se corta cuando lleva 5 min GRABADOS, no de reloj");
  reloj.t += 100000;
  s.off.cortaTramo();
  await hasta(() => ((s.entrada(id).tramos || [])[0] || {}).estado === "ok", "el primer tramo");
  reloj.t += 30000;
  s.off.stop();
  await hasta(() => s.entrada(id).estado === "ok", "que terminara");
  const h = s.entrada(id);
  assert.strictEqual(h.tramos[1].inicioS, 160, "el segundo tramo empieza en el minuto 2:40 grabado (60 s + 100 s)");
  assert.strictEqual(h.tramos[1].texto, "[02:50] Hablante 1: después");
  assert.strictEqual(h.meta.minutos, 3, "la duración es la grabada (190 s), sin la pausa");
});

grupo("3.3 · marcadores, notas y silencio");

test("marcar un momento guarda el minuto grabado y la nota", async () => {
  const reloj = { t: 5000000 };
  const s = sistemaGrabando({ reloj });
  await s.off.start({ modo: "mic" });
  const id = s.historial()[0].id;
  reloj.t += 125000;
  const r = await s.enviar({ target: "bg", cmd: "marcar", nota: "presupuesto" });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([...s.entrada(id).marcas.map((m) => [m.t, m.nota])], [[125, "presupuesto"]]);
});

test("sin grabación en curso no se puede marcar", async () => {
  const s = sistemaGrabando();
  const r = await s.enviar({ target: "bg", cmd: "marcar", nota: "x" });
  assert.strictEqual(r.ok, false);
});

test("el .md lleva las notas y los momentos marcados", () => {
  const md = comun.construirMarkdown({
    fecha: "x", titulo: "t", meta: { minutos: 1 }, notas: "Llamar a Ribera", marcas: [{ t: 125, nota: "presupuesto" }, { t: 3700 }],
    tramos: [{ estado: "ok", texto: "[00:01] A: hola" }],
  });
  assert.match(md, /## Notas\n\nLlamar a Ribera/);
  assert.match(md, /## Momentos marcados\n\n- \[02:05\] presupuesto\n- \[1:01:40\]/);
});

test("dos minutos sin voz avisan una vez, y el aviso se quita al volver la voz", async () => {
  const reloj = { t: 7000000 };
  const s = sistemaGrabando({ reloj });
  await s.off.start({ modo: "mic" });
  s.off.revisaSilencio(reloj.t + 119000);
  await espera0();
  assert.strictEqual(s.chrome._registro.notificaciones.length, 0, "antes de dos minutos, nada");
  s.off.revisaSilencio(reloj.t + 121000);
  await hasta(() => s.chrome._registro.notificaciones.length === 1, "el aviso de silencio");
  s.off.revisaSilencio(reloj.t + 180000);
  await espera0(); await espera0();
  assert.strictEqual(s.chrome._registro.notificaciones.length, 1, "no se repite");
  assert.strictEqual(s.chrome._registro.badges[s.chrome._registro.badges.length - 1], "!");
  s.off.registraVoz(reloj.t + 190000);
  await hasta(() => s.chrome._registro.notificaciones.length === 0, "que se quitara el aviso");
  assert.strictEqual(s.chrome._registro.badges[s.chrome._registro.badges.length - 1], "REC");
});

test("en pausa no se avisa de silencio", async () => {
  const reloj = { t: 9000000 };
  const s = sistemaGrabando({ reloj, retenerTimeouts: true });
  await s.off.start({ modo: "mic" });
  s.off.pausar();
  s.off.revisaSilencio(reloj.t + 600000);
  await espera0(); await espera0();
  assert.strictEqual(s.chrome._registro.notificaciones.length, 0);
});

grupo("3.3 · atajo de teclado");

test("el atajo empieza a grabar con el último modo y, pulsado otra vez, para", async () => {
  const s = sistemaGrabando({ fetch: fetchPorTramo({ 1: [respGemini("hola")] }) });
  await s.chrome.storage.session.set({ ultimoModo: "mic" });
  s.chrome._oyentes.comando.forEach((f) => f("grabar"));
  await hasta(() => s.chrome.storage.session._volcado().grabando === true, "que empezara a grabar");
  s.chrome._oyentes.comando.forEach((f) => f("grabar"));
  await hasta(() => s.chrome.storage.session._volcado().grabando === false, "que parara");
});

test("una grabación de «Solo micro» toma el título de los participantes", async () => {
  const s = sistemaGrabando();
  await s.off.start({ modo: "mic", participantes: "Marcos, Ana" });
  assert.strictEqual(s.historial()[0].titulo, "Reunión con Marcos, Ana");
  const s2 = sistemaGrabando();
  await s2.off.start({ modo: "mic" });
  assert.strictEqual(s2.historial()[0].titulo, "Reunión presencial");
});

// ============================================================================
// 3.4 — escuchar la reunión (docs/2026-09-30-plan-mejoras.md, tanda C)
// ============================================================================
grupo("3.4 · conservar el audio para escucharlo");

test("con «conservar el audio», cada tramo transcrito pasa al almacén de escucha", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")], 2: [respGemini("dos")] });
  const s = sistema({ local: { historial: [reunion(90, 2)] }, sync: { conservarAudio: true }, audios: audioDe(90, 2), fetch: f });
  await s.off.transcribirReunion(90);
  assert.strictEqual(s.entrada(90).estado, "ok");
  assert.strictEqual(s.audios._datos.size, 0, "el audio pendiente se borra como siempre");
  assert.deepStrictEqual([...(await s.audios.clavesEscucha()).map((k) => k[1])].sort(), [0, 1], "pero queda una copia para escucharla");
});

test("sin esa opción no se conserva nada", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")] });
  const s = sistema({ local: { historial: [reunion(91, 1)] }, audios: audioDe(91, 1), fetch: f });
  await s.off.transcribirReunion(91);
  assert.strictEqual(s.audios._escucha.size, 0);
});

test("también se conserva lo que se transcribe en vivo", async () => {
  const reloj = { t: 4000000 };
  const f = fetchPorTramo({ 1: [respGemini("uno")], 2: [respGemini("dos")] });
  const s = sistemaGrabando({ fetch: f, reloj, sync: { conservarAudio: true } });
  await s.off.start({ modo: "mic" });
  const id = s.historial()[0].id;
  reloj.t += comun.DURACION_TRAMO_S * 1000;
  s.off.cortaTramo();
  await hasta(() => ((s.entrada(id).tramos || [])[0] || {}).estado === "ok", "el tramo en vivo");
  s.off.stop();
  await hasta(() => s.entrada(id).estado === "ok", "que terminara");
  assert.strictEqual(s.audios._escucha.size, 2);
});

test("borrar una reunión borra también su audio conservado", async () => {
  const { enviar, audios } = bg({ local: { historial: [entradaHist(92)] } });
  await audios.guardarEscucha(92, 0, blobDe(null));
  await enviar({ target: "bg", cmd: "borrar", ids: [92], conAudio: false });
  assert.strictEqual(audios._escucha.size, 0);
});

test("al arrancar se borra el audio conservado de reuniones que ya no existen", async () => {
  const { chrome, ctx, audios } = bg({ local: { historial: [entradaHist(93)] } });
  await audios.guardarEscucha(93, 0, blobDe(null));
  await audios.guardarEscucha(94, 0, blobDe(null)); // de una reunión borrada
  chrome.runtime.sendMessage = async () => ({ ok: true, grabandoId: null, enCurso: [] });
  chrome._registro.offscreen = 1;
  await ctx.limpiarHuerfanos();
  assert.deepStrictEqual([...(await audios.clavesEscucha()).map((k) => k[0])], [93]);
});

test("podar se lleva el audio conservado de las reuniones que salen", async () => {
  const hist = Array.from({ length: 3 }, (_, i) => entradaHist(95 + i));
  const { enviar, audios } = bg({ local: { historial: hist }, sync: { limite: 1 } });
  for (const h of hist) await audios.guardarEscucha(h.id, 0, blobDe(null));
  await enviar({ target: "bg", cmd: "podar" });
  assert.deepStrictEqual([...(await audios.clavesEscucha()).map((k) => k[0])], [95]);
});

// ============================================================================
grupo("3.5 · el acta aguanta a Gemini saturado (ia.js)");

// Respuestas por modelo de Gemini: { "gemini-flash-latest": [r1, r2…] }. Lo
// que no está en el mapa, o se acaba, falla el test.
function fetchPorModelo(mapa) {
  const colas = Object.fromEntries(Object.entries(mapa).map(([m, rs]) => [m, rs.slice()]));
  const llamadas = [];
  const fn = async (url) => {
    const modelo = (String(url).match(/models\/([^:]+):/) || [])[1];
    llamadas.push(modelo);
    const r = (colas[modelo] || []).shift();
    if (!r) throw new Error("fetch inesperado para " + modelo);
    const cuerpo = typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo ?? {});
    const status = r.status === undefined ? 200 : r.status;
    return { ok: status < 300, status, async text() { return cuerpo; }, async json() { return JSON.parse(cuerpo); } };
  };
  fn._llamadas = llamadas;
  return fn;
}
const saturado = { status: 503, cuerpo: '{\n  "error": {\n    "code": 503,\n    "message": "This model is currently experiencing high demand.",\n    "status": "UNAVAILABLE"\n  }\n}\n' };
const cuatroVeces = (r) => [r, r, r, r]; // el intento y los tres reintentos

test("REGRESIÓN 01/10: con el modelo de Gemini saturado, el acta sale con un modelo de reserva", async () => {
  const f = fetchPorModelo({
    "gemini-flash-latest": cuatroVeces(saturado),
    "gemini-2.5-flash": [respGemini("ACTA DE RESERVA")],
  });
  const avisos = [];
  const r = await ia(f).llamarIA("gemini", cfgIA, "S", "U", { alEstado: (t) => avisos.push(t) });
  assert.strictEqual(r.texto, "ACTA DE RESERVA");
  assert.deepStrictEqual([...new Set(f._llamadas)], ["gemini-flash-latest", "gemini-2.5-flash"]);
  assert.ok(avisos.some((t) => /gemini-2\.5-flash/.test(t)), "avisa de que prueba otro modelo");
});

test("el modelo elegido en Opciones va primero, y si no existe (404) se pasa al siguiente", async () => {
  const f = fetchPorModelo({
    "gemini-mio": [{ status: 404, cuerpo: '{"error":{"message":"not found"}}' }],
    "gemini-flash-latest": [respGemini("OK")],
  });
  const r = await ia(f).llamarIA("gemini", { ...cfgIA, geminiModel: "gemini-mio" }, "S", "U");
  assert.strictEqual(r.texto, "OK");
  assert.deepStrictEqual(f._llamadas, ["gemini-mio", "gemini-flash-latest"]);
});

test("una clave rechazada no prueba otros modelos y dice qué hacer", async () => {
  const f = fetchPorModelo({ "gemini-flash-latest": [{ status: 403, cuerpo: '{"error":{"message":"API key not valid"}}' }] });
  await assert.rejects(ia(f).llamarIA("gemini", cfgIA, "S", "U"), (e) => /clave/i.test(e.message) && /Opciones/.test(e.message));
  assert.deepStrictEqual(f._llamadas, ["gemini-flash-latest"]);
});

test("si todos fallan, el error se lee: en español, sin JSON y con el código", async () => {
  const f = fetchPorModelo({
    "gemini-flash-latest": cuatroVeces(saturado),
    "gemini-2.5-flash": cuatroVeces(saturado),
    "gemini-flash-lite-latest": cuatroVeces(saturado),
  });
  await assert.rejects(ia(f).llamarIA("gemini", cfgIA, "S", "U"), (e) => {
    assert.match(e.message, /saturad/i);
    assert.match(e.message, /503/);
    assert.doesNotMatch(e.message, /[{}]/, "nada de JSON en crudo: " + e.message);
    return true;
  });
});

test("GPT y Claude también dan errores legibles", async () => {
  const f = nuevoFetch([{ status: 401, cuerpo: '{"error":{"message":"Incorrect API key"}}' }]);
  await assert.rejects(ia(f).llamarIA("gpt", cfgIA, "S", "U"), (e) => /OpenAI/.test(e.message) && /clave/i.test(e.message) && !/[{}]/.test(e.message));
});

grupo("3.5 · atajo para grabar");

test("REGRESIÓN 01/10: el atajo de grabar no es Alt+Shift+R, que Chrome se reserva y descarta sin avisar", () => {
  const m = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "manifest.json"), "utf8"));
  const tecla = m.commands.grabar.suggested_key.default;
  assert.notStrictEqual(tecla, "Alt+Shift+R");
  assert.strictEqual(tecla, "Alt+Shift+G");
});

grupo("3.5 · coste estimado en euros (comun.js)");

// € por millón de tokens. Gemini cobra distinto el audio (transcribir) y el texto (actas).
const PRECIOS = { gemini: { audio: "1", entrada: "0,30", salida: "2,5" }, gpt: { entrada: "2", salida: "8" }, claude: { entrada: "", salida: "" } };
const conUso = (extra = {}) => ({
  id: Date.UTC(2026, 9, 1), tramos: [{ estado: "ok", uso: { entrada: 1000000, salida: 100000 } }], ...extra,
});

test("precioValido acepta coma o punto, y vacío es «sin precio», no cero", () => {
  assert.strictEqual(comun.precioValido("0,30"), 0.3);
  assert.strictEqual(comun.precioValido("2.5"), 2.5);
  assert.strictEqual(comun.precioValido("0"), 0, "la capa gratuita es un precio de verdad: 0");
  assert.strictEqual(comun.precioValido(""), null);
  assert.strictEqual(comun.precioValido(undefined), null);
  assert.strictEqual(comun.precioValido("abc"), null);
  assert.strictEqual(comun.precioValido("-1"), null);
});

test("transcribir se cobra al precio del AUDIO de Gemini; la salida, al de salida", () => {
  const c = comun.costeReunion(conUso(), PRECIOS);
  assert.ok(Math.abs(c.euros - (1 + 0.25)) < 1e-9, String(c.euros));
  assert.deepStrictEqual(c.faltan, []);
  assert.strictEqual(c.tokens, 1100000);
});

test("cada acta y pregunta se cobra con su proveedor; las de versiones antiguas también", () => {
  const h = conUso({ tramos: [], usoIA: [
    { clave: "acta·gpt", entrada: 500000, salida: 0 },        // 1 €
    { clave: "pregunta·gemini", entrada: 1000000, salida: 0 }, // 0,30 € (texto, no audio)
    { clave: "gemini", entrada: 0, salida: 1000000 },          // acta de la 3.1: 2,5 €
  ] });
  const c = comun.costeReunion(h, PRECIOS);
  assert.ok(Math.abs(c.euros - 3.8) < 1e-9, String(c.euros));
});

test("si falta el precio de un proveedor usado, se suma lo demás y se dice cuál falta", () => {
  const h = conUso({ usoIA: [{ clave: "acta·claude", entrada: 1000, salida: 1000 }] });
  const c = comun.costeReunion(h, PRECIOS);
  assert.ok(Math.abs(c.euros - 1.25) < 1e-9);
  assert.deepStrictEqual(c.faltan, ["claude"]);
});

test("sin ningún precio, o sin tokens apuntados, el coste es desconocido (null), nunca 0", () => {
  assert.strictEqual(comun.costeReunion(conUso(), {}).euros, null);
  assert.strictEqual(comun.costeReunion(conUso(), undefined).euros, null);
  assert.strictEqual(comun.costeReunion({ id: 1, tramos: [{ estado: "ok", texto: "de la 3.1, sin uso" }] }, PRECIOS).euros, null);
  const gratis = { gemini: { audio: "0", entrada: "0", salida: "0" } };
  assert.strictEqual(comun.costeReunion(conUso(), gratis).euros, 0, "con precio 0 sí es 0 de verdad");
});

test("costeMes suma las reuniones del mes en curso y cuenta las que tienen coste", () => {
  const ahora = new Date(2026, 9, 20).getTime();
  const hist = [
    conUso({ id: new Date(2026, 9, 1, 10).getTime() }),
    conUso({ id: new Date(2026, 9, 15, 10).getTime() }),
    conUso({ id: new Date(2026, 8, 30, 10).getTime() }), // septiembre: fuera
    { id: new Date(2026, 9, 2).getTime(), tramos: [] },   // sin uso: no suma ni cuenta
  ];
  const m = comun.costeMes(hist, PRECIOS, ahora);
  assert.ok(Math.abs(m.euros - 2.5) < 1e-9, String(m.euros));
  assert.strictEqual(m.reuniones, 2);
  assert.strictEqual(comun.costeMes(hist, {}, ahora).euros, null);
});

test("formatoEuros: céntimos legibles y nada de «0,00 €» engañoso", () => {
  assert.strictEqual(comun.formatoEuros(1.2345), "1,23 €");
  assert.strictEqual(comun.formatoEuros(0.042), "0,04 €");
  assert.strictEqual(comun.formatoEuros(0.0004), "menos de 1 céntimo");
  assert.strictEqual(comun.formatoEuros(0), "0 €");
});

grupo("3.5 · aviso al entrar en una reunión");

test("plataformaReunion reconoce una sala de reunión, no la portada de cada web", () => {
  const p = comun.plataformaReunion;
  assert.strictEqual(p("https://meet.google.com/abc-defg-hij"), "Google Meet");
  assert.strictEqual(p("https://meet.google.com/abc-defg-hij?authuser=1"), "Google Meet");
  assert.strictEqual(p("https://meet.google.com/"), "");
  assert.strictEqual(p("https://meet.google.com/landing"), "");
  assert.strictEqual(p("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0"), "Microsoft Teams");
  assert.strictEqual(p("https://teams.live.com/meet/9876543210"), "Microsoft Teams");
  assert.strictEqual(p("https://teams.microsoft.com/v2/"), "");
  assert.strictEqual(p("https://app.zoom.us/wc/81234567890/join"), "Zoom");
  assert.strictEqual(p("https://us02web.zoom.us/wc/81234567890/start"), "Zoom");
  assert.strictEqual(p("https://zoom.us/pricing"), "");
  assert.strictEqual(p("https://kmeet.infomaniak.com/sala-de-ditay"), "kMeet de Infomaniak");
  assert.strictEqual(p("https://kmeet.infomaniak.com/"), "");
  assert.strictEqual(p("https://meet.jit.si/ReunionSemanal"), "Jitsi Meet");
  assert.strictEqual(p("https://www.youtube.com/watch?v=x"), "");
  assert.strictEqual(p(undefined), "");
});

test("el manifest pide como opcionales justo las webs que se reconocen y los hosts opcionales de las IA encendidas", () => {
  const m = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "manifest.json"), "utf8"));
  global.chrome = nuevoChrome();
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  const { origenesProveedores } = require("../proveedores.js");
  assert.deepStrictEqual([...m.optional_host_permissions].sort(), [...cfg.ORIGENES_REUNION, ...origenesProveedores()].sort());
  assert.ok(!(m.host_permissions || []).some((o) => /meet|teams|zoom|jit\.si/.test(o)), "no se piden de entrada: solo al activar el aviso");
  // El aviso de reunión pide las webs de reunión, y solo esas: ningún host de IA va en ese lote.
  assert.deepStrictEqual(cfg.ORIGENES_REUNION.filter((o) => origenesProveedores().includes(o)), []);
});

const enMeet = { id: 5, windowId: 7, url: "https://meet.google.com/abc-defg-hij", title: "Meet" };

test("con el aviso activado, entrar en una reunión avisa una sola vez y dice cómo grabar", async () => {
  const { chrome } = bg({ sync: { avisoReunion: true } });
  for (const f of chrome._oyentes.pestana) f(5, { status: "complete" }, enMeet);
  await hasta(() => chrome._registro.notificaciones.length === 1, "el aviso");
  const n = chrome._registro.notificaciones[0];
  assert.strictEqual(n.id, "escriba-reunion-5");
  assert.match(n.message, /Google Meet/);
  assert.match(n.message, /Alt\+Shift\+G/, "con el atajo de verdad, leído de Chrome");
  for (const f of chrome._oyentes.pestana) f(5, { status: "complete" }, enMeet);
  await espera0(); await espera0(); await espera0();
  assert.strictEqual(chrome._registro.notificaciones.length, 1, "la misma reunión no se avisa dos veces");
});

test("sin atajo asignado, el aviso solo habla del icono", async () => {
  const { chrome } = bg({ sync: { avisoReunion: true }, atajos: [{ name: "grabar", shortcut: "" }] });
  for (const f of chrome._oyentes.pestana) f(5, { status: "complete" }, enMeet);
  await hasta(() => chrome._registro.notificaciones.length === 1, "el aviso");
  assert.match(chrome._registro.notificaciones[0].message, /icono/);
  assert.doesNotMatch(chrome._registro.notificaciones[0].message, /Alt\+/);
});

test("apagado (por defecto), grabando ya, o fuera de una reunión, no avisa", async () => {
  for (const op of [{}, { sync: { avisoReunion: true }, session: { grabando: true } }]) {
    const { chrome } = bg(op);
    for (const f of chrome._oyentes.pestana) f(5, { status: "complete" }, enMeet);
    await espera0(); await espera0(); await espera0(); await espera0();
    assert.strictEqual(chrome._registro.notificaciones.length, 0, JSON.stringify(op));
  }
  const { chrome } = bg({ sync: { avisoReunion: true } });
  for (const f of chrome._oyentes.pestana) f(6, { status: "complete" }, { id: 6, url: "https://www.youtube.com/" });
  await espera0(); await espera0(); await espera0();
  assert.strictEqual(chrome._registro.notificaciones.length, 0);
});

test("pulsar el aviso pone delante la pestaña de la reunión", async () => {
  const { chrome } = bg({ sync: { avisoReunion: true } });
  for (const f of chrome._oyentes.clicAviso) f("escriba-reunion-5");
  await hasta(() => chrome._registro.ventanasEnfocadas.length === 1, "que se enfocara la ventana");
  assert.deepStrictEqual(chrome._registro.pestanasActivadas[0], { id: 5, active: true });
  assert.deepStrictEqual(chrome._registro.ventanasEnfocadas[0], { id: 7, focused: true });
});

grupo("3.5 · interfaz en español e inglés (i18n.js)");

const i18n = require("../i18n.js");
const fsT = require("fs"), pathT = require("path");
const RAIZ_EXT = pathT.join(__dirname, "..");
const placeholders = (s) => (String(s).match(/\{\d\}/g) || []).sort().join("");

test("t() sustituye {1}, {2}…, y una clave que no existe se ve tal cual (nunca vacía)", () => {
  i18n._ponIdioma("es");
  i18n.TEXTOS.es["prueba.x"] = "Hola {1}, tienes {2}";
  i18n.TEXTOS.en["prueba.x"] = "Hi {1}, you have {2}";
  assert.strictEqual(i18n.t("prueba.x", "Ana", 3), "Hola Ana, tienes 3");
  i18n._ponIdioma("en");
  assert.strictEqual(i18n.t("prueba.x", "Ana", 3), "Hi Ana, you have 3");
  delete i18n.TEXTOS.en["prueba.x"];
  assert.strictEqual(i18n.t("prueba.x", "Ana", 3), "Hola Ana, tienes 3", "si falta en inglés, sale en español");
  assert.strictEqual(i18n.t("no.existe"), "no.existe");
  delete i18n.TEXTOS.es["prueba.x"];
  i18n._ponIdioma("es");
});

test("idioma del navegador: español también para catalán, gallego y euskera; inglés para el resto", () => {
  const prueba = (l) => { global.chrome = { i18n: { getUILanguage: () => l } }; return i18n.idiomaNavegador(); };
  assert.deepStrictEqual(["es-ES", "es-419", "ca", "gl", "eu", "en-US", "fr", "de", "pt-BR"].map(prueba), ["es", "es", "es", "es", "es", "en", "en", "en", "en"]);
  delete global.chrome;
});

test("el diccionario está completo: las mismas claves en los dos idiomas y los mismos huecos {n}", () => {
  const es = Object.keys(i18n.TEXTOS.es), en = Object.keys(i18n.TEXTOS.en);
  assert.deepStrictEqual(es.filter((k) => !(k in i18n.TEXTOS.en)), [], "faltan en inglés");
  assert.deepStrictEqual(en.filter((k) => !(k in i18n.TEXTOS.es)), [], "sobran en inglés");
  const malos = es.filter((k) => placeholders(i18n.TEXTOS.es[k]) !== placeholders(i18n.TEXTOS.en[k]));
  assert.deepStrictEqual(malos, [], "huecos {n} distintos");
  assert.deepStrictEqual(en.filter((k) => !String(i18n.TEXTOS.en[k]).trim()), [], "textos vacíos");
});

test("toda clave que usan el HTML y el JS existe en el diccionario", () => {
  const faltan = [];
  for (const f of fsT.readdirSync(RAIZ_EXT).filter((n) => /\.(html|js)$/.test(n) && n !== "i18n.js")) {
    const src = fsT.readFileSync(pathT.join(RAIZ_EXT, f), "utf8");
    const claves = [
      ...[...src.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label)?="([^"]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bt\(\s*"([a-z]+\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]),
    ];
    for (const k of claves) if (!(k in i18n.TEXTOS.es)) faltan.push(`${f}: ${k}`);
  }
  assert.deepStrictEqual(faltan, []);
});

test("cada página carga i18n.js antes que ningún otro script, y el service worker también", () => {
  for (const f of fsT.readdirSync(RAIZ_EXT).filter((n) => n.endsWith(".html"))) {
    const scripts = [...fsT.readFileSync(pathT.join(RAIZ_EXT, f), "utf8").matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    if (scripts.length) assert.strictEqual(scripts[0], "i18n.js", f);
  }
  assert.match(fsT.readFileSync(pathT.join(RAIZ_EXT, "background.js"), "utf8"), /importScripts\("i18n\.js"/);
});

test("REGRESIÓN 01/10: sin chrome.i18n (documento offscreen) el idioma sale de navigator.language, no se cae al español", () => {
  const antes = Object.getOwnPropertyDescriptor(global, "navigator");
  global.chrome = { runtime: {} }; // el offscreen solo tiene chrome.runtime
  Object.defineProperty(global, "navigator", { value: { language: "en-US" }, configurable: true });
  assert.strictEqual(i18n.idiomaNavegador(), "en");
  Object.defineProperty(global, "navigator", { value: { language: "ca-ES" }, configurable: true });
  assert.strictEqual(i18n.idiomaNavegador(), "es");
  delete global.chrome;
  if (antes) Object.defineProperty(global, "navigator", antes); else delete global.navigator;
});

test("las etiquetas genéricas salen en el idioma de la interfaz, debajo de los nombres puestos", () => {
  const txt = "[00:01] Hablante 1: hola\n[00:02] Speaker 2: hi\n[00:03] Marta: buenas\n[00:04] Hablante 3: adiós";
  i18n._ponIdioma("en");
  assert.deepStrictEqual({ ...comun.mapaVisible(txt, { "Hablante 3": "Luis" }) }, { "Hablante 1": "Speaker 1", "Hablante 3": "Luis" });
  i18n._ponIdioma("es");
  assert.deepStrictEqual({ ...comun.mapaVisible(txt, {}) }, { "Speaker 2": "Hablante 2" }, "y al revés en español");
  assert.match(comun.construirMarkdown({ fecha: "x", tramos: [{ estado: "ok", texto: "[00:01] Speaker 1: hi" }] }), /\[00:01\] Hablante 1: hi/);
});

test("el tramo siguiente recibe cómo terminaba el anterior, para seguir con las mismas etiquetas", async () => {
  const reloj = { t: 5000000 };
  const base = fetchPorTramo({
    1: [respGemini("[00:01] Hablante 1: empezamos con el presupuesto\n[04:58] Hablante 2: y yo cierro el punto")],
    2: [respGemini("[00:02] Hablante 2: sigo")],
  });
  const prompts = [];
  const f = async (url, opts = {}) => { prompts.push(JSON.parse(opts.body || "{}").contents?.[0]?.parts?.[0]?.text || ""); return base(url, opts); };
  const s = sistemaGrabando({ fetch: f, reloj });
  await s.off.start({ modo: "mic" });
  const id = s.historial()[0].id;
  reloj.t += comun.DURACION_TRAMO_S * 1000;
  s.off.cortaTramo();
  await hasta(() => ((s.entrada(id).tramos || [])[0] || {}).estado === "ok", "el tramo 1 en vivo");
  s.off.stop();
  await hasta(() => s.entrada(id).estado === "ok", "que terminara");
  const p1 = prompts.find((p) => /TRAMO 1 /.test(p)), p2 = prompts.find((p) => /TRAMO 2 /.test(p));
  assert.match(p2, /y yo cierro el punto/, "lleva el final del tramo 1");
  assert.match(p2, /NO lo repitas/);
  assert.doesNotMatch(p1, /terminaba el tramo anterior/, "el primero no tiene anterior");
});

test("el prompt pide la etiqueta genérica en el idioma de la interfaz", () => {
  const off = offscreen(nuevoFetch([]));
  i18n._ponIdioma("es");
  assert.match(off.construirPrompt("", 1, 1, {}), /"\[MM:SS\] Hablante 1: texto"/);
});

test("la fecha de una reunión: en español la guardada; en inglés se rehace, que 01/10 sería 10 de enero", () => {
  const h = { id: new Date(2026, 9, 1, 22, 11).getTime(), fecha: "01/10/2026 22:11" };
  i18n._ponIdioma("es");
  assert.strictEqual(comun.fechaVisible(h), "01/10/2026 22:11");
  i18n._ponIdioma("en");
  assert.match(comun.fechaVisible(h), /^Oct 1, 2026/);
  assert.strictEqual(comun.fechaVisible({ fecha: "sin id" }), "sin id", "sin marca de tiempo, la guardada");
  i18n._ponIdioma("es");
});

// ============================================================================
grupo("3.6 · interfaz: estilo.css, iconos.svg y ui.js");

const PAGINAS = ["popup.html", "reuniones.html", "vivo.html", "options.html", "importar.html"];
const leeExt = (f) => fsT.readFileSync(pathT.join(RAIZ_EXT, f), "utf8");

// Bloque `selector { … }` de una hoja de estilos, con sus llaves anidadas.
function bloqueCss(css, selector) {
  const i = css.indexOf(selector + " {");
  assert.ok(i >= 0, "no está el bloque " + selector);
  let j = css.indexOf("{", i) + 1, prof = 1, k = j;
  while (prof) { if (css[k] === "{") prof++; else if (css[k] === "}") prof--; k++; }
  return css.slice(j, k - 1);
}
const tokensCss = (txt) => Object.fromEntries([...txt.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
// Contraste WCAG 2.x entre dos colores #rrggbb.
function contraste(a, b) {
  const lum = (hex) => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("cada página carga i18n.js, después ui.js (el tema, antes de pintar) y la hoja común estilo.css", () => {
  for (const f of PAGINAS) {
    const html = leeExt(f);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(scripts.slice(0, 2), ["i18n.js", "ui.js"], f);
    const cabeza = html.slice(0, html.indexOf("</head>"));
    assert.match(cabeza, /<script src="ui\.js"><\/script>/, f + ": ui.js va en el <head>");
    assert.match(cabeza, /<link rel="stylesheet" href="estilo\.css">/, f);
  }
});

test("todo icono que usan el HTML y el JS existe en iconos.svg", () => {
  const simbolos = new Set([...leeExt("iconos.svg").matchAll(/<symbol id="([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(simbolos.size > 40, "el sprite tiene sus iconos");
  const usados = new Map();
  const apunta = (f, n) => { if (!usados.has(n)) usados.set(n, f); };
  for (const f of [...PAGINAS, "popup.js", "reuniones.js", "vivo.js", "options.js", "importar.js", "ui.js"]) {
    const src = leeExt(f);
    for (const m of src.matchAll(/iconos\.svg#([a-z-]+)/g)) apunta(f, m[1]);
    for (const m of src.matchAll(/icono\(\s*"([a-z-]+)"/g)) apunta(f, m[1]);
    for (const m of src.matchAll(/icono\([^()]*\?\s*"([a-z-]+)"\s*:\s*"([a-z-]+)"/g)) { apunta(f, m[1]); apunta(f, m[2]); }
    for (const m of src.matchAll(/\b(?:icono|ic):\s*"([a-z-]+)"/g)) apunta(f, m[1]);
    for (const m of src.matchAll(/(?:ponAviso|avisoHtml)\([^;]*?,\s*"([a-z-]+)"\)/g)) apunta(f, m[1]);
    const mapa = src.match(/ICONO_PLANTILLA = \{([^}]*)\}/);
    if (mapa) for (const m of mapa[1].matchAll(/"([a-z-]+)"/g)) apunta(f, m[1]);
  }
  for (const m of leeExt("ui.js").match(/function iconoDeTipo[\s\S]*?\}\[tipo\]/)[0].matchAll(/:\s*"([a-z-]+)"/g)) apunta("ui.js", m[1]);
  assert.ok(usados.size > 40, "se encuentran los iconos usados (" + usados.size + ")");
  const faltan = [...usados].filter(([n]) => !simbolos.has(n)).map(([n, f]) => `${f}: ${n}`);
  assert.deepStrictEqual(faltan, []);
});

test("ningún texto de la interfaz empieza por un emoji: el icono lo pone el HTML", () => {
  const emoji = /^\s*\p{Extended_Pictographic}/u;
  // Las líneas del diagnóstico son un informe para copiar y pegar: ahí sí.
  const permitidos = new Set(["pop.diag0kb", "pop.diagSilencio"]);
  const malos = [];
  for (const idioma of ["es", "en"]) {
    for (const [k, v] of Object.entries(i18n.TEXTOS[idioma])) {
      if (/^(pop|bib|viv|opc|imp|ui)\./.test(k) && !permitidos.has(k) && emoji.test(v)) malos.push(`${idioma} ${k}: ${v.slice(0, 30)}`);
    }
  }
  assert.deepStrictEqual(malos, []);
  for (const f of PAGINAS) assert.doesNotMatch(leeExt(f), /\p{Extended_Pictographic}/u, f + " no lleva emojis");
});

test("claro y oscuro definen los mismos colores, y el oscuro del sistema es igual que el elegido", () => {
  const css = leeExt("estilo.css");
  const claro = tokensCss(bloqueCss(css, ":root"));
  const oscuro = tokensCss(bloqueCss(css, ':root[data-tema="oscuro"]'));
  const sistema = tokensCss(bloqueCss(bloqueCss(css, "@media (prefers-color-scheme: dark)"), ':root:not([data-tema="claro"])'));
  const colores = Object.keys(claro).filter((k) => /^(#|rgba)/.test(claro[k]));
  assert.ok(colores.length > 40);
  assert.deepStrictEqual(colores.filter((k) => !(k in oscuro)), [], "colores sin versión oscura");
  assert.deepStrictEqual(sistema, oscuro, "el oscuro por @media y el de data-tema deben ser el mismo");
});

test("contraste WCAG AA (≥ 4,5:1) de cada texto sobre su fondo, en claro y en oscuro", () => {
  const css = leeExt("estilo.css");
  const temas = { claro: tokensCss(bloqueCss(css, ":root")), oscuro: tokensCss(bloqueCss(css, ':root[data-tema="oscuro"]')) };
  const pares = [
    ["texto", "fondo"], ["texto", "superficie"], ["texto", "superficie-2"], ["texto", "marca-suave"],
    ["texto-2", "fondo"], ["texto-2", "superficie"], ["texto-2", "superficie-2"], ["texto-2", "superficie-3"],
    ["texto-3", "fondo"], ["texto-3", "superficie"], ["texto-3", "superficie-2"],
    ["marca-texto", "fondo"], ["marca-texto", "superficie"], ["marca-texto", "marca-suave"],
    ["sobre-marca", "marca"], ["sobre-marca", "marca-hover"], ["sobre-grabando", "grabando"], ["sobre-grabando", "grabando-hover"],
    ["ok", "ok-suave"], ["ok", "superficie"], ["atencion", "atencion-suave"], ["atencion", "superficie"],
    ["error", "error-suave"], ["error", "superficie"], ["error", "grabando-suave"],
    ["texto", "atencion-suave"], ["texto", "error-suave"], ["texto", "ok-suave"], ["texto", "info-suave"],
    ["sobre-resaltado", "resaltado"], ["sobre-resaltado", "resaltado-actual"],
    // Cada voz: su nombre sobre la tarjeta y la inicial sobre su círculo.
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [["voz-" + i, "superficie"], ["superficie", "voz-" + i]]),
  ];
  const bajos = [];
  for (const [nombre, tk] of Object.entries(temas)) {
    for (const [a, b] of pares) {
      const r = contraste(tk[a], tk[b]);
      if (!(r >= 4.5)) bajos.push(`${nombre}: ${a} sobre ${b} = ${r.toFixed(2)}`);
    }
  }
  assert.deepStrictEqual(bajos, []);
});

function contextoUI() {
  const guardado = {};
  const raiz = { dataset: {} };
  const ctx = cargar("ui.js", {
    document: { documentElement: raiz, addEventListener() {}, querySelector: () => null },
    localStorage: { getItem: (k) => (k in guardado ? guardado[k] : null), setItem: (k, v) => { guardado[k] = String(v); } },
  });
  return { ctx, raiz, guardado };
}

test("tema: «claro» y «oscuro» se marcan en <html> y se recuerdan; cualquier otra cosa es «auto»", () => {
  const { ctx, raiz, guardado } = contextoUI();
  assert.strictEqual(raiz.dataset.tema, undefined, "sin nada guardado, el del sistema");
  assert.strictEqual(ctx.ponTema("oscuro"), "oscuro");
  assert.strictEqual(raiz.dataset.tema, "oscuro");
  assert.strictEqual(guardado["escriba.tema"], "oscuro");
  ctx.ponTema("claro");
  assert.strictEqual(raiz.dataset.tema, "claro");
  assert.strictEqual(ctx.ponTema("rosa"), "auto");
  assert.strictEqual(raiz.dataset.tema, undefined);
  assert.strictEqual(guardado["escriba.tema"], "auto");
  const cfg = require("../config.js");
  assert.strictEqual(cfg.CFG_SYNC.tema, "auto", "se sincroniza: no es un secreto");
  assert.ok(!("tema" in cfg.CFG_LOCAL));
});

test("fechas de la lista: hoy, ayer, esta semana y por meses; y la inicial de cada voz", () => {
  const { ctx } = contextoUI();
  const ahora = new Date();
  const hoy = (h, m) => new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), h, m).getTime();
  const haceDias = (n, h, m) => new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - n, h, m).getTime();
  assert.strictEqual(ctx.fechaCorta({ id: hoy(0, 5) }), "Hoy, 00:05");
  assert.strictEqual(ctx.fechaCorta({ id: haceDias(1, 17, 5) }), "Ayer, 17:05");
  assert.strictEqual(ctx.fechaCorta({ fecha: "29/09/2026 09:15" }), "29/09/2026 09:15", "sin marca de tiempo, la guardada");
  assert.strictEqual(ctx.grupoDeFecha({ id: hoy(0, 5) }).clave, "hoy");
  assert.strictEqual(ctx.grupoDeFecha({ id: haceDias(1, 23, 59) }).clave, "ayer");
  const viejo = ctx.grupoDeFecha({ id: haceDias(40, 12, 0) });
  assert.match(viejo.clave, /^\d{4}-\d{1,2}$/);
  assert.match(viejo.nombre, /^\p{Lu}/u, "el mes, con mayúscula");
  // El lunes de esta semana, si no es hoy ni ayer, va en «esta semana».
  const lunes = haceDias((ahora.getDay() + 6) % 7, 0, 30);
  if (lunes < haceDias(1, 0, 0)) assert.strictEqual(ctx.grupoDeFecha({ id: lunes }).clave, "semana");
  ctx.ponIdiomaUI("en");
  assert.match(ctx.fechaCorta({ id: haceDias(1, 17, 5) }), /^Yesterday, 0?5:05[\s ]PM$/u, "el espacio antes de PM cambia según la versión de ICU");
  ctx.ponIdiomaUI("es");
  assert.strictEqual(ctx.inicialDe("Hablante 2"), "2");
  assert.strictEqual(ctx.inicialDe("Speaker 12"), "12");
  assert.strictEqual(ctx.inicialDe("álvaro"), "Á");
  assert.strictEqual(ctx.inicialDe(""), "?");
});

test("el nivel de audio: silencio, bajo y bueno, con el nombre de la fuente en su idioma", () => {
  const { ctx } = contextoUI();
  const ancho = (html) => Number(html.match(/width:(\d+)%/)[1]);
  const mudo = ctx.htmlNivel({ nombre: "pestaña", rms: 0 });
  assert.strictEqual(ancho(mudo), 0);
  assert.match(mudo, /barra-nivel mudo/);
  assert.match(mudo, /Pestaña/);
  const bajo = ctx.htmlNivel({ nombre: "micrófono", rms: 0.003 }); // ≈ -50 dB
  assert.match(bajo, /barra-nivel bajo/);
  assert.match(bajo, /Micro/);
  const bueno = ctx.htmlNivel({ nombre: "pestaña", rms: 0.1 }); // -20 dB
  assert.strictEqual(ancho(bueno), 80);
  assert.match(bueno, /barra-nivel "/);
  assert.strictEqual(ancho(ctx.htmlNivel({ nombre: "pestaña", rms: 1 })), 100, "no se pasa del 100 %");
});

test("escapa() no deja pasar HTML: los títulos y textos del modelo nunca se ejecutan", () => {
  const { ctx } = contextoUI();
  assert.strictEqual(ctx.escapa('<img src=x onerror="alert(1)">&'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  assert.strictEqual(ctx.escapa(null), "");
  assert.match(ctx.icono("micro", "g"), /^<svg class="i g" aria-hidden="true"><use href="iconos\.svg#micro"><\/use><\/svg>$/);
});

test("precios de referencia (3.6.1): el modelo de cada proveedor, en euros y con su fecha", () => {
  const cfg = require("../config.js");
  assert.match(cfg.PRECIOS_REFERENCIA.fecha, /^\d{4}-\d{2}-\d{2}$/, "con la fecha en que se copiaron");
  const otono = new Date(2026, 9, 2), invierno = new Date(2027, 0, 1, 9);
  // Gemini Flash: 0,75 $ hasta fin de 2026 y el doble desde el 1 de enero.
  assert.deepStrictEqual({ ...cfg.precioReferencia("gemini", "gemini-flash-latest", otono) }, { audio: 0.652, entrada: 0.652, salida: 3.261 });
  assert.deepStrictEqual({ ...cfg.precioReferencia("gemini", "gemini-flash-latest", invierno) }, { audio: 1.304, entrada: 1.304, salida: 6.522 });
  // Las variantes antes que el modelo base: «lite» no cobra como Flash, ni «mini» como GPT-4o.
  assert.strictEqual(cfg.precioReferencia("gemini", "gemini-flash-lite-latest", otono).salida, 2.174);
  assert.strictEqual(cfg.precioReferencia("gemini", "gemini-2.5-flash", otono).audio, 0.87, "en 2.5 el audio cuesta más que el texto");
  assert.strictEqual(cfg.precioReferencia("gemini", "gemini-2.5-flash", otono).entrada, 0.261);
  assert.deepStrictEqual({ ...cfg.precioReferencia("gpt", "gpt-4o-mini") }, { entrada: 0.13, salida: 0.522 });
  assert.deepStrictEqual({ ...cfg.precioReferencia("gpt", "gpt-4o") }, { entrada: 2.174, salida: 8.696 });
  assert.deepStrictEqual({ ...cfg.precioReferencia("claude", cfg.CFG_LOCAL.claudeModel) }, { entrada: 1.739, salida: 8.696 });
  assert.strictEqual(cfg.precioReferencia("claude", "claude-opus-5-5").entrada, 3.478, "Opus 5.5 es más barato que los Opus anteriores");
  assert.strictEqual(cfg.precioReferencia("claude", "claude-opus-4-8").entrada, 4.348);
  // Sin referencia, null: no se inventa un precio.
  assert.strictEqual(cfg.precioReferencia("gpt", "o3-pro"), null);
  assert.strictEqual(cfg.precioReferencia("gemini", "gemini-2.0-flash"), null);
  assert.strictEqual(cfg.precioReferencia("nadie", "x"), null);
  // Lo que se carga lo entiende el cálculo del coste.
  const p = cfg.precioReferencia("gemini", "gemini-flash-latest", otono);
  const h = { tramos: [{ estado: "ok", uso: { entrada: 1e6, salida: 1e5 } }] };
  const c = comun.costeReunion(h, { gemini: { audio: String(p.audio).replace(".", ","), entrada: "", salida: String(p.salida) } });
  assert.ok(Math.abs(c.euros - (0.652 + 0.3261)) < 1e-6, "un millón de audio y cien mil de salida: " + c.euros);
});

// ============================================================================
// 3.8 — otros proveedores de IA (docs/2026-10-05-plan-proveedores.md)
// ============================================================================
grupo("3.8 · registro de proveedores (proveedores.js)");

const prov = require("../proveedores.js");
const IDS_PROV = ["gemini", "gpt", "claude", "mistral", "groq", "deepseek", "openrouter"];

// «Solo se enseña lo probado con una clave real», pero lo que todavía no se
// enseña también se prueba: cada test lo enciende en SU contexto, con el
// registro que hay cargado allí. encender(ctx, "groq.chat", "groq.voz").
function encender(ctx, ...capacidades) {
  const registro = registroDe(ctx);
  for (const c of capacidades) {
    const [id, capacidad] = c.split(".");
    registro[id][capacidad].activo = true;
  }
  return ctx;
}
const TODO_EL_TEXTO = IDS_PROV.map((id) => id + ".chat");
const TODA_LA_VOZ = ["gemini.voz", "gpt.voz", "mistral.voz", "groq.voz"];

test("estado de salida: encendido solo lo probado con una clave real (Gemini entero, y el texto de GPT y Claude)", () => {
  // [texto, voz]; null es que su API no hace eso. Cambiar una línea de aquí es
  // decir que ese proveedor se ha probado de punta a punta con una clave de verdad.
  const salida = {
    gemini: [true, true], gpt: [true, false], claude: [true, null],
    mistral: [false, false], groq: [false, false], deepseek: [false, null], openrouter: [false, null],
  };
  assert.deepStrictEqual(Object.keys(prov.PROVEEDORES), IDS_PROV, "Meta no entra en esta versión");
  for (const [id, [texto, voz]] of Object.entries(salida)) {
    const p = prov.PROVEEDORES[id];
    assert.strictEqual(p.id, id);
    assert.strictEqual(p.chat.activo, texto, id + ": texto");
    assert.strictEqual(p.voz ? p.voz.activo : null, voz, id + ": voz");
  }
  const ctx = cargar("proveedores.js");
  assert.deepStrictEqual([...ctx.provsQueTranscriben()], ["gemini"]);
  assert.deepStrictEqual([...ctx.provsQueRedactan()], ["gemini", "gpt", "claude"]);
  assert.deepStrictEqual([...ctx.provsVisibles()], ["gemini", "gpt", "claude"]);
});

test("los ids valen para el historial y para un nombre de fichero, y los dos órdenes no se dejan a nadie", () => {
  for (const id of IDS_PROV) assert.match(id, /^[a-z]+$/, "sin «·», espacios ni mayúsculas: " + id);
  const conVoz = IDS_PROV.filter((id) => prov.PROVEEDORES[id].voz);
  assert.deepStrictEqual([...prov.ORDEN_VOZ].sort(), [...conVoz].sort(), "ORDEN_VOZ son los que tienen voz");
  assert.deepStrictEqual([...prov.ORDEN_TEXTO].sort(), [...IDS_PROV].sort(), "ORDEN_TEXTO son todos");
  assert.strictEqual(prov.ORDEN_VOZ[0], "gemini", "con clave de Gemini, sigue transcribiendo Gemini");
  assert.strictEqual(prov.ORDEN_TEXTO[0], "gemini");
});

test("cada proveedor tiene sus campos en CFG_LOCAL con el modelo por defecto del registro, y ninguna clave en CFG_SYNC", () => {
  global.chrome = nuevoChrome();
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  for (const p of Object.values(prov.PROVEEDORES)) {
    assert.strictEqual(cfg.CFG_LOCAL[p.campoClave], "", p.id + ": la clave, vacía de entrada");
    assert.ok(!(p.campoClave in cfg.CFG_SYNC), p.id + ": una clave de API NUNCA va en storage.sync");
    // Vacío es «lo elige Opciones con la clave delante» (Gemini); si no, el del registro.
    assert.ok([p.chat.modelo, ""].includes(cfg.CFG_LOCAL[p.campoModelo]), p.id + ": modelo de actas " + cfg.CFG_LOCAL[p.campoModelo]);
    assert.ok(!(p.campoModelo in cfg.CFG_SYNC), p.id);
    if (p.voz) assert.ok([p.voz.modelos[0], ""].includes(cfg.CFG_LOCAL[p.campoVoz]), p.id + ": modelo de voz " + cfg.CFG_LOCAL[p.campoVoz]);
    else assert.strictEqual(p.campoVoz, undefined, p.id + " no transcribe: no tiene modelo de voz");
  }
  const delRegistro = new Set(Object.values(prov.PROVEEDORES).flatMap((p) => [p.campoClave, p.campoModelo, p.campoVoz]));
  const sueltos = Object.keys(cfg.CFG_LOCAL).filter((k) => /(Key|Model|Voz)$/.test(k) && !delRegistro.has(k));
  assert.deepStrictEqual(sueltos, [], "campos de un proveedor que el registro no conoce");
  // Lo que ya funciona no cambia de modelo sin poder probarlo.
  assert.strictEqual(cfg.CFG_LOCAL.openaiModel, "gpt-4o");
  assert.strictEqual(cfg.CFG_LOCAL.claudeModel, "claude-sonnet-5");
  assert.strictEqual(cfg.CFG_LOCAL.provTranscribe, "auto");
  assert.strictEqual(cfg.CFG_SYNC.grabarSinClave, false, "grabar sin clave hay que pedirlo");
});

test("las claves y la elección de los proveedores nuevos se guardan en local, nunca en sync", async () => {
  const chrome = nuevoChrome();
  global.chrome = chrome;
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  await cfg.guardarConfig({ mistralKey: "M", groqKey: "Q", deepseekKey: "D", openrouterKey: "R", groqVoz: "whisper-large-v3-turbo", provTranscribe: "groq", grabarSinClave: true });
  const local = chrome.storage.local._volcado(), sync = chrome.storage.sync._volcado();
  assert.deepStrictEqual([local.mistralKey, local.groqKey, local.deepseekKey, local.openrouterKey, local.groqVoz, local.provTranscribe], ["M", "Q", "D", "R", "whisper-large-v3-turbo", "groq"]);
  assert.deepStrictEqual(Object.keys(sync), ["grabarSinClave"]);
  const leido = await cfg.leerConfig();
  assert.strictEqual(leido.groqKey, "Q");
  assert.strictEqual(leido.mistralModel, "mistral-small-latest", "lo no guardado sale con su valor por defecto");
});

test("cada proveedor tiene sus textos en los dos idiomas, y su ayuda enlaza a donde se saca la clave", () => {
  // Opciones saca estas claves del registro, no las lleva escritas: el test del
  // diccionario, que solo ve los t("…") literales, no las alcanza.
  const usadas = new Set();
  for (const p of Object.values(prov.PROVEEDORES)) {
    assert.ok(p.nombre && p.etiqueta, p.id);
    // El aviso general, el de cuando transcribe y el de cuando redacta.
    const avisos = [p.aviso, p.voz && p.voz.aviso, p.chat.aviso].filter((a) => a !== null && a !== undefined && a !== false);
    for (const idioma of ["es", "en"]) {
      const ayuda = i18n.TEXTOS[idioma][p.ayuda];
      assert.ok(ayuda, `${p.id}: falta la ayuda «${p.ayuda}» en ${idioma}`);
      assert.ok(ayuda.includes(`href="${p.urlClave}"`), `${p.id}: la ayuda en ${idioma} no enlaza a ${p.urlClave}`);
      assert.ok(ayuda.includes('target="_blank"'), `${p.id}: el enlace de la ayuda en ${idioma} se abriría encima de Opciones`);
      for (const a of avisos) {
        assert.ok(i18n.TEXTOS[idioma][a], `${p.id}: falta el aviso «${a}» en ${idioma}`);
        assert.doesNotMatch(i18n.TEXTOS[idioma][a], /[<>]/, `${p.id}: «${a}» se pinta como texto, no lleva HTML`);
      }
    }
    for (const a of [p.ayuda, ...avisos]) { assert.match(a, /^opc\.[A-Za-z0-9]+$/, p.id); usadas.add(a); }
    assert.match(p.urlClave, /^https:\/\//);
    assert.match(p.urlPrecios, /^https:\/\//, p.id + ": dónde publica sus precios (el enlace de «Coste»)");
  }
  // Quien no transcribe lo dice antes de que se le pida.
  for (const p of Object.values(prov.PROVEEDORES)) if (!p.voz) assert.match(i18n.TEXTOS.es[p.aviso], /no transcribe/i, p.id);
  // Y lo que cuenta cómo transcribe o cómo redacta no va en el aviso general: la
  // tarjeta lo enseña solo con esa capacidad encendida.
  for (const p of Object.values(prov.PROVEEDORES)) {
    if (p.voz && p.aviso) assert.doesNotMatch(i18n.TEXTOS.es[p.aviso], /transcrib|audio|hablante/i, `${p.id}: eso va en voz.aviso`);
  }
  // Ningún texto de proveedor se queda en el diccionario sin que el registro lo use.
  const sueltas = Object.keys(i18n.TEXTOS.es).filter((k) => /^opc\.prov(Ayuda|Aviso)/.test(k) && !usadas.has(k));
  assert.deepStrictEqual(sueltas, []);
});

test("proveedorVoz: el elegido si transcribe y tiene clave; con «auto», o sin su clave, el primero que la tenga", () => {
  const ctx = encender(cargar("proveedores.js"), ...TODA_LA_VOZ);
  const voz = (cfg) => ctx.proveedorVoz(cfg);
  assert.strictEqual(voz({}), "", "sin ninguna clave no transcribe nadie");
  assert.strictEqual(voz(undefined), "");
  assert.strictEqual(voz({ geminiKey: "G" }), "gemini");
  assert.strictEqual(voz({ provTranscribe: "auto", openaiKey: "O", groqKey: "Q" }), "groq", "por ORDEN_VOZ, no por el orden de las claves");
  assert.strictEqual(voz({ openaiKey: "O", groqKey: "Q", mistralKey: "M", geminiKey: "G" }), "gemini");
  assert.strictEqual(voz({ provTranscribe: "gpt", openaiKey: "O", geminiKey: "G" }), "gpt", "el elegido manda");
  assert.strictEqual(voz({ provTranscribe: "gpt", geminiKey: "G" }), "gemini", "al elegido le falta la clave: el primero que la tenga");
  assert.strictEqual(voz({ provTranscribe: "claude", claudeKey: "C", mistralKey: "M" }), "mistral", "Claude no transcribe aunque se le elija");
  assert.strictEqual(voz({ provTranscribe: "deepseek", deepseekKey: "D" }), "", "ni DeepSeek");
  assert.strictEqual(voz({ provTranscribe: "ya-no-existe", groqKey: "Q" }), "groq");
  assert.strictEqual(voz({ geminiKey: "   " }), "", "una clave en blanco no es una clave");
});

test("proveedorTexto: el preferido si tiene clave; si no, el primero que la tenga", () => {
  const ctx = encender(cargar("proveedores.js"), ...TODO_EL_TEXTO);
  const texto = (cfg, preferido) => ctx.proveedorTexto(cfg, preferido);
  assert.strictEqual(texto({}, "gemini"), "", "sin ninguna clave no redacta nadie");
  assert.strictEqual(texto(undefined, undefined), "");
  assert.strictEqual(texto({ geminiKey: "G", claudeKey: "C" }, "claude"), "claude");
  assert.strictEqual(texto({ geminiKey: "G", openaiKey: "O" }, "claude"), "gemini", "al preferido le falta la clave");
  assert.strictEqual(texto({ deepseekKey: "D" }, "gemini"), "deepseek", "acta automática sin clave de Gemini: con la que haya");
  assert.strictEqual(texto({ openrouterKey: "R", groqKey: "Q" }), "groq", "sin preferido, por ORDEN_TEXTO");
  assert.strictEqual(texto({ mistralKey: "M" }, "no-existe"), "mistral");
});

test("interruptores: una capacidad apagada no existe, ni en las listas ni al elegir, aunque tenga clave", () => {
  const ctx = cargar("proveedores.js");
  const todas = { geminiKey: "", openaiKey: "O", claudeKey: "C", mistralKey: "M", groqKey: "Q", deepseekKey: "D", openrouterKey: "R" };
  assert.strictEqual(ctx.proveedorVoz({ ...todas, provTranscribe: "groq" }), "", "ni Groq ni Mistral ni OpenAI transcriben todavía");
  assert.strictEqual(ctx.proveedorVoz({ ...todas, geminiKey: "G", provTranscribe: "mistral" }), "gemini");
  assert.strictEqual(ctx.proveedorTexto({ mistralKey: "M", groqKey: "Q", deepseekKey: "D", openrouterKey: "R" }, "groq"), "", "ni redactan");
  assert.strictEqual(ctx.proveedorTexto(todas, "deepseek"), "gpt", "se salta al primero ENCENDIDO con clave");
  for (const id of ["gpt", "mistral", "groq"]) assert.strictEqual(ctx.transcribe(id), false, id);
  for (const id of ["mistral", "groq", "deepseek", "openrouter"]) assert.strictEqual(ctx.redacta(id), false, id);
  assert.strictEqual(ctx.tieneClave(todas, "groq"), true, "tener clave y estar encendido son cosas distintas");
  // Se enciende cambiando el valor del registro, y entonces existe en todas partes.
  encender(ctx, "groq.voz", "deepseek.chat");
  assert.deepStrictEqual([...ctx.provsQueTranscriben()], ["gemini", "groq"]);
  assert.deepStrictEqual([...ctx.provsQueRedactan()], ["gemini", "gpt", "claude", "deepseek"]);
  assert.deepStrictEqual([...ctx.provsVisibles()], ["gemini", "gpt", "claude", "groq", "deepseek"]);
  assert.strictEqual(ctx.proveedorVoz({ ...todas, provTranscribe: "groq" }), "groq");
  assert.strictEqual(ctx.proveedorTexto(todas, "deepseek"), "deepseek");
  // Lo que no es un proveedor no es nada: ni un id inventado ni una propiedad de Object.
  for (const id of ["meta", "constructor", "__proto__", "toString", "", undefined, null]) {
    assert.strictEqual(ctx.transcribe(id), false, String(id));
    assert.strictEqual(ctx.redacta(id), false, String(id));
    assert.strictEqual(ctx.tieneClave({ constructor: "x", undefined: "x" }, id), false, String(id));
  }
});

test("permisos: los tres hosts de siempre son fijos; el de un proveedor nuevo es opcional y solo cuenta cuando se enciende", () => {
  const m = JSON.parse(leeExt("manifest.json"));
  const fijos = Object.values(prov.PROVEEDORES).filter((p) => p.fijo).map((p) => p.host);
  assert.deepStrictEqual([...fijos].sort(), [...m.host_permissions].sort(), "host_permissions no se toca: añadirle un host desactiva la extensión al actualizar");
  // La tienda no admite permisos para funciones que el usuario aún no puede usar:
  // con todo lo nuevo apagado no hay ningún host de proveedor que declarar.
  assert.deepStrictEqual([...prov.origenesProveedores()], [], "estado de salida: ningún proveedor de host opcional encendido. Si has encendido uno (probado con clave real), pon aquí su host");
  const con = (...capacidades) => [...encender(cargar(["proveedores.js"]), ...capacidades).origenesProveedores()];
  assert.deepStrictEqual(con("groq.voz"), ["https://api.groq.com/*"], "al encender una capacidad, su host pasa a ser de los que hay que declarar");
  assert.deepStrictEqual(con("mistral.chat", "deepseek.chat", "openrouter.chat", "groq.chat"), ["https://api.mistral.ai/*", "https://api.groq.com/*", "https://api.deepseek.com/*", "https://openrouter.ai/*"]);
  assert.deepStrictEqual(con("gpt.voz"), [], "los de host fijo no son opcionales nunca");
  for (const p of Object.values(prov.PROVEEDORES)) {
    assert.ok((p.base + "/").startsWith(p.host.slice(0, -1)), `${p.id}: la base ${p.base} no cae dentro de su permiso ${p.host}`);
    assert.ok(!p.base.endsWith("/"), p.id + ": la base va sin barra final");
  }
});

test("detalleErrorApi saca el mensaje de cada API en una línea, y nunca el JSON en crudo", () => {
  const d = prov.detalleErrorApi;
  // OpenAI: el 401 llega como text/plain, con saltos de línea y un `status` suelto.
  assert.strictEqual(d('{\n    "error": {\n        "message": "Incorrect API key provided: sk-inval***-000.",\n        "type": "invalid_request_error",\n        "param": null,\n        "code": "invalid_api_key"\n    },\n    "status": 401\n}'),
    "Incorrect API key provided: sk-inval***-000.");
  assert.strictEqual(d('{"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}'), "API key is invalid.", "Anthropic");
  assert.strictEqual(d('{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}'), "Invalid API Key", "Groq");
  assert.strictEqual(d('{"error":{"message":"No cookie auth credentials found","code":401}}'), "No cookie auth credentials found", "OpenRouter");
  assert.strictEqual(d('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'), "This model is currently experiencing high demand.", "Gemini");
  // Mistral tiene tres formas, y ninguna es la de su documentación.
  assert.strictEqual(d('{"detail":"Invalid API Key"}'), "Invalid API Key");
  assert.strictEqual(d('{"detail":[{"loc":["body","model"],"msg":"Field required","type":"missing"},{"loc":["body","messages",0],"msg":"Input should be a valid dictionary","type":"dict_type"}]}'),
    "body.model: Field required; body.messages.0: Input should be a valid dictionary");
  assert.strictEqual(d('{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300"}'), "Rate limit exceeded");
  assert.strictEqual(d('{"message":"no Route matched with those values","request_id":"abc"}'), "no Route matched with those values");
  // Otras formas: el error como texto, solo el tipo, o con algo delante.
  assert.strictEqual(d('{"error":"Service Unavailable"}'), "Service Unavailable");
  assert.strictEqual(d('{"error":{"type":"overloaded_error"}}'), "overloaded_error");
  assert.strictEqual(d('{"sessionId":"s-1","error":{"message":"Unauthorized","type":"authentication_error","param":null,"code":"invalid_api_key"}}'), "Unauthorized");
  // Sin JSON, o sin nada reconocible, no hay detalle: jamás el cuerpo tal cual.
  for (const cuerpo of ["<html><body>502 Bad Gateway</body></html>", "", "null", "[]", '"texto"', "{}", '{"error":{"message":{"raro":1}}}', '{"detail":[{"loc":["x"]}]}', undefined]) {
    assert.strictEqual(d(cuerpo), "", String(cuerpo));
  }
  const largo = d(JSON.stringify({ error: { message: "línea uno\n  línea dos\t" + "x".repeat(500) } }));
  assert.strictEqual(largo.length, 200, "como mucho 200 caracteres");
  assert.match(largo, /^línea uno línea dos x+$/, "en una sola línea");
});

test("sinSaldo: el 402, y los 429 que en realidad dicen que no queda saldo", () => {
  const s = prov.sinSaldo;
  assert.strictEqual(s(402, '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}'), true, "DeepSeek");
  assert.strictEqual(s(402, "lo que sea"), true, "un 402 lo es diga lo que diga");
  for (const code of ["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]) {
    assert.strictEqual(s(429, JSON.stringify({ error: { message: "x", type: "invalid_request_error", param: null, code } })), true, "OpenAI: " + code);
  }
  assert.strictEqual(s(429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","param":null,"code":null}}'), true, "OpenAI, en `type`");
  assert.strictEqual(s(429, '{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits","details":{"error_code":"enforced_spend_limit_reached"}},"request_id":"req_1"}'), true, "Anthropic");
  // El resto de 429 es ritmo: se arregla esperando.
  assert.strictEqual(s(429, '{"error":{"message":"Slow down","type":"rate_limit_error","param":null,"code":"slow_down"}}'), false);
  assert.strictEqual(s(429, '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'), false);
  assert.strictEqual(s(429, '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300"}'), false, "Mistral");
  assert.strictEqual(s(429, '{"error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}}}'), false, "OpenRouter");
  assert.strictEqual(s(429, "no es JSON"), false);
  assert.strictEqual(s(429, "null"), false);
  // El código solo cuenta dentro de un 429: en otro estado no es saldo.
  assert.strictEqual(s(400, '{"error":{"code":"insufficient_quota"}}'), false);
  assert.strictEqual(s(503, '{"error":{"code":"insufficient_quota"}}'), false);
});

test("esperaPedida lee Retry-After, en segundos o como fecha, con tope; sin cabecera es 0", () => {
  const con = (valor) => respuestaHttp({ status: 429, cabeceras: valor === undefined ? {} : { "Retry-After": valor } });
  assert.strictEqual(prov.esperaPedida(con("12"), 60000), 12000);
  assert.strictEqual(prov.esperaPedida(con("1.5"), 60000), 1500);
  assert.strictEqual(prov.esperaPedida(con("600"), 60000), 60000, "con tope");
  assert.strictEqual(prov.esperaPedida(con("0"), 60000), 0);
  assert.strictEqual(prov.esperaPedida(con(undefined), 60000), 0);
  assert.strictEqual(prov.esperaPedida(con("pronto"), 60000), 0, "lo que no se entiende no es una espera");
  const fecha = prov.esperaPedida(con(new Date(Date.now() + 20000).toUTCString()), 60000);
  assert.ok(fecha > 15000 && fecha <= 20000, "como fecha: " + fecha);
  assert.strictEqual(prov.esperaPedida(con(new Date(Date.now() - 5000).toUTCString()), 60000), 0, "una fecha ya pasada");
  assert.strictEqual(prov.esperaPedida({}, 60000), 0, "una respuesta sin cabeceras no revienta");
  assert.strictEqual(prov.esperaPedida(null, 60000), 0);
});

grupo("3.8 · el registro se carga en todas partes");

test("proveedores.js va después de i18n.js y antes de config.js, comun.js e ia.js: en las páginas, en el offscreen y en el service worker", () => {
  const comprueba = (donde, scripts) => {
    const i = scripts.indexOf("proveedores.js");
    assert.ok(i > scripts.indexOf("i18n.js") && scripts.includes("i18n.js"), donde + ": después de i18n.js");
    for (const f of ["config.js", "comun.js", "ia.js"]) {
      if (scripts.includes(f)) assert.ok(i < scripts.indexOf(f), `${donde}: antes de ${f}`);
    }
  };
  for (const f of [...PAGINAS, "offscreen.html"]) comprueba(f, [...leeExt(f).matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]));
  comprueba("service worker", leeExt("background.js").match(/importScripts\(([^)]*)\)/)[1].match(/[\w.-]+\.js/g));
});

test("ningún script redeclara un nombre de otro con el que comparte página", () => {
  // Los scripts clásicos de una página comparten sus `const`, `let` y `function`
  // de primer nivel: declarar dos veces el mismo nombre es un SyntaxError que
  // deja el segundo fichero ENTERO sin ejecutar (la 3.8 mete PROVEEDORES en todas
  // las páginas, y la biblioteca tenía una constante con ese nombre). Se
  // comprueba con el motor de verdad: los scripts de cada página se declaran por
  // orden en un contexto vacío. El `throw` de delante hace que no llegue a
  // ejecutarse ni una línea: las declaraciones se crean antes de ejecutar.
  const vmT = require("vm");
  const choques = [];
  const juntos = (donde, scripts) => {
    const ctx = vmT.createContext({});
    for (const f of scripts) {
      try {
        vmT.runInContext("throw 0;" + leeExt(f), ctx, { filename: f });
      } catch (e) {
        if (e !== 0) choques.push(`${donde} › ${f}: ${(e && e.message) || e}`);
      }
    }
  };
  for (const f of [...PAGINAS, "offscreen.html"]) juntos(f, [...leeExt(f).matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]));
  juntos("service worker", [...leeExt("background.js").match(/importScripts\(([^)]*)\)/)[1].match(/[\w.-]+\.js/g), "background.js"]);
  assert.deepStrictEqual(choques, []);
});

grupo("3.8 · precios de referencia de los proveedores nuevos (config.js)");

test("precios de referencia: los modelos nuevos de texto, y la voz por minuto de audio", () => {
  const cfg = require("../config.js");
  assert.strictEqual(cfg.PRECIOS_REFERENCIA.fecha, "2026-10-05");
  const ref = (p, m) => ({ ...cfg.precioReferencia(p, m) });
  assert.deepStrictEqual(ref("gpt", "gpt-6-luna"), { entrada: 0.087, salida: 0.435 });
  assert.deepStrictEqual(ref("gpt", "gpt-6.1-sol"), { entrada: 1.739, salida: 8.696 });
  assert.deepStrictEqual(ref("gpt", "gpt-6-astra"), { entrada: 8.696, salida: 43.478 });
  assert.deepStrictEqual(ref("mistral", "mistral-small-latest"), { entrada: 0.13, salida: 0.522 });
  assert.deepStrictEqual(ref("mistral", "mistral-medium-latest"), { entrada: 1.304, salida: 6.522 });
  assert.deepStrictEqual(ref("mistral", "mistral-large-latest"), { entrada: 0.435, salida: 1.304 });
  assert.deepStrictEqual(ref("groq", "openai/gpt-oss-120b"), { entrada: 0.13, salida: 0.522 });
  assert.deepStrictEqual(ref("groq", "openai/gpt-oss-20b"), { entrada: 0.065, salida: 0.261 });
  assert.deepStrictEqual(ref("deepseek", "deepseek-flash"), { entrada: 0.261, salida: 1.043 });
  assert.deepStrictEqual(ref("deepseek", "deepseek-v4-pro"), { entrada: 1.148, salida: 3.443 });
  // La voz fuera de Gemini se cobra por minuto, y son milésimas de euro: 5 decimales.
  assert.deepStrictEqual(ref("gpt", "gpt-transcribe"), { minuto: 0.00391 });
  assert.deepStrictEqual(ref("gpt", "gpt-4o-transcribe-diarize"), { minuto: 0.00522 }, "no se confunde con gpt-4o, que también empieza así");
  assert.deepStrictEqual(ref("gpt", "whisper-1"), { minuto: 0.00522 });
  assert.deepStrictEqual(ref("mistral", "voxtral-mini-latest"), { minuto: 0.00261 });
  assert.deepStrictEqual(ref("groq", "whisper-large-v3"), { minuto: 0.00161 });
  assert.deepStrictEqual(ref("groq", "whisper-large-v3-turbo"), { minuto: 0.00058 }, "el turbo, antes que el normal");
  // Cada modelo por defecto del registro tiene su precio de referencia, menos lo
  // gratuito de OpenRouter y lo que Gemini cobra por tokens (que ya estaba).
  for (const p of Object.values(prov.PROVEEDORES)) {
    if (p.id === "openrouter") { assert.strictEqual(cfg.precioReferencia(p.id, p.chat.modelo), null); continue; }
    for (const m of [p.chat.modelo, ...p.chat.reserva]) assert.ok(typeof cfg.precioReferencia(p.id, m).entrada === "number", `${p.id}: sin precio para ${m}`);
    if (p.voz && p.id !== "gemini") for (const m of p.voz.modelos) assert.ok(typeof cfg.precioReferencia(p.id, m).minuto === "number", `${p.id}: sin precio por minuto para ${m}`);
  }
  // Lo que ya había no se mueve.
  assert.deepStrictEqual(ref("gpt", "gpt-4o"), { entrada: 2.174, salida: 8.696 });
  assert.deepStrictEqual(ref("gpt", "gpt-5-mini"), { entrada: 0.217, salida: 1.739 });
});

grupo("3.8 · acta y preguntas con cualquier proveedor (ia.js)");

// ia.js con lo que haga falta encendido. `esperas` recoge lo que se esperaría
// entre reintentos (aquí no se espera de verdad).
function iaCon(fetchStub, encendidos = [], esperas = []) {
  const ctx = cargar(["proveedores.js", "comun.js", "ia.js"], { fetch: fetchStub, setTimeout: (fn, ms) => { esperas.push(ms); setImmediate(fn); } });
  return encender(ctx, ...encendidos);
}
const cfgTodas = { geminiKey: "G", openaiKey: "O", claudeKey: "C", mistralKey: "M", groqKey: "Q", deepseekKey: "D", openrouterKey: "R" };
const respOpenai = (texto, extra = {}) => ({ cuerpo: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: texto } }], usage: { prompt_tokens: 40, completion_tokens: 6 }, ...extra } });
const respClaude = (texto, extra = {}) => ({ cuerpo: { content: [{ type: "text", text: texto }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 4 }, ...extra } });
const modelosPedidos = (f) => f._llamadas.map((ll) => JSON.parse(ll.opts.body).model);

test("la petición de acta a OpenAI, a Anthropic y a Gemini es idéntica a la de la 3.7.0: URL, cabeceras y cuerpo", async () => {
  // Lo que ya funciona no se toca sin poder probarlo. Estos literales son lo que
  // mandaba la 3.7.0 (be14a15) con el modelo por defecto; se comparan letra a
  // letra, también el orden de las cabeceras y de los campos del cuerpo.
  const de37 = {
    gpt: {
      url: "https://api.openai.com/v1/chat/completions",
      opts: { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer O" } },
      cuerpo: '{"model":"gpt-4o","messages":[{"role":"system","content":"S"},{"role":"user","content":"U"}]}',
      respuesta: respOpenai("ACTA"),
    },
    claude: {
      url: "https://api.anthropic.com/v1/messages",
      opts: { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "C", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } },
      cuerpo: '{"model":"claude-sonnet-5","max_tokens":16384,"system":"S","messages":[{"role":"user","content":"U"}]}',
      respuesta: respClaude("ACTA"),
    },
    gemini: {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      opts: { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": "G" } },
      cuerpo: '{"contents":[{"role":"user","parts":[{"text":"S\\n\\n---\\nU"}]}],"generationConfig":{"temperature":0.3,"maxOutputTokens":32768}}',
      respuesta: respGemini("ACTA"),
    },
  };
  for (const [id, esperado] of Object.entries(de37)) {
    const f = nuevoFetch([esperado.respuesta]);
    const r = await iaCon(f).llamarIA(id, { geminiKey: "G", openaiKey: "O", claudeKey: "C" }, "S", "U");
    assert.strictEqual(r.texto, "ACTA", id);
    assert.strictEqual(f._llamadas.length, 1, id + ": una sola petición");
    const { url, opts } = f._llamadas[0];
    assert.strictEqual(url, esperado.url, id);
    assert.strictEqual(opts.body, esperado.cuerpo, id);
    assert.strictEqual(JSON.stringify({ method: opts.method, headers: opts.headers }), JSON.stringify(esperado.opts), id);
    assert.deepStrictEqual(Object.keys(opts), ["method", "headers", "body"], id + ": nada más en la petición");
  }
  // Con el modelo elegido en Opciones, lo único que cambia es el modelo.
  const f = nuevoFetch([respOpenai("ACTA")]);
  await iaCon(f).llamarIA("gpt", { openaiKey: "O", openaiModel: "gpt-4o-mini" }, "S", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
  assert.strictEqual(f._llamadas[0].opts.body,
    '{"model":"gpt-4o-mini","messages":[{"role":"system","content":"S"},{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":"c"}]}');
});

test("cada proveedor nuevo recibe la petición en su dirección, con su clave, y solo con el modelo y los mensajes", async () => {
  const f = fetchPorUrl({
    "api.mistral.ai": [respOpenai("DE MISTRAL")], "api.groq.com": [respOpenai("DE GROQ")],
    "api.deepseek.com": [respOpenai("DE DEEPSEEK")], "openrouter.ai": [respOpenai("DE OPENROUTER")],
  });
  const ctx = iaCon(f, TODO_EL_TEXTO);
  const esperado = {
    mistral: ["https://api.mistral.ai/v1/chat/completions", "Bearer M", "mistral-small-latest"],
    groq: ["https://api.groq.com/openai/v1/chat/completions", "Bearer Q", "openai/gpt-oss-120b"],
    deepseek: ["https://api.deepseek.com/chat/completions", "Bearer D", "deepseek-flash"],
    openrouter: ["https://openrouter.ai/api/v1/chat/completions", "Bearer R", "openrouter/free"],
  };
  for (const [id, [url, auth, modelo]] of Object.entries(esperado)) {
    const r = await ctx.llamarIA(id, cfgTodas, "S", "U");
    assert.deepStrictEqual([r.texto, r.uso.entrada, r.uso.salida, r.truncado], ["DE " + id.toUpperCase(), 40, 6, false]);
    const ll = f._llamadas[f._llamadas.length - 1];
    assert.strictEqual(ll.url, url);
    assert.strictEqual(ll.metodo, "POST");
    assert.strictEqual(ll.opts.headers.Authorization, auth, id + ": con SU clave, no con la de otro");
    assert.strictEqual(ll.opts.body, `{"model":"${modelo}","messages":[{"role":"system","content":"S"},{"role":"user","content":"U"}]}`,
      id + ": ni temperature ni topes; lo que no se manda no se rechaza");
    const propias = id === "openrouter" ? ["HTTP-Referer", "X-OpenRouter-Title"] : [];
    assert.deepStrictEqual(Object.keys(ll.opts.headers), ["Content-Type", "Authorization", ...propias], id);
  }
  assert.strictEqual(f._llamadas[3].opts.headers["X-OpenRouter-Title"], "Escriba");
  assert.strictEqual(f._pendientes(), 0);
  // El modelo que se elija en Opciones va delante del de por defecto.
  const g = nuevoFetch([respOpenai("OK")]);
  await iaCon(g, ["groq.chat"]).llamarIA("groq", { groqKey: "Q", groqModel: "openai/gpt-oss-20b" }, "S", "U");
  assert.deepStrictEqual(modelosPedidos(g), ["openai/gpt-oss-20b"]);
});

test("una capacidad apagada, o un id que no existe, se rechaza sin tocar la red ni usar la clave de otro", async () => {
  const f = nuevoFetch([]);
  const ctx = iaCon(f);
  for (const id of ["mistral", "groq", "deepseek", "openrouter", "meta", "constructor", ""]) {
    await assert.rejects(ctx.llamarIA(id, cfgTodas, "S", "U"), (e) => /desconocido/i.test(e.message), id);
  }
  assert.strictEqual(f._llamadas.length, 0, "hasta la 3.7, un id que no era Gemini ni GPT se mandaba a Anthropic con su clave");
  // Encendido, y sin su clave, dice cuál falta.
  await assert.rejects(iaCon(f, ["groq.chat"]).llamarIA("groq", { ...cfgTodas, groqKey: "" }, "S", "U"), /Groq/);
  assert.strictEqual(f._llamadas.length, 0);
});

test("si el modelo ya no existe (404) se prueba el de reserva, en todos; un fallo que no es del modelo no cambia de modelo", async () => {
  const noExiste = { status: 404, cuerpo: '{"error":{"message":"The model `x` does not exist","type":"invalid_request_error","param":null,"code":"model_not_found"}}' };
  // OpenAI: el elegido, después el de por defecto y los de reserva.
  let f = nuevoFetch([noExiste, noExiste, respOpenai("CON RESERVA")]);
  const avisos = [];
  let r = await iaCon(f).llamarIA("gpt", { openaiKey: "O", openaiModel: "gpt-retirado" }, "S", "U", { alEstado: (txt) => avisos.push(txt) });
  assert.strictEqual(r.texto, "CON RESERVA");
  assert.deepStrictEqual(modelosPedidos(f), ["gpt-retirado", "gpt-4o", "gpt-6.1-sol"]);
  assert.strictEqual(avisos.length, 2);
  assert.match(avisos[0], /OpenAI.*gpt-retirado.*gpt-4o/, "dice que cambia de modelo: " + avisos[0]);
  // Anthropic.
  f = nuevoFetch([{ status: 404, cuerpo: '{"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-5"}}' }, respClaude("CON RESERVA")]);
  r = await iaCon(f).llamarIA("claude", { claudeKey: "C" }, "S", "U");
  assert.strictEqual(r.texto, "CON RESERVA");
  assert.deepStrictEqual(modelosPedidos(f), ["claude-sonnet-5", "claude-sonnet-5-5"]);
  // Uno nuevo.
  f = nuevoFetch([noExiste, respOpenai("CON RESERVA")]);
  r = await iaCon(f, ["mistral.chat"]).llamarIA("mistral", { mistralKey: "M" }, "S", "U");
  assert.deepStrictEqual(modelosPedidos(f), ["mistral-small-latest", "mistral-medium-latest"]);
  // Si no queda ninguno, se dice que el modelo no existe.
  f = nuevoFetch([noExiste, noExiste]);
  await assert.rejects(iaCon(f, ["deepseek.chat"]).llamarIA("deepseek", { deepseekKey: "D" }, "S", "U"), (e) => /modelo/i.test(e.message) && /404/.test(e.message) && e.status === 404);
  assert.deepStrictEqual(modelosPedidos(f), ["deepseek-flash", "deepseek-v4-pro"]);
  // Saturado (503) lo está la cuenta, no el modelo: se reintenta con el mismo y no se salta a otro.
  f = nuevoFetch(cuatroVeces({ status: 503, cuerpo: '{"error":{"message":"The server is overloaded","type":"service_unavailable_error","code":"server_is_overloaded"}}' }));
  await assert.rejects(iaCon(f).llamarIA("gpt", { openaiKey: "O" }, "S", "U"), /saturad/i);
  assert.deepStrictEqual(modelosPedidos(f), ["gpt-4o", "gpt-4o", "gpt-4o", "gpt-4o"]);
});

test("el 529 de Anthropic (saturado) se reintenta avisando, como un 503", async () => {
  const f = nuevoFetch([{ status: 529, cuerpo: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}' }, respClaude("ACTA")]);
  const avisos = [];
  const r = await iaCon(f).llamarIA("claude", cfgTodas, "S", "U", { alEstado: (txt) => avisos.push(txt) });
  assert.strictEqual(r.texto, "ACTA");
  assert.strictEqual(f._llamadas.length, 2);
  assert.strictEqual(avisos.length, 1);
  // Y si no se le pasa, el error dice saturado, no «petición rechazada».
  const siempre = nuevoFetch(cuatroVeces({ status: 529, cuerpo: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }));
  await assert.rejects(iaCon(siempre).llamarIA("claude", cfgTodas, "S", "U"), (e) => /Anthropic/.test(e.message) && /saturad/i.test(e.message) && /529/.test(e.message));
  assert.strictEqual(siempre._llamadas.length, 4);
});

test("Retry-After: se espera lo que pide la API, nunca menos que la espera propia y nunca más de 30 s", async () => {
  const esperas = [];
  const f = nuevoFetch([
    { status: 429, cuerpo: '{"error":{"message":"Rate limit reached","type":"rate_limit_error","code":"rate_limit_exceeded"}}', cabeceras: { "retry-after": "12" } },
    { status: 429, cuerpo: "{}", cabeceras: { "Retry-After": "600" } },
    { status: 503, cuerpo: "{}", cabeceras: { "Retry-After": "1" } },
    respOpenai("AL FIN"),
  ]);
  const r = await iaCon(f, ["groq.chat"], esperas).llamarIA("groq", cfgTodas, "S", "U");
  assert.strictEqual(r.texto, "AL FIN");
  assert.deepStrictEqual(esperas, [12000, 30000, 20000], "12 s pedidos; 600 s recortados a 30; y 1 s pedido no baja de la espera propia (20 s)");
  // Sin cabecera, las esperas de siempre.
  const sin = [];
  const g = nuevoFetch([{ status: 503, cuerpo: "{}" }, { status: 503, cuerpo: "{}" }, respGemini("OK")]);
  await iaCon(g, [], sin).llamarIA("gemini", cfgTodas, "S", "U");
  assert.deepStrictEqual(sin, [3000, 8000]);
});

test("sin saldo no se reintenta ni se cambia de modelo, y se dice que es el saldo: 402, y el 429 de OpenAI y de Anthropic", async () => {
  const casos = [
    ["gpt", [], { status: 429, cuerpo: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}' }, /OpenAI/],
    ["gpt", [], { status: 429, cuerpo: '{"error":{"message":"Credit balance exhausted","type":"invalid_request_error","param":null,"code":"credit_balance_exhausted"}}' }, /OpenAI/],
    ["claude", [], { status: 429, cuerpo: '{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits","details":{"error_code":"enforced_spend_limit_reached"}},"request_id":"req_1"}' }, /Anthropic/],
    ["claude", [], { status: 402, cuerpo: '{"type":"error","error":{"type":"billing_error","message":"Billing issue"}}' }, /Anthropic/],
    ["deepseek", ["deepseek.chat"], { status: 402, cuerpo: '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}' }, /DeepSeek/],
    ["openrouter", ["openrouter.chat"], { status: 402, cuerpo: '{"error":{"code":402,"message":"Insufficient credits","metadata":{"limit_source":"account"}}}' }, /OpenRouter/],
  ];
  for (const [id, encendidos, respuesta, nombre] of casos) {
    const f = nuevoFetch([respuesta]);
    const avisos = [];
    await assert.rejects(iaCon(f, encendidos).llamarIA(id, cfgTodas, "S", "U", { alEstado: (txt) => avisos.push(txt) }), (e) => {
      assert.match(e.message, /saldo/i, id + ": " + e.message);
      assert.match(e.message, nombre);
      assert.doesNotMatch(e.message, /[{}]/, "nada de JSON en crudo: " + e.message);
      return true;
    });
    assert.strictEqual(f._llamadas.length, 1, id + ": esperar no trae saldo, así que no se reintenta");
    assert.deepStrictEqual(avisos, [], id);
  }
  // Un 429 de ritmo sí se reintenta, y agotado dice «límite», no «saldo».
  const ritmo = nuevoFetch(cuatroVeces({ status: 429, cuerpo: '{"error":{"message":"Slow down","type":"rate_limit_error","param":null,"code":"slow_down"}}' }));
  await assert.rejects(iaCon(ritmo).llamarIA("gpt", cfgTodas, "S", "U"), (e) => /límite/i.test(e.message) && !/saldo/i.test(e.message));
  assert.strictEqual(ritmo._llamadas.length, 4);
});

test("413: la reunión no cabe en una petición (Groq gratuito); no se reintenta y se dice qué hacer", async () => {
  const f = nuevoFetch([{ status: 413, cuerpo: '{"error":{"message":"Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 21450","type":"tokens","code":"rate_limit_exceeded"}}' }]);
  await assert.rejects(iaCon(f, ["groq.chat"]).llamarIA("groq", cfgTodas, "S", "U"), (e) => /no cabe/i.test(e.message) && /Groq/.test(e.message) && /413/.test(e.message));
  assert.strictEqual(f._llamadas.length, 1);
});

test("una clave de Anthropic ligada al usuario y no a un workspace tiene su propio mensaje, no «clave rechazada»", async () => {
  const f = nuevoFetch([{ status: 400, cuerpo: '{"type":"error","error":{"type":"invalid_request_error","message":"anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in."},"request_id":"req_1"}' }]);
  await assert.rejects(iaCon(f).llamarIA("claude", cfgTodas, "S", "U"), (e) => {
    assert.match(e.message, /workspace/i);
    assert.match(e.message, /Anthropic/);
    assert.doesNotMatch(e.message, /ha rechazado la clave/, "revisar la clave no lo arregla: hay que crear otra");
    return true;
  });
  assert.strictEqual(f._llamadas.length, 1);
  // Un 400 de clave mala sigue diciendo que se revise la clave (Gemini lo manda así).
  const g = nuevoFetch([{ status: 400, cuerpo: '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}' }]);
  await assert.rejects(iaCon(g).llamarIA("gemini", cfgTodas, "S", "U"), /ha rechazado la clave/);
});

test("los errores de los proveedores nuevos se leen en sus formas reales: en el idioma de la interfaz y sin JSON", async () => {
  const casos = [
    ["mistral", { status: 401, cuerpo: '{"detail":"Invalid API Key"}' }, /Mistral ha rechazado la clave/],
    ["mistral", { status: 422, cuerpo: '{"detail":[{"loc":["body","model"],"msg":"Field required","type":"missing"}]}' }, /Mistral ha rechazado la petición: body\.model: Field required \(HTTP 422\)/],
    ["groq", { status: 401, cuerpo: '{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}' }, /Groq ha rechazado la clave/],
    ["deepseek", { status: 401, cuerpo: '{"error":{"message":"Authentication Fails, Your api key: ****alid is invalid (request_id: 1)","type":"authentication_error","param":null,"code":"invalid_request_error"}}' }, /DeepSeek ha rechazado la clave/],
    ["openrouter", { status: 401, cuerpo: '{"error":{"message":"No cookie auth credentials found","code":401}}' }, /OpenRouter ha rechazado la clave/],
    ["groq", { status: 400, cuerpo: '{"error":{"message":"`logprobs` is not supported with this model","type":"invalid_request_error"}}' }, /Groq ha rechazado la petición: `logprobs` is not supported/],
    ["mistral", { status: 400, cuerpo: "<html>Bad Request</html>" }, /Mistral ha rechazado la petición \(HTTP 400\)/],
  ];
  for (const [id, respuesta, esperado] of casos) {
    const f = nuevoFetch([respuesta]);
    await assert.rejects(iaCon(f, TODO_EL_TEXTO).llamarIA(id, cfgTodas, "S", "U"), (e) => {
      assert.match(e.message, esperado);
      assert.doesNotMatch(e.message, /[{}<>]/, "ni JSON ni HTML en crudo: " + e.message);
      assert.strictEqual(e.status, respuesta.status);
      return true;
    });
    assert.strictEqual(f._llamadas.length, 1, id + ": un rechazo no se reintenta");
  }
  // El 401 de OpenAI llega como text/plain: se lee igual.
  const f = nuevoFetch([{ status: 401, cuerpo: '{\n    "error": {\n        "message": "Incorrect API key provided: sk-inval***-000.",\n        "type": "invalid_request_error",\n        "param": null,\n        "code": "invalid_api_key"\n    },\n    "status": 401\n}' }]);
  await assert.rejects(iaCon(f).llamarIA("gpt", cfgTodas, "S", "U"), /OpenAI ha rechazado la clave/);
  // Y con la interfaz en inglés, en inglés.
  const ctx = iaCon(nuevoFetch([{ status: 402, cuerpo: "{}" }]), ["deepseek.chat"]);
  ctx.ponIdiomaUI("en");
  await assert.rejects(ctx.llamarIA("deepseek", cfgTodas, "S", "U"), /DeepSeek says the account/);
});

test("el contenido como lista de trozos (Mistral con razonamiento): el acta es el texto, no el razonamiento", async () => {
  const contenido = [
    { type: "thinking", thinking: [{ type: "text", text: "Voy a pensar el acta…" }] },
    { type: "text", text: "## Resumen\n" },
    { type: "text", text: "Se aprobó el presupuesto." },
  ];
  const f = nuevoFetch([respOpenai(contenido)]);
  const r = await iaCon(f, ["mistral.chat"]).llamarIA("mistral", cfgTodas, "S", "U");
  assert.strictEqual(r.texto, "## Resumen\nSe aprobó el presupuesto.");
  // Una lista sin nada de texto es una respuesta vacía, con su motivo.
  const vacio = nuevoFetch([{ cuerpo: { choices: [{ finish_reason: "length", message: { content: [{ type: "thinking", thinking: [] }] } }] } }]);
  await assert.rejects(iaCon(vacio, ["mistral.chat"]).llamarIA("mistral", cfgTodas, "S", "U"), (e) => /vacía/.test(e.message) && /length/.test(e.message));
  // Sin contenido (un filtro, o `content: null`): vacía, no un TypeError.
  const nulo = nuevoFetch([{ cuerpo: { choices: [{ finish_reason: "content_filter", message: { content: null } }] } }]);
  await assert.rejects(iaCon(nulo).llamarIA("gpt", cfgTodas, "S", "U"), (e) => /OpenAI devolvió una respuesta vacía/.test(e.message) && /content_filter/.test(e.message));
});

test("Anthropic con razonamiento: el acta son solo los bloques de texto", async () => {
  // El último bloque no existe hoy en su API: está para fijar que lo que cuenta
  // es el tipo del bloque, no que traiga algo llamado `text`.
  const content = [
    { type: "thinking", thinking: "Pienso…", signature: "abc" }, { type: "text", text: "ACTA " },
    { type: "text", text: "COMPLETA" }, { type: "de_otro_tipo", text: " Y ESTO NO" },
  ];
  const f = nuevoFetch([{ cuerpo: { content, stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 99 } } }]);
  const r = await iaCon(f).llamarIA("claude", cfgTodas, "S", "U");
  assert.deepStrictEqual([r.texto, r.uso.salida, r.truncado], ["ACTA COMPLETA", 99, false]);
});

test("un 200 con el error dentro (OpenRouter) es un error: pasajero se reintenta, y si no, se lee", async () => {
  const pasajero = { cuerpo: { error: { code: 502, message: "Provider returned error", metadata: { provider_name: "x" } } } };
  let f = nuevoFetch([pasajero, respOpenai("AL SEGUNDO")]);
  const avisos = [];
  const r = await iaCon(f, ["openrouter.chat"]).llamarIA("openrouter", cfgTodas, "S", "U", { alEstado: (txt) => avisos.push(txt) });
  assert.strictEqual(r.texto, "AL SEGUNDO");
  assert.strictEqual(avisos.length, 1);
  // Sin saldo dentro de un 200: ni se reintenta ni se da por bueno.
  f = nuevoFetch([{ cuerpo: { error: { code: 402, message: "Insufficient credits" } } }]);
  await assert.rejects(iaCon(f, ["openrouter.chat"]).llamarIA("openrouter", cfgTodas, "S", "U"), (e) => /saldo/i.test(e.message) && e.status === 402);
  assert.strictEqual(f._llamadas.length, 1);
  // Sin código reconocible, al menos lo que dice.
  f = nuevoFetch([{ cuerpo: { error: { message: "Model produced invalid output" }, choices: [] } }]);
  await assert.rejects(iaCon(f, ["openrouter.chat"]).llamarIA("openrouter", cfgTodas, "S", "U"), /OpenRouter ha rechazado la petición: Model produced invalid output/);
  // Un `error: null` junto al texto no es un error.
  f = nuevoFetch([respOpenai("BIEN", { error: null })]);
  assert.strictEqual((await iaCon(f, ["openrouter.chat"]).llamarIA("openrouter", cfgTodas, "S", "U")).texto, "BIEN");
});

test("truncado: si el modelo corta por longitud, el resultado lo dice (y el acta lo arrastra)", async () => {
  const cortes = [
    ["gemini", [], respGemini("ACTA A MED", "MAX_TOKENS"), respGemini("ACTA")],
    ["gpt", [], { cuerpo: { choices: [{ finish_reason: "length", message: { content: "ACTA A MED" } }] } }, respOpenai("ACTA")],
    ["claude", [], respClaude("ACTA A MED", { stop_reason: "max_tokens" }), respClaude("ACTA")],
    ["deepseek", ["deepseek.chat"], { cuerpo: { choices: [{ finish_reason: "length", message: { content: "ACTA A MED", reasoning_content: null } }] } }, respOpenai("ACTA")],
  ];
  for (const [id, encendidos, cortada, entera] of cortes) {
    const ctx = iaCon(nuevoFetch([cortada, entera]), encendidos);
    const a = await ctx.llamarIA(id, cfgTodas, "S", "U");
    assert.deepStrictEqual([a.texto, a.truncado], ["ACTA A MED", true], id + ": hay texto, pero incompleto");
    const b = await ctx.llamarIA(id, cfgTodas, "S", "U");
    assert.deepStrictEqual([b.texto, b.truncado], ["ACTA", false], id);
  }
  const f = nuevoFetch([respClaude("ACTA A MED", { stop_reason: "max_tokens" })]);
  const acta = await iaCon(f).analizarReunion({ transcript: "[00:01] Ana: hola" }, "acta", "claude", cfgTodas);
  assert.deepStrictEqual([acta.clave, acta.truncado], ["acta·claude", true]);
});

test("acta y preguntas con un proveedor nuevo: misma plantilla, misma conversación, y la clave del historial lleva su id", async () => {
  const f = nuevoFetch([respOpenai("RESUMEN"), respOpenai("El 15 de octubre.")]);
  const ctx = iaCon(f, ["groq.chat"]);
  const h = { transcript: "[00:01] Hablante 1: entregamos el 15 de octubre", hablantes: { "Hablante 1": "Ana" }, chat: [{ p: "¿Quién habla?", r: "Ana." }] };
  const acta = await ctx.analizarReunion(h, "resumen", "groq", { ...cfgTodas, glosario: "Odoo" });
  assert.deepStrictEqual([acta.clave, acta.texto], ["resumen·groq", "RESUMEN"]);
  const msgs = JSON.parse(f._llamadas[0].opts.body).messages;
  assert.match(msgs[0].content, /Odoo/, "el glosario va en las instrucciones");
  assert.match(msgs[1].content, /Ana: entregamos/, "con los nombres puestos");
  const resp = await ctx.preguntarReunion(h, "¿Cuándo?", "groq", cfgTodas);
  assert.strictEqual(resp.texto, "El 15 de octubre.");
  assert.deepStrictEqual(JSON.parse(f._llamadas[1].opts.body).messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
});

grupo("3.8 · coste por proveedor y por minuto (comun.js)");

const PRECIOS_38 = { gemini: { audio: "1", entrada: "0,30", salida: "2,5" }, groq: { minuto: "0,002", entrada: "0,15", salida: "0,6" }, mistral: { minuto: "" } };

test("un tramo se le cobra a quien lo transcribió: por minuto cuando la API da la duración", () => {
  const h = { id: 1, tramos: [{ estado: "ok", prov: "groq", modelo: "whisper-large-v3", uso: { segundos: 300 } }, { estado: "ok", prov: "groq", uso: { segundos: 150 } }] };
  const c = comun.costeReunion(h, PRECIOS_38);
  assert.ok(Math.abs(c.euros - 7.5 * 0.002) < 1e-12, "7,5 minutos a 0,002 €: " + c.euros);
  assert.deepStrictEqual([c.tokens, c.segundos], [0, 450], "no son tokens: son segundos de audio");
  assert.deepStrictEqual(c.faltan, []);
  // Con su acta por tokens, cada cosa a su precio.
  const conActa = comun.costeReunion({ ...h, usoIA: [{ clave: "acta·groq", entrada: 1000000, salida: 500000 }] }, PRECIOS_38);
  assert.ok(Math.abs(conActa.euros - (0.015 + 0.15 + 0.3)) < 1e-12, String(conActa.euros));
  assert.strictEqual(comun.costeReunion(h, { groq: { minuto: "0" } }).euros, 0, "el plan gratuito es un precio de verdad: 0");
});

test("un tramo antiguo, sin proveedor apuntado, se sigue cobrando a Gemini; y con «gemini» apuntado, igual", () => {
  const uso = { entrada: 1000000, salida: 100000 };
  const antiguo = comun.costeReunion({ id: 1, tramos: [{ estado: "ok", uso }] }, PRECIOS_38);
  const nuevo = comun.costeReunion({ id: 1, tramos: [{ estado: "ok", prov: "gemini", modelo: "gemini-flash-latest", uso }] }, PRECIOS_38);
  assert.ok(Math.abs(antiguo.euros - 1.25) < 1e-9, String(antiguo.euros));
  assert.deepStrictEqual([nuevo.euros, nuevo.tokens, nuevo.faltan], [antiguo.euros, antiguo.tokens, antiguo.faltan]);
  // Los de la 3.1 ni apuntaban el uso: siguen sin coste y sin contar como «falta».
  const de31 = comun.costeReunion({ id: 1, tramos: [{ estado: "ok", texto: "sin uso" }] }, PRECIOS_38);
  assert.deepStrictEqual([de31.euros, de31.faltan], [null, []]);
});

test("un proveedor sin precio, o que no dice cuánto gastó, sale en «faltan»: nunca cuenta como cero", () => {
  const gemini = { estado: "ok", prov: "gemini", uso: { entrada: 1000000, salida: 0 } };
  // Sin precio por minuto (vacío en Opciones).
  let c = comun.costeReunion({ id: 1, tramos: [gemini, { estado: "ok", prov: "mistral", uso: { segundos: 300 } }] }, PRECIOS_38);
  assert.ok(Math.abs(c.euros - 1) < 1e-9, "lo que sí se sabe se suma: " + c.euros);
  assert.deepStrictEqual(c.faltan, ["mistral"]);
  // Solo con lo que no se sabe, el coste es desconocido, no 0.
  c = comun.costeReunion({ id: 1, tramos: [{ estado: "ok", prov: "mistral", uso: { segundos: 300 } }] }, PRECIOS_38);
  assert.deepStrictEqual([c.euros, c.faltan], [null, ["mistral"]]);
  // La API no dio ni duración ni tokens: se transcribió y costó, pero no se sabe cuánto.
  c = comun.costeReunion({ id: 1, tramos: [gemini, { estado: "ok", prov: "gpt", modelo: "gpt-transcribe" }] }, PRECIOS_38);
  assert.deepStrictEqual([Math.round(c.euros * 100) / 100, c.faltan], [1, ["gpt"]]);
  // En tokens (OpenAI a veces los da): al precio de `audio` de ese proveedor, que si no está, falta.
  c = comun.costeReunion({ id: 1, tramos: [{ estado: "ok", prov: "gpt", uso: { entrada: 5000, salida: 800 } }] }, { gpt: { entrada: "2", salida: "8" } });
  assert.ok(Math.abs(c.euros - 0.0064) < 1e-12, "la salida sí tiene precio: " + c.euros);
  assert.deepStrictEqual(c.faltan, ["gpt"], "pero el audio de entrada no");
  // Lo que no llegó a transcribirse (pendiente, sin voz) no ha costado nada ni falta nada.
  c = comun.costeReunion({ id: 1, tramos: [gemini, { estado: "pendiente", prov: "groq", codigo: "sin_saldo" }, { estado: "mudo", prov: "groq" }] }, PRECIOS_38);
  assert.deepStrictEqual(c.faltan, []);
  // El mes suma lo que se sabe, también lo cobrado por minuto.
  const octubre = new Date(2026, 9, 20).getTime();
  const m = comun.costeMes([{ id: new Date(2026, 9, 5, 10).getTime(), tramos: [{ estado: "ok", prov: "groq", uso: { segundos: 600 } }] }], PRECIOS_38, octubre);
  assert.ok(Math.abs(m.euros - 0.02) < 1e-12 && m.reuniones === 1, JSON.stringify(m));
});

grupo("3.8 · sin saldo, y líneas sin hablante (comun.js)");

test("«sin saldo» tiene su texto en los dos idiomas y, como una clave mala, no se arregla esperando", async () => {
  assert.ok(comun.CODIGOS_CLAVE.includes("sin_saldo"));
  assert.match(comun.textoError("sin_saldo"), /saldo/);
  assert.notStrictEqual(comun.textoError("sin_saldo"), comun.textoError("otro"));
  i18n._ponIdioma("en");
  assert.match(comun.textoError("sin_saldo"), /credit/);
  i18n._ponIdioma("es");
  // El service worker no programa reintentos para una reunión parada por eso.
  const { chrome, ctx } = bg();
  const h = { id: 77, tramos: [{ estado: "ok" }, { estado: "pendiente", codigo: "sin_saldo" }, { estado: "pendiente", codigo: "sin_saldo" }] };
  const r = await ctx.planificaReintento(h, "pendiente");
  assert.strictEqual(r.esperaClave, true);
  assert.deepStrictEqual(Object.keys(chrome._registro.alarmas), [], "esperar no trae saldo: nada de alarmas");
  // Si además hay algo que sí se arregla esperando, se reintenta.
  h.tramos.push({ estado: "pendiente", codigo: "saturado" });
  assert.ok((await ctx.planificaReintento(h, "pendiente")).proximo);
});

test("la trampa del «:»: una línea sin hablante que empieza como una etiqueta no se toma por una persona", () => {
  // Con un modelo que no distingue hablantes las líneas son «[MM:SS] texto», y
  // «Primer punto: …» casaría con el patrón de «Nombre: texto».
  const cruda = "[00:12] Primer punto: hay que cerrar el presupuesto";
  assert.deepStrictEqual(comun.hablantesDe(cruda), ["Primer punto"], "sin protegerla, se inventa un hablante");
  const protegida = comun.sinEtiqueta(cruda);
  assert.strictEqual(protegida, "[00:12] " + comun.SIN_HABLANTE + "Primer punto: hay que cerrar el presupuesto");
  assert.strictEqual(comun.SIN_HABLANTE, "\u2060", "invisible: no ocupa ni parte palabras");
  assert.deepStrictEqual(comun.hablantesDe(protegida), []);
  assert.deepStrictEqual(comun.lineasTranscripcion(protegida).map((l) => [l.t, l.hablante, l.texto]),
    [[12, "", "Primer punto: hay que cerrar el presupuesto"]], "y al leerla el carácter invisible no sale en el texto");
  // Sin marca de tiempo (las líneas siguientes de gpt-transcribe) pasa lo mismo.
  const sinMarca = comun.sinEtiqueta("Segundo punto: plazos");
  assert.deepStrictEqual(comun.lineasTranscripcion(sinMarca).map((l) => [l.t, l.hablante, l.texto]), [[null, "", "Segundo punto: plazos"]]);
  // Lo que no engañaría al patrón se queda como está, y proteger dos veces no añade nada.
  for (const l of ["[00:30] seguimos con el punto dos: plazos", "[00:40] vale, de acuerdo", "texto suelto", "[inaudible]", ""]) assert.strictEqual(comun.sinEtiqueta(l), l);
  assert.strictEqual(comun.sinEtiqueta(protegida), protegida);
  // La protección aguanta lo que se le hace después al texto: pasar las marcas a
  // tiempo de reunión, renombrar hablantes y rehacer el .md.
  const texto = [protegida, "[00:20] Hablante 1: de acuerdo"].join("\n");
  const enReunion = comun.ajustarTiempos(texto, 600);
  assert.deepStrictEqual(comun.lineasTranscripcion(enReunion).map((l) => [l.t, l.hablante, l.texto]),
    [[612, "", "Primer punto: hay que cerrar el presupuesto"], [620, "Hablante 1", "de acuerdo"]]);
  const renombrado = comun.aplicarHablantes(enReunion, { "Hablante 1": "Ana", "Primer punto": "NADIE" });
  assert.doesNotMatch(renombrado, /NADIE/);
  assert.match(renombrado, /\[10:20\] Ana: de acuerdo/);
  const md = comun.construirMarkdown({ fecha: "x", meta: { minutos: 5 }, tramos: [{ estado: "ok", texto: enReunion }] });
  assert.deepStrictEqual(comun.hablantesDe(md.split("---\n")[1]), ["Hablante 1"], "releído desde el .md, sigue sin inventarse a nadie");
});

// ============================================================================
// 3.8 — transcribir con otros proveedores (plan, apartados 3 y 4)
// ============================================================================
grupo("3.8 · de segmentos a texto (offscreen.js)");

// Documento offscreen con las voces que se digan encendidas: lo que el código
// trae apagado se prueba igual, encendiéndolo aquí, en el contexto del test.
// `esperas` recoge lo que se esperaría entre reintentos (no se espera de verdad).
function offscreenVoz(fetchStub, cfg = {}, encendidos = TODA_LA_VOZ, esperas = []) {
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg"
    ? { geminiKey: "", geminiModel: "", glosario: "", idioma: "es", provTranscribe: "auto", ...cfg } : { ok: true });
  const entorno = { ...entornoOffscreen(chrome, fetchStub), setTimeout: (fn, ms) => { esperas.push(ms); setImmediate(fn); } };
  return encender(cargar(["proveedores.js", "comun.js", "offscreen.js"], entorno), ...encendidos);
}
const seg = (inicio, fin, texto, hablante) => ({ inicio, fin, texto, hablante });
// Un segundo de «voz» a 16 kHz: lo que hay dentro de un tramo que se puede decodificar.
const tonoVoz = (segundos = 1) => Float32Array.from({ length: 16000 * segundos }, (_, i) => 0.3 * Math.sin(i / 5));

test("los segmentos seguidos del mismo hablante van en una línea, y los hablantes se numeran por orden de aparición", () => {
  const ctx = offscreenVoz(nuevoFetch([]));
  const r = ctx.segmentosATexto([
    seg(0.4, 3.1, " Buenos días.", "B"), seg(3.4, 6, "Empezamos.", "B"),      // 0,3 s de pausa: la misma intervención
    seg(6.5, 9, "Vale.", "A"),                                               // cambia quien habla
    seg(12.2, 14, "Seguimos", "B"), seg(16.5, 18, "con el punto dos.", "B"), // 2,5 s callado: línea nueva
  ]);
  assert.strictEqual(r.texto, [
    "[00:00] Hablante 1: Buenos días. Empezamos.",
    "[00:06] Hablante 2: Vale.",
    "[00:12] Hablante 1: Seguimos",
    "[00:16] Hablante 1: con el punto dos.",
  ].join("\n"));
  assert.ok(!("sinVoz" in r));
  // Es el formato de siempre: el resto de Escriba lo lee sin saber de dónde viene.
  assert.deepStrictEqual(comun.lineasTranscripcion(r.texto).map((l) => [l.t, l.hablante, l.texto]),
    [[0, "Hablante 1", "Buenos días. Empezamos."], [6, "Hablante 2", "Vale."], [12, "Hablante 1", "Seguimos"], [16, "Hablante 1", "con el punto dos."]]);
  // El número es el orden de aparición en el tramo, se llamen como se llamen en la API.
  assert.strictEqual(ctx.segmentosATexto([seg(1, 2, "yo primero", "speaker_2"), seg(5, 6, "y yo después", "speaker_1")]).texto,
    "[00:01] Hablante 1: yo primero\n[00:05] Hablante 2: y yo después");
  // Una intervención larga no se queda en una línea imposible de leer: unos 350 caracteres.
  const largo = "palabra ".repeat(25).trim() + "."; // 200 caracteres
  const partida = ctx.segmentosATexto([seg(0, 10, largo, "A"), seg(10.1, 20, largo, "A"), seg(20.1, 22, "Fin.", "A")]).texto.split("\n");
  assert.deepStrictEqual(partida, [`[00:00] Hablante 1: ${largo}`, `[00:10] Hablante 1: ${largo} Fin.`]);
  // Los segmentos que se pisan (el siguiente empieza antes de acabar el anterior) también son seguidos.
  assert.strictEqual(ctx.segmentosATexto([seg(0, 5, "uno", "A"), seg(4.2, 8, "dos", "A")]).texto, "[00:00] Hablante 1: uno dos");
  // Sin saber cuándo acaba el anterior no se da por seguido.
  assert.strictEqual(ctx.segmentosATexto([seg(0, undefined, "uno", "A"), seg(9, undefined, "dos", "A")]).texto, "[00:00] Hablante 1: uno\n[00:09] Hablante 1: dos");
  // La etiqueta va en el idioma de la interfaz, como la que se le pide a Gemini.
  ctx.ponIdiomaUI("en");
  assert.strictEqual(ctx.segmentosATexto([seg(61, 62, "hello", "A")]).texto, "[01:01] Speaker 1: hello");
});

test("sin hablantes las líneas son «[MM:SS] texto», y la que empieza como una etiqueta va protegida (la trampa del «:»)", () => {
  const ctx = offscreenVoz(nuevoFetch([]));
  const r = ctx.segmentosATexto([
    seg(43.92, 50.16, " Primer punto: hay que cerrar el presupuesto"), seg(50.5, 52, " y fijar el plazo."),
    seg(61, 63, " vale, de acuerdo", ""), seg(70, 71, " Nota: falta la firma", null),
  ]);
  assert.strictEqual(r.texto, [
    "[00:43] " + comun.SIN_HABLANTE + "Primer punto: hay que cerrar el presupuesto y fijar el plazo.",
    "[01:01] vale, de acuerdo",
    "[01:10] " + comun.SIN_HABLANTE + "Nota: falta la firma",
  ].join("\n"), "la marca, hacia abajo (43,92 s es 00:43): al pulsarla se empieza un poco antes, no a media palabra");
  assert.deepStrictEqual(comun.hablantesDe(r.texto), [], "nadie se llama «Primer punto» ni «Nota»");
  assert.deepStrictEqual(comun.lineasTranscripcion(r.texto).map((l) => [l.t, l.hablante, l.texto]), [
    [43, "", "Primer punto: hay que cerrar el presupuesto y fijar el plazo."], [61, "", "vale, de acuerdo"], [70, "", "Nota: falta la firma"],
  ]);
  // Con hablantes, la etiqueta es la del hablante: lo que diga después no engaña a nadie.
  const con = ctx.segmentosATexto([seg(5, 9, "Primer punto: el presupuesto", "A")]).texto;
  assert.strictEqual(con, "[00:05] Hablante 1: Primer punto: el presupuesto");
  assert.deepStrictEqual(comun.hablantesDe(con), ["Hablante 1"]);
});

test("sin tiempos (gpt-transcribe): frases enteras en líneas de unos 300 caracteres; solo la primera lleva marca, la del principio del tramo", () => {
  const ctx = offscreenVoz(nuevoFetch([]));
  const texto = Array.from({ length: 20 }, (_, i) => `Esta es la frase número ${i + 1} de la reunión de hoy.`).join(" ");
  const r = ctx.segmentosATexto([seg(null, null, texto, "")]);
  const lineas = r.texto.split("\n");
  assert.ok(lineas.length >= 3 && lineas.length <= 5, "unos 900 caracteres: " + lineas.length + " líneas");
  assert.match(lineas[0], /^\[00:00\] Esta es la frase número 1 /);
  assert.ok(lineas.slice(1).every((l) => !l.startsWith("[")), "las demás van sin marca: no se sabe cuándo se dijeron");
  assert.ok(lineas.every((l) => l.length <= 310 && l.endsWith(".")), "se corta entre frases, no a media frase");
  assert.strictEqual(lineas.join(" ").replace("[00:00] ", ""), texto, "ni una palabra de más ni de menos");
  assert.match(comun.ajustarTiempos(r.texto, 600).split("\n")[0], /^\[10:00\] Esta es/, "en la reunión, la marca es donde empieza el tramo");
  // La trampa del «:» también aquí, en la línea con marca y en las que no la llevan.
  const trampa = ctx.segmentosATexto([seg(null, null, `Primer punto: el presupuesto. ${"x".repeat(290)}. Segundo punto: los plazos.`)]).texto;
  assert.deepStrictEqual(comun.hablantesDe(trampa), []);
  assert.deepStrictEqual(comun.lineasTranscripcion(trampa).map((l) => [l.t, l.texto.slice(0, 14)]), [[0, "Primer punto: "], [null, "x".repeat(14)], [null, "Segundo punto:"]]);
  // Un modelo que no puntúa: se corta entre palabras antes que dejar una línea de mil y pico caracteres.
  const sinPuntos = ctx.segmentosATexto([seg(null, null, "palabra ".repeat(200))]).texto.split("\n");
  assert.ok(sinPuntos.length >= 5 && sinPuntos.every((l) => l.length <= 310 && !/ $|^ /.test(l)), sinPuntos.map((l) => l.length).join(","));
  assert.strictEqual(sinPuntos.join(" ").match(/palabra/g).length, 200);
});

test("un segmento sin tiempo (Mistral puede mandar `start` a null) sale sin marca: no se le inventa una", () => {
  const ctx = offscreenVoz(nuevoFetch([]));
  const r = ctx.segmentosATexto([
    seg(1, 2, "hola", "speaker_1"), seg(null, null, "sigo, pero no se sabe cuándo", "speaker_1"),
    seg(null, null, "yo tampoco", "speaker_2"), seg(9, 10, "ahora sí", "speaker_2"),
  ]);
  assert.strictEqual(r.texto, "[00:01] Hablante 1: hola sigo, pero no se sabe cuándo\nHablante 2: yo tampoco\n[00:09] Hablante 2: ahora sí");
  assert.deepStrictEqual(comun.lineasTranscripcion(r.texto).map((l) => [l.t, l.hablante]), [[1, "Hablante 1"], [null, "Hablante 2"], [9, "Hablante 2"]]);
  // Si ninguno trae tiempo, la primera línea lleva el principio del tramo, que es lo único que se sabe.
  assert.strictEqual(ctx.segmentosATexto([seg(null, null, "uno", "speaker_1"), seg(null, null, "dos", "speaker_2")]).texto, "[00:00] Hablante 1: uno\nHablante 2: dos");
  // Lo que no es un número es «no se sabe», nunca un cero; un número escrito como texto sí vale.
  assert.strictEqual(ctx.segmentosATexto([seg(5, 6, "a", "x"), seg("", NaN, "b", "y"), seg("12.5", "13", "c", "y")]).texto,
    "[00:05] Hablante 1: a\nHablante 2: b\n[00:12] Hablante 2: c");
});

test("silencio sin texto inventado: sin segmentos con texto el tramo es «sin voz», y lo que Whisper se inventa se descarta", () => {
  const ctx = offscreenVoz(nuevoFetch([]));
  for (const vacio of [[], null, undefined, [seg(0, 1, "   "), seg(1, 2, ""), seg(2, 3)]]) {
    assert.deepStrictEqual({ ...ctx.segmentosATexto(vacio) }, { texto: "", sinVoz: true });
  }
  const W = { whisper: true };
  const s = (texto, probSilencio, confianza) => ({ inicio: 0, fin: 5, texto, probSilencio, confianza });
  // Whisper dice él mismo cuándo cree que no se habla. Hacen falta las DOS señales…
  assert.strictEqual(ctx.segmentosATexto([s("ruido tomado por palabras", 0.9, -1.4)], W).sinVoz, true);
  assert.strictEqual(ctx.segmentosATexto([s("se oye mal, pero se habla", 0.9, -0.3)], W).texto, "[00:00] se oye mal, pero se habla");
  assert.strictEqual(ctx.segmentosATexto([s("frase poco clara", 0.1, -1.4)], W).texto, "[00:00] frase poco clara");
  // …y solo si vienen las dos: el turbo de Groq no las da.
  assert.strictEqual(ctx.segmentosATexto([s("sin datos de calidad")], W).texto, "[00:00] sin datos de calidad");
  assert.strictEqual(ctx.segmentosATexto([s("con una sola señal", 0.99)], W).texto, "[00:00] con una sola señal");
  assert.strictEqual(ctx.segmentosATexto([s("ruido tomado por palabras", 0.9, -1.4)]).texto, "[00:00] ruido tomado por palabras", "fuera de Whisper esos campos no significan nada");
  // Las frases que se inventa en los silencios: los créditos de los vídeos con que se entrenó.
  for (const inventada of [
    "Subtítulos realizados por la comunidad de Amara.org", " Subtítulos por la comunidad de Amara.org ", "Subtitles by the Amara.org community",
    "¡Gracias por ver el vídeo!", "Gracias por ver el video.", "Thanks for watching!", "Thank you for watching.", "¡Suscríbete al canal!",
    "Más información www.alimmenta.com",
  ]) assert.strictEqual(ctx.segmentosATexto([s(inventada)], W).sinVoz, true, inventada);
  // Solo cuando son el segmento ENTERO: dichas dentro de una frase son de quien habla.
  assert.match(ctx.segmentosATexto([s("Gracias por ver el vídeo que os mandé ayer, ahora lo comentamos.")], W).texto, /que os mandé ayer/);
  assert.strictEqual(ctx.segmentosATexto([s("Gracias.")], W).texto, "[00:00] Gracias.", "«gracias» a secas se dice en cualquier reunión");
  const larga = "Para los subtítulos del vídeo de formación podemos usar Amara.org, que es gratis, o pagar a una empresa que nos los haga en tres idiomas.";
  assert.strictEqual(ctx.segmentosATexto([s(larga)], W).texto, "[00:00] " + larga, "una frase de verdad que nombra esa web no es un crédito");
  // Se quita ese segmento y nada más.
  assert.strictEqual(ctx.segmentosATexto([
    seg(2, 4, "Empezamos la reunión."), seg(200, 203, " Subtítulos realizados por la comunidad de Amara.org"), seg(280, 282, "Gracias."),
  ], W).texto, "[00:02] Empezamos la reunión.\n[04:40] Gracias.");
  // Con un modelo que no es Whisper no se filtra: no consta que se las invente.
  assert.strictEqual(ctx.segmentosATexto([s("Gracias por ver el vídeo.")]).texto, "[00:00] Gracias por ver el vídeo.");
  // El eco: Whisper devolviendo como transcripción el `prompt` que se le mandó, entero o por frases.
  const eco = "Reunión de trabajo. Nombres y términos: Odoo, SegElevia.";
  for (const repetido of [" " + eco, "Reunión de trabajo.", "Nombres y términos: Odoo, SegElevia."]) {
    assert.strictEqual(ctx.segmentosATexto([s(repetido)], { whisper: true, eco }).sinVoz, true, repetido);
  }
  assert.match(ctx.segmentosATexto([s("En Odoo y en SegElevia los nombres y términos son distintos.")], { whisper: true, eco }).texto, /son distintos/);
  assert.strictEqual(ctx.segmentosATexto([s("Reunión de trabajo.")], W).texto, "[00:00] Reunión de trabajo.", "sin `prompt` enviado no hay eco que quitar");
});

grupo("3.8 · glosario, idioma y audio para los otros proveedores (offscreen.js)");

test("terminosDe: los asistentes y el glosario, limpios y sin repetir, con los nombres delante", () => {
  const ctx = offscreenVoz(nuevoFetch([]));
  assert.deepStrictEqual([...ctx.terminosDe("Odoo, SegElevia\nodoo,, Banco  de España \r\n", " Marcos,  Ana María ")], ["Marcos", "Ana María", "Odoo", "SegElevia", "Banco de España"]);
  assert.deepStrictEqual([...ctx.terminosDe("", "")], []);
  assert.deepStrictEqual([...ctx.terminosDe(undefined, undefined)], []);
  assert.deepStrictEqual([...ctx.terminosDe("Odoo", "")], ["Odoo"]);
  // Para Whisper (Groq y whisper-1) van redactados como frase: una lista pelada acaba devuelta en el texto.
  assert.strictEqual(ctx.fraseContexto("es", ["Marcos", "Odoo"]), "Reunión de trabajo. Nombres y términos: Marcos, Odoo.");
  assert.strictEqual(ctx.fraseContexto("es", []), "Reunión de trabajo.");
  assert.strictEqual(ctx.fraseContexto("es", ["S.A."]), "Reunión de trabajo. Nombres y términos: S.A.", "sin doble punto final");
  // En el idioma de la reunión, que es en el que tiene que ir; sin idioma fijado, en español.
  assert.strictEqual(ctx.fraseContexto("en", ["Marcos"]), "Work meeting. Names and terms: Marcos.");
  assert.strictEqual(ctx.fraseContexto("", ["Marcos"]), "Reunión de trabajo. Nombres y términos: Marcos.");
  for (const idioma of ["es", "en", "ca", "pt", "fr", "de", "it"]) assert.match(ctx.fraseContexto(idioma, ["Odoo"]), /^\S.+\. \S.+: ?Odoo\.$/, idioma);
  // Whisper solo atiende a 224 tokens: se recorta a 600 caracteres, sin partir ningún término.
  const muchos = Array.from({ length: 200 }, (_, i) => "Término" + i);
  const frase = ctx.fraseContexto("es", muchos);
  assert.ok(frase.length <= 600 && frase.length > 570, "longitud " + frase.length);
  assert.ok(frase.startsWith("Reunión de trabajo. Nombres y términos: Término0, Término1, "));
  const ultimo = /, (Término\d+)\.$/.exec(frase)[1];
  assert.ok(muchos.includes(ultimo), "acaba en un término entero: " + ultimo);
  // Mistral: sin espacios ni comas dentro de un término, y cien como mucho.
  assert.deepStrictEqual([...ctx.sesgoContexto(["Juan Pérez", "Odoo", "Pérez Galdós", "SegElevia, S.L."])], ["Juan", "Pérez", "Odoo", "Galdós", "SegElevia", "S.L."]);
  assert.strictEqual(ctx.sesgoContexto(muchos).length, 100);
  assert.deepStrictEqual([...ctx.sesgoContexto([])], []);
});

test("aWav16k: lo grabado se convierte a WAV mono de 16 kHz y 16 bits; lo importado, que ya lo es, se manda como está", async () => {
  const ctx = offscreenVoz(nuevoFetch([]));
  const muestras = tonoVoz(2);
  const wav = await ctx.aWav16k(blobDe(muestras));
  assert.strictEqual(wav.type, "audio/wav");
  const v = new DataView(wav._partes[0]);
  const txt = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  assert.deepStrictEqual([txt(0), txt(8), v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)],
    ["RIFF", "WAVE", 1, 1, 16000, 16], "PCM, mono, 16 kHz, 16 bits");
  assert.strictEqual(wav.size, 44 + muestras.length * 2, "todas las muestras: 9,6 MB por tramo de cinco minutos");
  assert.ok(Math.abs(v.getInt16(44 + 2 * 100, true) - muestras[100] * 32767) <= 1, "el mismo sonido");
  // Decodifica con un contexto propio a 16 kHz y lo cierra: no deja ninguno abierto por tramo.
  assert.deepStrictEqual(ctx.AudioContext._instancias.map((c) => [c._opciones.sampleRate, c.state]), [[16000, "closed"]]);
  // Ya en WAV (importar.js lo guarda así): el mismo blob, sin decodificar nada.
  const importado = blobDe(muestras, 9600044, "audio/wav");
  assert.strictEqual(await ctx.aWav16k(importado), importado);
  assert.strictEqual(ctx.AudioContext._instancias.length, 1);
  // Lo que no se puede decodificar lanza, y su contexto se cierra igual.
  await assert.rejects(() => ctx.aWav16k(blobDe(null)), /no decodificable/);
  assert.strictEqual(ctx.AudioContext._instancias[1].state, "closed");
  // Varios canales → uno, promediando.
  const dosCanales = function AudioContext() {
    return { async decodeAudioData() { return { numberOfChannels: 2, sampleRate: 16000, length: 2, getChannelData: (c) => Float32Array.from(c ? [0, 0.5] : [1, 0.5]) }; }, async close() {} };
  };
  const estereo = cargar(["proveedores.js", "comun.js", "offscreen.js"], { ...entornoOffscreen(nuevoChrome(), nuevoFetch([])), AudioContext: dosCanales });
  const w = new DataView((await estereo.aWav16k(blobDe(null)))._partes[0]);
  assert.deepStrictEqual([w.getUint16(22, true), w.getUint32(40, true), w.getInt16(44, true), w.getInt16(46, true)], [1, 4, 16383, 16383]);
});

grupo("3.8 · cada proveedor de voz: qué se le manda y cómo se lee lo que devuelve (offscreen.js)");

// Lo que va en el formulario de una petición de transcripción.
const camposDe = (llamada) => llamada.opts.body._campos;
const nombresDeCampo = (llamada) => camposDe(llamada).map(([n]) => n);
const campo = (llamada, nombre) => camposDe(llamada).filter(([n]) => n === nombre).map((c) => c[1]);
const ficheroDe = (llamada) => { const c = camposDe(llamada).find(([n]) => n === "file"); return { blob: c[1], nombre: c[2] }; };
const esWavDe16k = (blob) => {
  const v = new DataView(blob._partes[0]);
  return blob.type === "audio/wav" && v.getUint32(0, false) === 0x52494646 && v.getUint16(22, true) === 1 && v.getUint32(24, true) === 16000;
};
const URL_VOZ = {
  gpt: "https://api.openai.com/v1/audio/transcriptions",
  groq: "https://api.groq.com/openai/v1/audio/transcriptions",
  mistral: "https://api.mistral.ai/v1/audio/transcriptions",
};
// Respuestas con la forma que documenta cada API.
const respGptTexto = (texto, extra = {}) => ({ cuerpo: { text: texto, languages: [{ code: "es" }], ...extra } });
const segW = (start, end, text, extra = {}) => ({ id: 0, seek: 0, start, end, text, tokens: [50364], temperature: 0, ...extra });
const respWhisper = (segments, extra = {}) => ({ cuerpo: { task: "transcribe", language: "spanish", duration: 300, text: segments.map((s) => s.text).join(""), segments, x_groq: { id: "req_1" }, ...extra } });
const segM = (start, end, text, speaker_id) => ({ text, start, end, speaker_id, type: "transcription_segment" });
const respMistral = (segments, extra = {}) => ({
  cuerpo: {
    model: "voxtral-mini-latest", text: segments.map((s) => s.text).join(""), language: null, segments,
    usage: { prompt_audio_seconds: 203, prompt_tokens: 7, total_tokens: 938, completion_tokens: 931, request_count: 1, num_cached_tokens: 0 }, type: "transcription.done", ...extra,
  },
});
// El resultado, en objetos de este lado (los que salen del contexto no comparan con deepStrictEqual).
const plano = (r) => JSON.parse(JSON.stringify(r));

test("OpenAI (gpt-transcribe): el audio tal cual, los nombres y el glosario término a término, y el texto en líneas", async () => {
  const f = nuevoFetch([respGptTexto("Buenos días a todos. Empezamos con el presupuesto.", { usage: { type: "tokens", input_tokens: 900, output_tokens: 120, total_tokens: 1020 } })]);
  const ctx = offscreenVoz(f, { openaiKey: " O ", glosario: "Odoo, a<b>c\nSegElevia", idioma: "es" });
  const tramo = blobDe(null, 1000);
  const r = await ctx.transcribirAudio(tramo, 3, 12, { participantes: "Marcos, Ana", anterior: "[04:50] Hablante 1: seguimos" });
  const [ll] = f._llamadas;
  assert.strictEqual(f._llamadas.length, 1);
  assert.deepStrictEqual([ll.url, ll.metodo], [URL_VOZ.gpt, "POST"]);
  assert.deepStrictEqual({ ...ll.opts.headers }, { Authorization: "Bearer O" }, "sin Content-Type: el separador del formulario lo pone el navegador");
  assert.deepStrictEqual(nombresDeCampo(ll), ["file", "model", "prompt", "keywords[]", "keywords[]", "keywords[]", "keywords[]", "keywords[]", "languages[]"]);
  assert.strictEqual(ficheroDe(ll).blob, tramo, "el webm grabado, sin tocar");
  assert.strictEqual(ficheroDe(ll).nombre, "tramo03.webm", "con extensión, y con el número del tramo");
  assert.deepStrictEqual(campo(ll, "model"), ["gpt-transcribe"]);
  assert.deepStrictEqual(campo(ll, "prompt"), ["Reunión de trabajo."], "contexto, no instrucciones: nada de «TRAMO 3 de 12» ni de «responde SIN_VOZ»");
  assert.deepStrictEqual(campo(ll, "keywords[]"), ["Marcos", "Ana", "Odoo", "a b c", "SegElevia"], "sin «<» ni «>»: con ellos se rechaza la petición entera");
  assert.deepStrictEqual(campo(ll, "languages[]"), ["es"]);
  assert.deepStrictEqual(plano(r), {
    texto: "[00:00] Buenos días a todos. Empezamos con el presupuesto.", truncado: false, uso: { entrada: 900, salida: 120 }, modelo: "gpt-transcribe", prov: "gpt",
  });
  // Como mucho 80 términos.
  const g = nuevoFetch([respGptTexto("Hola.")]);
  const muchos = Array.from({ length: 120 }, (_, i) => "T" + i).join(", ");
  const r2 = await offscreenVoz(g, { openaiKey: "O", glosario: muchos, idioma: "auto" }).transcribirAudio(blobDe(null, 1000));
  assert.strictEqual(campo(g._llamadas[0], "keywords[]").length, 80);
  // Con detección automática no se manda idioma (ni vacío), y sin `usage` no se apunta ningún gasto: desconocido no es cero.
  assert.ok(!nombresDeCampo(g._llamadas[0]).some((n) => /^languages?/.test(n)));
  assert.strictEqual(ficheroDe(g._llamadas[0]).nombre, "tramo01.webm");
  assert.deepStrictEqual(plano(r2), { texto: "[00:00] Hola.", truncado: false, modelo: "gpt-transcribe", prov: "gpt" });
  // Si lo que da es la duración, el gasto va en segundos (se cobra por minuto).
  const d = nuevoFetch([respGptTexto("Hola.", { usage: { type: "duration", seconds: 297 } })]);
  assert.deepStrictEqual(plano((await offscreenVoz(d, { openaiKey: "O" }).transcribirAudio(blobDe(null, 1000))).uso), { segundos: 297 });
});

test("OpenAI (gpt-4o-transcribe-diarize): pide los hablantes, no lleva glosario, y avisa si se queda sin longitud", async () => {
  const dz = (start, end, text, speaker) => ({ type: "transcript.text.segment", id: "seg_" + start, start, end, text, speaker });
  const cuerpo = {
    task: "transcribe", duration: 27.4, text: "Gracias por venir. ¿Empezamos? Cuando quieras.",
    segments: [dz(0.0, 4.7, "Gracias por venir.", "B"), dz(4.9, 11.8, " ¿Empezamos?", "B"), dz(12.4, 15, "Cuando quieras.", "A")],
    usage: { type: "duration", seconds: 27 },
  };
  const f = nuevoFetch([{ cuerpo }]);
  const ctx = offscreenVoz(f, { openaiKey: "O", openaiVoz: "gpt-4o-transcribe-diarize", glosario: "Odoo", idioma: "en" });
  const r = await ctx.transcribirAudio(blobDe(null, 1000), 1, 1, { participantes: "Marcos" });
  const [ll] = f._llamadas;
  assert.strictEqual(ll.url, URL_VOZ.gpt);
  assert.deepStrictEqual(camposDe(ll).slice(1), [["model", "gpt-4o-transcribe-diarize"], ["response_format", "diarized_json"], ["chunking_strategy", "auto"], ["language", "en"]],
    "`language` y no `languages[]`; ni `prompt` ni `keywords[]`, que este modelo no admite");
  assert.deepStrictEqual(plano(r), {
    texto: "[00:00] Hablante 1: Gracias por venir. ¿Empezamos?\n[00:12] Hablante 2: Cuando quieras.", truncado: false, uso: { segundos: 27 },
    modelo: "gpt-4o-transcribe-diarize", prov: "gpt",
  });
  // 2.000 tokens de salida como mucho: si los roza, lo más probable es que haya cortado sin avisar.
  const corta = async (output_tokens) => {
    const g = nuevoFetch([{ cuerpo: { ...cuerpo, duration: 290, usage: { type: "tokens", input_tokens: 5000, output_tokens } } }]);
    return offscreenVoz(g, { openaiKey: "O", openaiVoz: "gpt-4o-transcribe-diarize" }).transcribirAudio(blobDe(null, 1000));
  };
  const cortado = await corta(1995);
  assert.strictEqual(cortado.truncado, true);
  assert.deepStrictEqual(plano(cortado.uso), { segundos: 290 }, "habiendo duración, el gasto se apunta en segundos");
  assert.strictEqual((await corta(1990)).truncado, true);
  assert.strictEqual((await corta(1989)).truncado, false);
  // Con otro modelo de OpenAI ese tope no existe.
  const otro = nuevoFetch([respGptTexto("Hola.", { usage: { type: "tokens", input_tokens: 9000, output_tokens: 4000 } })]);
  assert.strictEqual((await offscreenVoz(otro, { openaiKey: "O" }).transcribirAudio(blobDe(null, 1000))).truncado, false);
});

test("Groq (Whisper): el nombre del fichero con .webm, el glosario como frase, y los segmentos con su marca de tiempo", async () => {
  const f = nuevoFetch([respWhisper([
    segW(43.92, 50.16, " Primer punto: hay que cerrar el presupuesto", { avg_logprob: -0.09, compression_ratio: 1.66, no_speech_prob: 0.01 }),
    segW(50.2, 53, " antes del viernes."),
    segW(120, 124, " Subtítulos realizados por la comunidad de Amara.org", { avg_logprob: -0.2, no_speech_prob: 0.5 }),
    segW(200, 203, " ruido", { avg_logprob: -1.3, no_speech_prob: 0.8 }),
    segW(230, 236, " Reunión de trabajo. Nombres y términos: Marcos, Ana, Odoo."),
    segW(250.7, 255, " De acuerdo."),
  ], { duration: "300.5" })]);
  const ctx = offscreenVoz(f, { groqKey: "Q", glosario: "Odoo", idioma: "es" });
  const tramo = blobDe(null, 1000);
  const r = await ctx.transcribirAudio(tramo, 2, 3, { participantes: "Marcos, Ana" });
  const [ll] = f._llamadas;
  assert.deepStrictEqual([ll.url, ll.metodo], [URL_VOZ.groq, "POST"]);
  assert.deepStrictEqual({ ...ll.opts.headers }, { Authorization: "Bearer Q" });
  assert.strictEqual(ficheroDe(ll).blob, tramo);
  assert.strictEqual(ficheroDe(ll).nombre, "tramo02.webm", "Groq elige el decodificador por la extensión del nombre");
  assert.deepStrictEqual(camposDe(ll).slice(1), [
    ["model", "whisper-large-v3"], ["response_format", "verbose_json"], ["timestamp_granularities[]", "segment"], ["temperature", "0"], ["language", "es"],
    ["prompt", "Reunión de trabajo. Nombres y términos: Marcos, Ana, Odoo."],
  ]);
  // El esquema de Groq es cerrado: un campo de más (los de OpenAI, por ejemplo) sería un 400.
  const admitidos = ["file", "url", "model", "language", "prompt", "response_format", "temperature", "timestamp_granularities[]"];
  assert.deepStrictEqual(nombresDeCampo(ll).filter((n) => !admitidos.includes(n)), []);
  assert.deepStrictEqual(plano(r), {
    texto: "[00:43] " + comun.SIN_HABLANTE + "Primer punto: hay que cerrar el presupuesto antes del viernes.\n[04:10] De acuerdo.",
    truncado: false, uso: { segundos: 300.5 }, modelo: "whisper-large-v3", prov: "groq",
  }, "sin hablantes; fuera lo inventado, lo que el propio Whisper da por no hablado y el eco del `prompt`; `duration` llega como texto");
  assert.deepStrictEqual(comun.hablantesDe(r.texto), []);
  // Con detección automática `language` se omite (vacío lo rechaza), y el modelo es el elegido en Opciones.
  const g = nuevoFetch([respWhisper([segW(0, 2, " Hola.")])]);
  const r2 = await offscreenVoz(g, { groqKey: "Q", groqVoz: "whisper-large-v3-turbo", idioma: "auto" }).transcribirAudio(blobDe(null, 1000));
  assert.deepStrictEqual(camposDe(g._llamadas[0]).slice(1), [
    ["model", "whisper-large-v3-turbo"], ["response_format", "verbose_json"], ["timestamp_granularities[]", "segment"], ["temperature", "0"], ["prompt", "Reunión de trabajo."],
  ]);
  assert.strictEqual(r2.modelo, "whisper-large-v3-turbo");
  // `segments` puede faltar: el texto no se pierde, va sin tiempos.
  const sinSeg = nuevoFetch([{ cuerpo: { text: " Hola a todos. Empezamos.", language: "spanish", duration: 12 } }]);
  assert.deepStrictEqual(plano(await offscreenVoz(sinSeg, { groqKey: "Q" }).transcribirAudio(blobDe(null, 1000))),
    { texto: "[00:00] Hola a todos. Empezamos.", truncado: false, uso: { segundos: 12 }, modelo: "whisper-large-v3", prov: "groq" });
  // Silencio: ni un segmento con texto, o solo lo inventado → tramo sin voz, sin texto.
  for (const mudo of [respWhisper([]), respWhisper([segW(0, 30, " Gracias por ver el vídeo.")]), { cuerpo: { text: "  ", segments: [] } }, { cuerpo: { text: " Thanks for watching!" } }]) {
    const m = nuevoFetch([mudo]);
    assert.deepStrictEqual(plano(await offscreenVoz(m, { groqKey: "Q" }).transcribirAudio(blobDe(null, 1000))), { texto: "", sinVoz: true, modelo: "whisper-large-v3", prov: "groq" });
    assert.strictEqual(m._llamadas.length, 1, "el silencio no se reintenta");
  }
});

test("OpenAI (whisper-1): el mismo Whisper que Groq, en la dirección y con la clave de OpenAI", async () => {
  const f = nuevoFetch([respWhisper([segW(0.0, 3.32, " Empezamos la reunión.", { avg_logprob: -0.28, compression_ratio: 1.23, no_speech_prob: 0.0098 })],
    { duration: 3.32, usage: { type: "duration", seconds: 4 } })]);
  const ctx = offscreenVoz(f, { openaiKey: "O", openaiVoz: "whisper-1", glosario: "Odoo", idioma: "es" });
  const r = await ctx.transcribirAudio(blobDe(null, 1000), 1, 1, {});
  const [ll] = f._llamadas;
  assert.strictEqual(ll.url, URL_VOZ.gpt);
  assert.deepStrictEqual({ ...ll.opts.headers }, { Authorization: "Bearer O" });
  assert.deepStrictEqual(camposDe(ll).slice(1), [
    ["model", "whisper-1"], ["response_format", "verbose_json"], ["timestamp_granularities[]", "segment"], ["temperature", "0"], ["language", "es"],
    ["prompt", "Reunión de trabajo. Nombres y términos: Odoo."],
  ]);
  assert.deepStrictEqual(plano(r), { texto: "[00:00] Empezamos la reunión.", truncado: false, uso: { segundos: 4 }, modelo: "whisper-1", prov: "gpt" },
    "lo que cobra es lo de `usage`, no la duración exacta");
});

test("Mistral (Voxtral): siempre en WAV, con hablantes y tiempos; el glosario, palabra a palabra, y sin idioma", async () => {
  const f = nuevoFetch([respMistral([
    segM(0.8, 2.1, " Buenos días.", "speaker_2"), segM(2.4, 5, " Empezamos por el presupuesto.", "speaker_2"),
    segM(6.1, 7, " Perfecto.", "speaker_1"), segM(null, null, " Y luego los plazos.", "speaker_2"),
  ])]);
  const ctx = offscreenVoz(f, { mistralKey: "M", glosario: "Juan Pérez, Odoo", idioma: "es" });
  const muestras = tonoVoz(1);
  const r = await ctx.transcribirAudio(blobDe(muestras), 1, 2, { participantes: "Ana María" });
  const [ll] = f._llamadas;
  assert.deepStrictEqual([ll.url, ll.metodo], [URL_VOZ.mistral, "POST"]);
  assert.deepStrictEqual({ ...ll.opts.headers }, { Authorization: "Bearer M" }, "Bearer, no el x-api-key de sus ejemplos");
  assert.deepStrictEqual(camposDe(ll).slice(1), [
    ["model", "voxtral-mini-latest"], ["diarize", "true"], ["timestamp_granularities", "segment"],
    ["context_bias", "Ana"], ["context_bias", "María"], ["context_bias", "Juan"], ["context_bias", "Pérez"], ["context_bias", "Odoo"],
  ], "sin `language` (incompatible con las marcas de tiempo) y sin `prompt` (no tiene)");
  const { blob, nombre } = ficheroDe(ll);
  assert.strictEqual(nombre, "tramo01.wav");
  assert.ok(esWavDe16k(blob), "el webm de Chrome no se le manda: va convertido");
  assert.strictEqual(blob.size, 44 + muestras.length * 2);
  assert.deepStrictEqual(plano(r), {
    texto: "[00:00] Hablante 1: Buenos días. Empezamos por el presupuesto.\n[00:06] Hablante 2: Perfecto.\nHablante 1: Y luego los plazos.",
    truncado: false, uso: { segundos: 203 }, modelo: "voxtral-mini-latest", prov: "mistral",
  });
  // Lo importado ya es WAV: va el mismo fichero, sin decodificar nada.
  const g = nuevoFetch([respMistral([segM(1, 2, " Hola.", "speaker_1")])]);
  const ctx2 = offscreenVoz(g, { mistralKey: "M" });
  const importado = blobDe(muestras, 9600044, "audio/wav");
  await ctx2.transcribirAudio(importado, 4, 9);
  assert.deepStrictEqual(ficheroDe(g._llamadas[0]), { blob: importado, nombre: "tramo04.wav" });
  assert.strictEqual(ctx2.AudioContext._instancias.length, 0);
  // Un audio que no se puede convertir no llega a la red, y el error lo dice.
  const h = nuevoFetch([]);
  const e = await offscreenVoz(h, { mistralKey: "M" }).transcribirAudio(blobDe(null)).then(() => null, (x) => x);
  assert.strictEqual(e.codigo, "otro");
  assert.match(e.message, /No se pudo convertir el audio a WAV para enviarlo a Mistral: audio no decodificable/);
  assert.strictEqual(h._llamadas.length, 0);
});

grupo("3.8 · cada proveedor de voz: errores, reintentos y modelos de reserva (offscreen.js)");

// [id, configuración con su clave, nombre en los errores, sus modelos por orden, una respuesta buena]
const VOCES = [
  ["gpt", { openaiKey: "O" }, "OpenAI", ["gpt-transcribe", "gpt-4o-transcribe-diarize", "whisper-1"], () => respGptTexto("Hola a todos.")],
  ["groq", { groqKey: "Q" }, "Groq", ["whisper-large-v3", "whisper-large-v3-turbo"], () => respWhisper([segW(0, 2, " Hola a todos.")])],
  ["mistral", { mistralKey: "M" }, "Mistral", ["voxtral-mini-latest"], () => respMistral([segM(0, 2, " Hola a todos.", "speaker_1")])],
];
// Lo intenta y devuelve el error (o null si salió bien). El tramo se puede decodificar: Mistral lo necesita.
async function falloVoz(respuestas, cfg, esperas = []) {
  const f = nuevoFetch(respuestas);
  const e = await offscreenVoz(f, cfg, TODA_LA_VOZ, esperas).transcribirAudio(blobDe(tonoVoz(1))).then(() => null, (x) => x);
  return { e, f, modelos: f._llamadas.map((ll) => campo(ll, "model")[0]) };
}
const veces = (n, r) => Array.from({ length: n }, () => r);

test("clave rechazada (401, 403): fatal, una sola petición, sin reintentos ni modelos de reserva", async () => {
  // Los cuerpos reales: el de OpenAI llega como text/plain, con saltos de línea y un `status` suelto.
  const cuerpos = {
    gpt: '{\n    "error": {\n        "message": "Incorrect API key provided: sk-inval***-000.",\n        "type": "invalid_request_error",\n        "param": null,\n        "code": "invalid_api_key"\n    },\n    "status": 401\n}',
    groq: '{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}',
    mistral: '{"detail":"Invalid API Key"}',
  };
  const detalles = { gpt: "Incorrect API key provided: sk-inval***-000.", groq: "Invalid API Key", mistral: "Invalid API Key" };
  for (const [id, cfg, nombre, modelos] of VOCES) {
    const { e, f } = await falloVoz([{ status: 401, cuerpo: cuerpos[id] }], cfg);
    assert.deepStrictEqual([e.codigo, e.fatal, f._llamadas.length], ["clave_invalida", true, 1], id);
    assert.strictEqual(e.message, `${nombre} HTTP 401 (${modelos[0]}): ${detalles[id]}`, "quién, qué código y qué dice, sin el JSON");
    const prohibido = await falloVoz([{ status: 403, cuerpo: '{"error":{"message":"Country not supported"}}' }], cfg);
    assert.deepStrictEqual([prohibido.e.codigo, prohibido.e.fatal, prohibido.f._llamadas.length], ["clave_invalida", true, 1], id + " 403");
  }
});

test("sin saldo (402, y el 429 de OpenAI que en realidad lo dice): fatal, no se arregla esperando", async () => {
  for (const [id, cfg, nombre] of VOCES) {
    const { e, f } = await falloVoz([{ status: 402, cuerpo: '{"error":{"message":"Insufficient Balance"}}' }], cfg);
    assert.deepStrictEqual([e.codigo, e.fatal, f._llamadas.length], ["sin_saldo", true, 1], id);
    assert.match(e.message, new RegExp(`^${nombre} HTTP 402 `));
  }
  for (const code of ["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]) {
    const esperas = [];
    const { e, f } = await falloVoz([{ status: 429, cabeceras: { "Retry-After": "20" }, cuerpo: JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota", param: null, code } }) }], { openaiKey: "O" }, esperas);
    assert.deepStrictEqual([e.codigo, e.fatal, f._llamadas.length, esperas.length], ["sin_saldo", true, 1, 0], code);
  }
  assert.ok(comun.CODIGOS_CLAVE.includes("sin_saldo"), "y la ronda se para ahí, como con una clave rechazada");
});

test("ritmo (429) y saturación (503, 529…): se reintenta esperando lo que pide la API, y el tramo acaba transcrito", async () => {
  // El 429 real de Mistral trae type «rate_limited», no el de su documentación: se decide por el código HTTP.
  const ritmo = { status: 429, cabeceras: { "Retry-After": "12" }, cuerpo: '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300"}' };
  for (const [id, cfg, , modelos, buena] of VOCES) {
    const esperas = [];
    const f = nuevoFetch([ritmo, { status: 503, cuerpo: '{"error":{"message":"The server is overloaded","type":"service_unavailable_error","code":"server_is_overloaded"}}' }, { status: 529, cuerpo: "" }, buena()]);
    const r = await offscreenVoz(f, cfg, TODA_LA_VOZ, esperas).transcribirAudio(blobDe(tonoVoz(1)));
    assert.match(r.texto, /Hola a todos\./, id);
    assert.deepStrictEqual(f._llamadas.map((ll) => campo(ll, "model")[0]), veces(4, modelos[0]), id + ": con el mismo modelo");
    assert.deepStrictEqual(esperas, [12000, 8000, 20000], id + ": Retry-After cuando lo hay; si no, la espera propia de ese intento");
  }
  // Tope de un minuto: Groq, con el cupo de la hora gastado, puede pedir mucho más.
  const largas = [];
  await offscreenVoz(nuevoFetch([{ status: 429, cabeceras: { "retry-after": "600" }, cuerpo: "{}" }, VOCES[1][4]()]), { groqKey: "Q" }, TODA_LA_VOZ, largas).transcribirAudio(blobDe(null, 1000));
  assert.deepStrictEqual(largas, [60000]);
  // Si no se le pasa: el intento y tres reintentos con cada modelo, y el fallo dice que es saturación.
  for (const [id, cfg, nombre, modelos] of VOCES) {
    const esperas = [];
    const { e, f, modelos: pedidos } = await falloVoz(veces(20, { status: 503, cuerpo: "{}" }), cfg, esperas);
    assert.deepStrictEqual([e.codigo, e.reintentable, !!e.fatal], ["saturado", true, false], id);
    assert.deepStrictEqual(pedidos, modelos.flatMap((m) => veces(4, m)), id);
    assert.strictEqual(f._llamadas.length, 4 * modelos.length);
    assert.deepStrictEqual(esperas, modelos.flatMap(() => [3000, 8000, 20000]), id);
    assert.strictEqual(e.message, `${nombre} HTTP 503 (${modelos[modelos.length - 1]})`, "sin detalle no se inventa uno");
  }
  for (const status of [408, 429, 500, 502, 503, 504, 529]) {
    const { e } = await falloVoz(veces(20, { status, cuerpo: "{}" }), { mistralKey: "M" });
    assert.strictEqual(e.codigo, "saturado", "HTTP " + status);
  }
});

test("corte de red: se reintenta, y si no vuelve el fallo es de conexión, no de la clave ni del modelo", async () => {
  for (const [id, cfg, nombre, modelos, buena] of VOCES) {
    const esperas = [];
    const f = nuevoFetch([{ lanza: "ECONNRESET" }, { lanza: "Failed to fetch" }, buena()]);
    const r = await offscreenVoz(f, cfg, TODA_LA_VOZ, esperas).transcribirAudio(blobDe(tonoVoz(1)));
    assert.match(r.texto, /Hola a todos\./, id);
    assert.deepStrictEqual([f._llamadas.length, esperas], [3, [3000, 8000]], id);
    const sinRed = await falloVoz(veces(20, { lanza: "ECONNRESET" }), cfg);
    assert.deepStrictEqual([sinRed.e.codigo, sinRed.e.reintentable, sinRed.f._llamadas.length], ["red", true, 4 * modelos.length], id);
    assert.strictEqual(sinRed.e.message, `Sin conexión con ${nombre}: ECONNRESET`);
  }
});

test("si el modelo ya no existe (404) se pasa al siguiente sin esperar, cada uno con SU formulario", async () => {
  const noExiste = { status: 404, cuerpo: '{"error":{"message":"The model `x` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}' };
  // Groq: del v3 al turbo.
  const esperas = [];
  let f = nuevoFetch([noExiste, respWhisper([segW(0, 2, " Hola.")])]);
  let r = await offscreenVoz(f, { groqKey: "Q" }, TODA_LA_VOZ, esperas).transcribirAudio(blobDe(null, 1000));
  assert.deepStrictEqual(f._llamadas.map((ll) => campo(ll, "model")[0]), ["whisper-large-v3", "whisper-large-v3-turbo"]);
  assert.deepStrictEqual([r.modelo, r.texto, esperas.length], ["whisper-large-v3-turbo", "[00:00] Hola.", 0], "el tramo apunta el modelo que contestó");
  // OpenAI: el de hablantes se apaga el 26/02/2027. Elegido y ya apagado, se sigue con gpt-transcribe, que pide otros campos.
  f = nuevoFetch([noExiste, respGptTexto("Hola.")]);
  r = await offscreenVoz(f, { openaiKey: "O", openaiVoz: "gpt-4o-transcribe-diarize", glosario: "Odoo" }).transcribirAudio(blobDe(null, 1000));
  assert.deepStrictEqual(f._llamadas.map((ll) => nombresDeCampo(ll)), [
    ["file", "model", "response_format", "chunking_strategy", "language"],
    ["file", "model", "prompt", "keywords[]", "languages[]"],
  ]);
  assert.deepStrictEqual([r.modelo, r.texto], ["gpt-transcribe", "[00:00] Hola."]);
  // Un modelo escrito a mano va primero, y detrás los del registro.
  f = nuevoFetch([noExiste, noExiste, respWhisper([segW(0, 2, " Hola.")])]);
  r = await offscreenVoz(f, { groqKey: "Q", groqVoz: "whisper-nuevo" }).transcribirAudio(blobDe(null, 1000));
  assert.deepStrictEqual(f._llamadas.map((ll) => campo(ll, "model")[0]), ["whisper-nuevo", "whisper-large-v3", "whisper-large-v3-turbo"]);
  // Si no queda ninguno, el fallo es el del último y no se reintenta: un 404 no se arregla esperando.
  for (const [id, cfg, , modelos] of VOCES) {
    const esperas2 = [];
    const { e, modelos: pedidos } = await falloVoz(veces(5, noExiste), cfg, esperas2);
    assert.deepStrictEqual([e.codigo, !!e.fatal, !!e.reintentable, esperas2.length], ["otro", false, false, 0], id);
    assert.deepStrictEqual(pedidos, modelos, id);
  }
});

test("un 200 que no se entiende NO es un tramo sin voz: es un fallo, y el audio no se da por transcrito", async () => {
  for (const cuerpo of ["<html><body>502 Bad Gateway</body></html>", "", "null", "[]", '"texto"', "{}", '{"model":"voxtral-mini-latest"}', '{"text":17}']) {
    for (const [id, cfg, nombre, modelos] of VOCES) {
      const { e, f } = await falloVoz(veces(20, { status: 200, cuerpo }), cfg);
      assert.ok(e, `${id}: «${cuerpo}» no puede darse por bueno`);
      assert.deepStrictEqual([e.codigo, e.reintentable, f._llamadas.length], ["otro", true, 4 * modelos.length], `${id}: «${cuerpo}»`);
      assert.match(e.message, new RegExp(`^${nombre} \\(.+\\) devolvió una respuesta que Escriba no sabe leer`));
    }
  }
  // Lo que sí dice «aquí no hay nada»: el texto vacío o la lista de segmentos vacía.
  for (const cuerpo of ['{"text":""}', '{"segments":[]}', '{"text":" ","segments":[{"text":"  ","start":0,"end":1}]}']) {
    for (const [id, cfg] of VOCES) {
      const f = nuevoFetch([{ status: 200, cuerpo }]);
      const r = await offscreenVoz(f, cfg).transcribirAudio(blobDe(tonoVoz(1)));
      assert.deepStrictEqual([r.sinVoz, r.texto], [true, ""], `${id}: «${cuerpo}»`);
    }
  }
  // Un corte a mitad de respuesta es un fallo de red, como si no hubiera llegado.
  const cortada = async () => ({ ok: true, status: 200, headers: { get: () => null }, async text() { throw new Error("network error"); } });
  const e = await offscreenVoz(cortada, { groqKey: "Q" }).transcribirAudio(blobDe(null, 1000)).then(() => null, (x) => x);
  assert.deepStrictEqual([e.codigo, e.reintentable], ["red", true]);
});

test("la red de OpenAI y Groq: si rechazan el audio de Chrome, la misma petición se repite UNA vez con el tramo en WAV", async () => {
  const rechazo = (msg, status = 400) => ({ status, cuerpo: JSON.stringify({ error: { message: msg, type: "invalid_request_error" } }) });
  const noDecodifica = rechazo("could not process file - is it a valid media file?");
  const ficheros = (f) => f._llamadas.map((ll) => `${campo(ll, "model")[0]} ${ficheroDe(ll).nombre} ${ficheroDe(ll).blob.type}`);
  for (const [id, cfg, , modelos, buena] of VOCES.slice(0, 2)) {
    const esperas = [];
    const f = nuevoFetch([noDecodifica, buena()]);
    const ctx = offscreenVoz(f, cfg, TODA_LA_VOZ, esperas);
    const tramo = blobDe(tonoVoz(1));
    const r = await ctx.transcribirAudio(tramo, 7, 9);
    assert.match(r.texto, /Hola a todos\./, id);
    assert.deepStrictEqual(ficheros(f), [`${modelos[0]} tramo07.webm audio/webm`, `${modelos[0]} tramo07.wav audio/wav`], id + ": el mismo modelo, ahora en WAV");
    assert.strictEqual(ficheroDe(f._llamadas[0]).blob, tramo);
    assert.ok(esWavDe16k(ficheroDe(f._llamadas[1]).blob));
    assert.deepStrictEqual(camposDe(f._llamadas[1]).slice(1), camposDe(f._llamadas[0]).slice(1), "todo lo demás, igual");
    assert.strictEqual(esperas.length, 0, "sin esperar: no es un fallo pasajero");
    assert.deepStrictEqual(ctx.AudioContext._instancias.map((c) => c.state), ["closed"]);
  }
  // También con un 415, y con las palabras de cada uno.
  for (const r of [rechazo("Unsupported media type", 415), rechazo("Audio file might be corrupted or unsupported"), rechazo("Invalid file format. Supported formats: ['flac', 'm4a', 'mp3', 'wav', 'webm']"), rechazo("Audio input could not be decoded")]) {
    const f = nuevoFetch([r, VOCES[0][4]()]);
    await offscreenVoz(f, { openaiKey: "O" }).transcribirAudio(blobDe(tonoVoz(1)));
    assert.deepStrictEqual(ficheros(f).map((x) => x.split(" ")[1]), ["tramo01.webm", "tramo01.wav"], r.cuerpo);
  }
  // Una vez nada más: si en WAV tampoco, se sigue con el modelo siguiente (ya en WAV) y no se convierte otra vez.
  let f = nuevoFetch([noDecodifica, noDecodifica, noDecodifica, respWhisper([segW(0, 2, " Hola.")])]);
  let ctx = offscreenVoz(f, { groqKey: "Q", groqVoz: "whisper-nuevo" });
  await ctx.transcribirAudio(blobDe(tonoVoz(1)));
  assert.deepStrictEqual(ficheros(f), [
    "whisper-nuevo tramo01.webm audio/webm", "whisper-nuevo tramo01.wav audio/wav", "whisper-large-v3 tramo01.wav audio/wav", "whisper-large-v3-turbo tramo01.wav audio/wav",
  ]);
  assert.strictEqual(ctx.AudioContext._instancias.length, 1, "una sola conversión");
  // Un 400 que no habla del audio no es cosa del formato: no se convierte nada.
  f = nuevoFetch([rechazo("The model `whisper-large-v3` has been decommissioned."), respWhisper([segW(0, 2, " Hola.")])]);
  ctx = offscreenVoz(f, { groqKey: "Q" });
  await ctx.transcribirAudio(blobDe(tonoVoz(1)));
  assert.deepStrictEqual(ficheros(f), ["whisper-large-v3 tramo01.webm audio/webm", "whisper-large-v3-turbo tramo01.webm audio/webm"]);
  assert.strictEqual(ctx.AudioContext._instancias.length, 0);
  // Lo importado ya iba en WAV: no hay nada que repetir.
  f = nuevoFetch([noDecodifica, respWhisper([segW(0, 2, " Hola.")])]);
  await offscreenVoz(f, { groqKey: "Q" }).transcribirAudio(blobDe(tonoVoz(1), 9600044, "audio/wav"));
  assert.deepStrictEqual(ficheros(f), ["whisper-large-v3 tramo01.wav audio/wav", "whisper-large-v3-turbo tramo01.wav audio/wav"]);
  // Si el tramo no se puede convertir, vale el rechazo: se sigue como con cualquier otro 400.
  const g = nuevoFetch([noDecodifica, noDecodifica]);
  const ctxG = offscreenVoz(g, { groqKey: "Q" });
  const e = await ctxG.transcribirAudio(blobDe(null, 1000)).then(() => null, (x) => x);
  assert.strictEqual(ctxG.AudioContext._instancias.length, 1, "y la conversión no se vuelve a intentar con cada modelo");
  assert.deepStrictEqual(ficheros(g), ["whisper-large-v3 tramo01.webm audio/webm", "whisper-large-v3-turbo tramo01.webm audio/webm"]);
  assert.match(e.message, /^Groq HTTP 400 \(whisper-large-v3-turbo\): could not process file/);
  // Mistral ya recibe WAV desde el principio: su rechazo no se repite.
  const m = await falloVoz([rechazo("Audio input could not be decoded")], { mistralKey: "M" });
  assert.deepStrictEqual([m.e.codigo, m.f._llamadas.length], ["otro", 1]);
});

grupo("3.8 · quién transcribe: interruptores, y Gemini como siempre (offscreen.js)");

test("interruptores: con la voz apagada un proveedor no transcribe, aunque tenga clave y se le elija", async () => {
  const claves = { openaiKey: "O", mistralKey: "M", groqKey: "Q", claudeKey: "C", deepseekKey: "D", provTranscribe: "groq" };
  // Estado de salida (nada encendido en el test): solo transcribe Gemini, y aquí no hay clave suya.
  let f = nuevoFetch([]);
  let ctx = offscreenVoz(f, claves, []);
  const e = await ctx.transcribirAudio(blobDe(null, 1000)).then(() => null, (x) => x);
  assert.strictEqual(e.codigo, "sin_clave");
  assert.ok(!e.fatal, "se queda esperando una clave, como siempre");
  assert.strictEqual(f._llamadas.length, 0, "ni una petición a nadie");
  // Con clave de Gemini transcribe Gemini: elegir a uno apagado no cuenta.
  f = nuevoFetch([respGemini("[00:01] Hablante 1: hola")]);
  ctx = offscreenVoz(f, { ...claves, geminiKey: "G" }, []);
  const r = await ctx.transcribirAudio(blobDe(null, 1000));
  assert.match(f._llamadas[0].url, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.deepStrictEqual([r.prov, r.texto], ["gemini", "[00:01] Hablante 1: hola"]);
  // Tampoco llamándolo por su nombre: lo apagado, lo que no transcribe y lo que no existe se rechazan sin tocar la red.
  for (const id of ["groq", "gpt", "mistral", "claude", "deepseek", "meta", "constructor", "", undefined]) {
    const x = await ctx.transcribirConProveedor(id, { ...claves, geminiKey: "G" }, blobDe(null, 1000)).then(() => null, (y) => y);
    assert.ok(x && x.fatal && /desconocido/.test(x.message), String(id));
  }
  assert.strictEqual(f._llamadas.length, 1);
  // Se enciende cambiando el valor del registro, y entonces sí.
  f = nuevoFetch([respWhisper([segW(0, 2, " Hola.")])]);
  ctx = offscreenVoz(f, claves, ["groq.voz"]);
  assert.strictEqual((await ctx.transcribirAudio(blobDe(null, 1000))).prov, "groq");
  // Encendido pero sin su clave: lo dice, y no usa la de otro.
  const sinClave = await ctx.transcribirConProveedor("groq", { openaiKey: "O", groqKey: "  " }, blobDe(null, 1000)).then(() => null, (y) => y);
  assert.deepStrictEqual([sinClave.codigo, sinClave.message], ["sin_clave", "Falta la clave de Groq en Opciones."]);
  assert.strictEqual(f._llamadas.length, 1);
});

test("con Gemini, transcribirAudio manda exactamente lo mismo que transcribirGemini, y además dice quién fue y con qué modelo", async () => {
  const cfg = { geminiKey: "K", geminiModel: "gemini-flash-latest", glosario: "Odoo", idioma: "es" };
  const opciones = { participantes: "Ana", anterior: "[04:58] Hablante 2: cierro" };
  const conUso = { cuerpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "[00:01] Hablante 1: hola" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } } };
  const fa = nuevoFetch([conUso]), fb = nuevoFetch([conUso]);
  const a = await offscreen(fa, cfg).transcribirGemini(blobDe(null, 1000), 2, 5, opciones);
  // Con todas las voces encendidas y todas las claves puestas: en automático, quien tiene clave de Gemini sigue con Gemini.
  const b = await offscreenVoz(fb, { ...cfg, openaiKey: "O", mistralKey: "M", groqKey: "Q" }).transcribirAudio(blobDe(null, 1000), 2, 5, opciones);
  const peticion = (ll) => [ll.url, ll.metodo, Object.entries(ll.opts.headers), ll.opts.body];
  assert.deepStrictEqual(fb._llamadas.map(peticion), fa._llamadas.map(peticion));
  assert.strictEqual(fb._llamadas.length, 1);
  assert.deepStrictEqual(plano(b), { ...plano(a), prov: "gemini" });
  assert.deepStrictEqual(plano(b), { texto: "[00:01] Hablante 1: hola", truncado: false, uso: { entrada: 10, salida: 3 }, modelo: "gemini-flash-latest", prov: "gemini" });
  // Si contesta uno de reserva, el modelo apuntado es ese, no el elegido.
  const fc = nuevoFetch([{ status: 404, cuerpo: "modelo no encontrado" }, conUso]);
  assert.strictEqual((await offscreenVoz(fc, cfg, []).transcribirAudio(blobDe(null, 1000))).modelo, "gemini-2.5-flash");
  // SIN_VOZ sigue siendo un tramo sin voz.
  const fd = nuevoFetch([respGemini("SIN_VOZ")]);
  assert.deepStrictEqual(plano(await offscreenVoz(fd, cfg, []).transcribirAudio(blobDe(null, 1000))), { texto: "", sinVoz: true, prov: "gemini" });
  // Sin clave, el mismo fallo de siempre y sin tocar la red.
  const fe = nuevoFetch([]);
  const e = await offscreenVoz(fe, {}, []).transcribirAudio(blobDe(null, 1000)).then(() => null, (x) => x);
  const antes = await offscreen(nuevoFetch([]), { geminiKey: "", geminiModel: "", glosario: "" }).transcribirGemini(blobDe(null, 1000)).then(() => null, (x) => x);
  assert.deepStrictEqual([e.codigo, e.message], [antes.codigo, antes.message]);
  assert.strictEqual(fe._llamadas.length, 0);
  // Y si la configuración no llega, sigue siendo un fallo interno, no «falta la clave».
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? { ok: false, error: "reiniciando" } : { ok: true });
  const sinCfg = await cargar(["proveedores.js", "comun.js", "offscreen.js"], entornoOffscreen(chrome, nuevoFetch([]))).transcribirAudio(blobDe(null, 1000)).then(() => null, (x) => x);
  assert.strictEqual(sinCfg.codigo, "interno");
});

test("el Diagnóstico transcribe su prueba con quien toque: Gemini si tiene clave y, si no, el que la tenga", async () => {
  // Un documento offscreen que «oye» algo: con el analizador a cero la prueba se da por silencio y no se manda a nadie.
  const conSonido = (fetchStub, cfg, encendidos) => {
    const chrome = nuevoChrome();
    chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? { geminiKey: "", glosario: "", idioma: "es", ...cfg } : { ok: true });
    const medios = nuevosMedios({ conAudio: true });
    const base = nuevoAudioContext();
    const AudioContext = function (o) { const c = base(o); c.createAnalyser = () => ({ fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0.2); } }); return c; };
    const entorno = {
      ...entornoOffscreen(chrome, fetchStub), AudioContext, navigator: { mediaDevices: medios.mediaDevices }, MediaRecorder: medios.MediaRecorder,
      Audio: nuevoAudioElemento(), setInterval: (fn) => { setImmediate(fn); return 1; },
    };
    return encender(cargar(["proveedores.js", "comun.js", "offscreen.js"], entorno), ...encendidos);
  };
  let f = nuevoFetch([respGemini("[00:01] Hablante 1: probando")]);
  let r = await conSonido(f, { geminiKey: "K", groqKey: "Q" }, ["groq.voz"]).selftest({ modo: "mic" });
  assert.deepStrictEqual([r.ok, r.silencio, r.transcripcion], [true, false, "[00:01] Hablante 1: probando"], JSON.stringify(r));
  assert.match(f._llamadas[0].url, /generativelanguage\.googleapis\.com.*generateContent$/);
  f = nuevoFetch([respWhisper([segW(0.2, 2.8, " probando, uno, dos")])]);
  r = await conSonido(f, { groqKey: "Q" }, ["groq.voz"]).selftest({ modo: "mic" });
  assert.deepStrictEqual([r.ok, r.transcripcion], [true, "[00:00] probando, uno, dos"], JSON.stringify(r));
  assert.deepStrictEqual([f._llamadas[0].url, ficheroDe(f._llamadas[0]).nombre], [URL_VOZ.groq, "tramo01.webm"]);
  // Sin voz, el texto de siempre; y un fallo del proveedor se enseña con su nombre.
  f = nuevoFetch([respWhisper([])]);
  assert.strictEqual((await conSonido(f, { groqKey: "Q" }, ["groq.voz"]).selftest({ modo: "mic" })).transcripcion, "(el modelo no oyó voz)");
  f = nuevoFetch([{ status: 401, cuerpo: '{"error":{"message":"Invalid API Key"}}' }]);
  assert.strictEqual((await conSonido(f, { groqKey: "Q" }, ["groq.voz"]).selftest({ modo: "mic" })).errorTranscripcion, "Groq HTTP 401 (whisper-large-v3): Invalid API Key");
  // Con la voz apagada, la clave de Groq no sirve para la prueba: falta la de quien transcribe.
  f = nuevoFetch([]);
  r = await conSonido(f, { groqKey: "Q" }, []).selftest({ modo: "mic" });
  assert.match(r.errorTranscripcion, /Falta la clave/);
  assert.strictEqual(f._llamadas.length, 0);
});

grupo("3.8 · el motor de transcripción con otro proveedor");

// El sistema completo con las voces encendidas en los DOS contextos: el service
// worker decide si hay con quién transcribir, y el documento offscreen transcribe.
function sistemaVoz(opciones, encendidos = TODA_LA_VOZ, crear = sistema) {
  const s = crear(opciones);
  encender(s.bgCtx, ...encendidos);
  encender(s.off, ...encendidos);
  return s;
}
const whisperDe = (texto, inicio = 10) => respWhisper([segW(inicio, inicio + 4, " " + texto)]);
// Las rondas que el service worker le pide al documento offscreen, según se van pidiendo.
function rondasPedidas(s) {
  const enviar = s.chrome.runtime.sendMessage, pedidas = [];
  s.chrome.runtime.sendMessage = (msg) => { if (msg.target === "offscreen" && msg.cmd === "transcribir") pedidas.push(msg.id); return enviar(msg); };
  return pedidas;
}
const reposo = async (vueltas = 80) => { for (let i = 0; i < vueltas; i++) await espera0(); };

test("cada tramo apunta quién lo transcribió y con qué modelo, también con Gemini", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")], 2: [{ status: 404, cuerpo: "modelo no encontrado" }, respGemini("dos")] });
  const s = sistema({ local: { historial: [reunion(115, 2)] }, audios: audioDe(115, 2), fetch: f });
  await s.off.transcribirReunion(115);
  assert.deepStrictEqual(s.entrada(115).tramos.map((t) => [t.estado, t.texto, t.prov, t.modelo]),
    [["ok", "uno", "gemini", "gemini-flash-latest"], ["ok", "dos", "gemini", "gemini-2.5-flash"]]);
});

test("una ronda completa sin clave de Gemini, con la de Groq: texto con el tiempo de la reunión, gasto en segundos y audio borrado", async () => {
  const f = fetchPorTramo({ 1: [whisperDe("uno")], 2: [whisperDe("dos")], 3: [whisperDe("tres")] });
  const r0 = reunion(107, 3, { participantes: "Marcos" });
  r0.tramos[1].inicioS = 300;
  r0.tramos[2].inicioS = 580; // una pausa: no todos los tramos empiezan en un múltiplo de cinco minutos
  const s = sistemaVoz({ local: { geminiKey: "", groqKey: "Q", glosario: "Odoo", historial: [r0] }, audios: audioDe(107, 3), fetch: f });
  await s.off.transcribirReunion(107);
  const h = s.entrada(107);
  assert.strictEqual(h.estado, "ok");
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["[00:10] uno", "[05:10] dos", "[09:50] tres"]);
  assert.deepStrictEqual(h.tramos.map((t) => [t.prov, t.modelo, t.uso.segundos, t.truncado]), veces(3, ["groq", "whisper-large-v3", 300, false]));
  assert.ok(f._llamadas.every((ll) => ll.url === URL_VOZ.groq), "ni una petición a Gemini");
  assert.deepStrictEqual(f._llamadas.map((ll) => ficheroDe(ll).nombre).sort(), ["tramo01.webm", "tramo02.webm", "tramo03.webm"]);
  assert.ok(f._llamadas.every((ll) => campo(ll, "prompt")[0] === "Reunión de trabajo. Nombres y términos: Marcos, Odoo."), "los asistentes de la reunión y el glosario, en cada tramo");
  assert.strictEqual(s.audios._datos.size, 0, "con el texto a salvo, el audio sobra");
  assert.match(h.transcript, /\[00:10\] uno[\s\S]*\[05:10\] dos[\s\S]*\[09:50\] tres/);
  assert.doesNotMatch(h.transcript, /pendiente/);
  assert.strictEqual(typeof h.fileMd, "number", "el .md se descarga");
  assert.deepStrictEqual(Object.keys(s.chrome._registro.alarmas), []);
  // Se le cobra a Groq, por minuto.
  const c = comun.costeReunion(h, { groq: { minuto: "0,002" } });
  assert.ok(Math.abs(c.euros - 0.03) < 1e-12, "quince minutos a 0,002 €: " + c.euros);
  assert.deepStrictEqual([c.segundos, c.faltan], [900, []]);
});

test("una ronda con Mistral: cada tramo grabado viaja en WAV, y el texto llega con sus hablantes", async () => {
  const mistralDe = (texto) => respMistral([segM(1.2, 3, " " + texto, "speaker_1"), segM(4, 5, " vale", "speaker_2")]);
  const f = fetchPorTramo({ 1: [mistralDe("uno")], 2: [mistralDe("dos")] });
  const s = sistemaVoz({ local: { geminiKey: "", mistralKey: "M", historial: [reunion(108, 2)] }, audios: [[108, 0, blobDe(tonoVoz(1))], [108, 1, blobDe(tonoVoz(1))]], fetch: f });
  await s.off.transcribirReunion(108);
  const h = s.entrada(108);
  assert.strictEqual(h.estado, "ok");
  assert.deepStrictEqual(h.tramos.map((t) => t.texto), ["[00:01] Hablante 1: uno\n[00:04] Hablante 2: vale", "[05:01] Hablante 1: dos\n[05:04] Hablante 2: vale"]);
  assert.deepStrictEqual(h.tramos.map((t) => [t.prov, t.modelo, t.uso.segundos]), veces(2, ["mistral", "voxtral-mini-latest", 203]));
  assert.deepStrictEqual(f._llamadas.map((ll) => ficheroDe(ll).nombre).sort(), ["tramo01.wav", "tramo02.wav"]);
  assert.ok(f._llamadas.every((ll) => ll.url === URL_VOZ.mistral && esWavDe16k(ficheroDe(ll).blob)));
  assert.ok(s.off.AudioContext._instancias.length === 2 && s.off.AudioContext._instancias.every((c) => c.state === "closed"), "un contexto por conversión, y ninguno abierto al acabar");
  assert.deepStrictEqual(comun.hablantesDe(h.transcript.split("---\n")[1]), ["Hablante 1", "Hablante 2"]);
  assert.strictEqual(s.audios._datos.size, 0);
});

test("sin ninguna clave la reunión queda esperando, y al guardar la de otro proveedor se transcribe sola", async () => {
  const f = fetchPorTramo({ 1: [whisperDe("uno")], 2: [whisperDe("dos")] });
  const s = sistemaVoz({ local: { geminiKey: "", historial: [reunion(109, 2)] }, audios: audioDe(109, 2), fetch: f }, ["groq.voz"]);
  await s.off.transcribirReunion(109);
  let h = s.entrada(109);
  assert.strictEqual(h.estado, "pendiente");
  assert.ok(h.tramos.every((t) => t.codigo === "sin_clave"));
  assert.strictEqual(f._llamadas.length, 0, "sin clave no se toca la red");
  assert.strictEqual(s.audios._datos.size, 2, "el audio sigue guardado");
  assert.ok(h.reintento.esperaClave);
  assert.deepStrictEqual(Object.keys(s.chrome._registro.alarmas), [], "esperar no trae una clave: nada de alarmas");
  // Una clave que no transcribe (la de Claude, o la de OpenAI con su voz apagada) no cambia nada.
  const rondas = rondasPedidas(s);
  await s.chrome.storage.local.set({ claudeKey: "C", openaiKey: "O" });
  await reposo();
  assert.deepStrictEqual([rondas.length, f._llamadas.length, s.entrada(109).estado], [0, 0, "pendiente"], "ni se intenta");
  // El usuario pega la de Groq en Opciones.
  await s.chrome.storage.local.set({ groqKey: "Q" });
  await hasta(() => s.entrada(109).estado === "ok", "que se transcribiera al poner la clave de Groq");
  assert.deepStrictEqual(rondas, [109]);
  h = s.entrada(109);
  assert.deepStrictEqual(h.tramos.map((t) => [t.texto, t.prov]), [["[00:10] uno", "groq"], ["[05:10] dos", "groq"]]);
  assert.strictEqual(s.audios._datos.size, 0);
  assert.ok(f._llamadas.every((ll) => ll.url === URL_VOZ.groq));
});

test("elegir otro proveedor en Opciones relanza lo que esperaba por una clave rechazada, y cada tramo se le cobra a quien lo hizo", async () => {
  const conUso = (t) => ({ cuerpo: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: t }] } }], usageMetadata: { promptTokenCount: 1000000, candidatesTokenCount: 0 } } });
  const claveMala = { status: 400, cuerpo: '{"error":{"message":"API key not valid"}}' };
  const f = fetchPorTramo({ 1: [conUso("uno")], 2: [claveMala] });
  const s = sistemaVoz({ local: { groqKey: "Q", historial: [reunion(116, 2)] }, audios: audioDe(116, 2), fetch: f }, ["groq.voz"]);
  await s.off.transcribirReunion(116);
  let h = s.entrada(116);
  assert.deepStrictEqual(h.tramos.map((t) => [t.estado, t.prov, t.codigo]), [["ok", "gemini", undefined], ["pendiente", undefined, "clave_invalida"]],
    "en automático manda Gemini, que tiene clave: la de Groq no se usa por su cuenta");
  assert.ok(h.reintento.esperaClave);
  // «Quién transcribe» → Groq.
  f.anade(2, respWhisper([segW(3, 5, " dos")]));
  await s.chrome.storage.local.set({ provTranscribe: "groq" });
  await hasta(() => s.entrada(116).estado === "ok", "que se transcribiera al elegir Groq");
  h = s.entrada(116);
  assert.deepStrictEqual(h.tramos.map((t) => [t.texto, t.prov, t.modelo]), [["uno", "gemini", "gemini-flash-latest"], ["[05:03] dos", "groq", "whisper-large-v3"]]);
  assert.strictEqual(h.tramos[1].codigo, undefined, "el fallo anterior no se queda pegado al tramo");
  const c = comun.costeReunion(h, { gemini: { audio: "1", salida: "2" }, groq: { minuto: "0,002" } });
  assert.ok(Math.abs(c.euros - (1 + 0.01)) < 1e-9, "un millón de tokens de audio de Gemini y cinco minutos de Groq: " + c.euros);
});

test("sin saldo en la cuenta del proveedor: la ronda se para ahí y espera, sin gastar llamadas ni programar reintentos", async () => {
  const sinSaldo = { status: 429, cuerpo: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}' };
  const f = fetchPorTramo({ 1: [sinSaldo], 2: [sinSaldo], 3: [], 4: [] });
  const s = sistemaVoz({ local: { geminiKey: "", openaiKey: "O", historial: [reunion(111, 4)] }, audios: audioDe(111, 4), fetch: f }, ["gpt.voz"]);
  await s.off.transcribirReunion(111);
  const h = s.entrada(111);
  assert.ok(f._llamadas.length <= 2, "como mucho los dos tramos que ya estaban en vuelo; hubo " + f._llamadas.length);
  assert.ok(h.tramos.every((t) => t.estado === "pendiente" && t.codigo === "sin_saldo" && t.error === comun.textoError("sin_saldo")));
  assert.match(h.tramos[0].detalle, /^OpenAI HTTP 429 \(gpt-transcribe\): You exceeded your current quota/);
  assert.strictEqual(s.audios._datos.size, 4, "el audio sigue guardado");
  assert.ok(h.reintento.esperaClave);
  assert.deepStrictEqual(Object.keys(s.chrome._registro.alarmas), [], "esperar no trae saldo");
});

test("al abrir el popup, lo que esperaba una clave se relanza si ya hay con quién transcribir, sea quien sea", async () => {
  const pendiente = () => reunion(112, 1, {
    estado: "pendiente", tramos: [{ ...tramoPend("sin_clave"), pico: 0.3 }], reintento: { n: 0, esperaClave: true, proximo: null, ultimo: Date.now() - 5 * 60000 },
  });
  // Con una clave que no transcribe (OpenAI, con la voz apagada) no hay nada que relanzar.
  let f = fetchPorTramo({ 1: [whisperDe("uno")] });
  let s = sistemaVoz({ local: { geminiKey: "", openaiKey: "O", historial: [pendiente()] }, audios: audioDe(112, 1), fetch: f }, ["groq.voz"]);
  const rondas = rondasPedidas(s);
  await s.enviar({ target: "bg", cmd: "revisarPendientes" });
  await reposo();
  assert.deepStrictEqual([rondas.length, f._llamadas.length, s.entrada(112).estado], [0, 0, "pendiente"], "ni se intenta: sería una ronda para nada cada vez que se abre el popup");
  // Con la de Groq, sí.
  f = fetchPorTramo({ 1: [whisperDe("uno")] });
  s = sistemaVoz({ local: { geminiKey: "", groqKey: "Q", historial: [pendiente()] }, audios: audioDe(112, 1), fetch: f }, ["groq.voz"]);
  await s.enviar({ target: "bg", cmd: "revisarPendientes" });
  await hasta(() => s.entrada(112).estado === "ok", "que se relanzara al abrir el popup");
  assert.strictEqual(s.entrada(112).tramos[0].prov, "groq");
  // Y con la de Gemini, como siempre.
  f = fetchPorTramo({ 1: [respGemini("uno")] });
  s = sistema({ local: { historial: [pendiente()] }, audios: audioDe(112, 1), fetch: f });
  await s.enviar({ target: "bg", cmd: "revisarPendientes" });
  await hasta(() => s.entrada(112).estado === "ok", "que se relanzara con Gemini");
});

test("grabación en vivo con otro proveedor: cada tramo se transcribe al cerrarse, con el suyo", async () => {
  const f = fetchPorTramo({ 1: [whisperDe("uno", 10)], 2: [whisperDe("dos", 5)] });
  const reloj = { t: 3000000 };
  const s = sistemaVoz({ fetch: f, reloj, local: { geminiKey: "", groqKey: "Q" } }, ["groq.voz"], sistemaGrabando);
  await s.off.start({ modo: "mic", participantes: "Marcos" });
  const id = s.historial()[0].id;
  reloj.t += comun.DURACION_TRAMO_S * 1000;
  s.off.cortaTramo();
  await hasta(() => ((s.entrada(id).tramos || [])[0] || {}).estado === "ok", "que el primer tramo se transcribiera en vivo");
  reloj.t += 60000;
  assert.strictEqual(s.entrada(id).estado, "grabando", "la reunión sigue grabándose");
  assert.deepStrictEqual([s.entrada(id).tramos[0].texto, s.entrada(id).tramos[0].prov], ["[00:10] uno", "groq"]);
  s.off.stop();
  await hasta(() => s.entrada(id).estado === "ok", "que terminara al parar");
  assert.deepStrictEqual([...s.entrada(id).tramos.map((t) => [t.texto, t.prov, t.modelo])], [["[00:10] uno", "groq", "whisper-large-v3"], ["[05:05] dos", "groq", "whisper-large-v3"]]);
  assert.deepStrictEqual(f._llamadas.map((ll) => [ll.url, ficheroDe(ll).nombre, ficheroDe(ll).blob.type]),
    [[URL_VOZ.groq, "tramo01.webm", "audio/webm"], [URL_VOZ.groq, "tramo02.webm", "audio/webm"]], "lo ya transcrito no se vuelve a mandar al parar");
  assert.ok(f._llamadas.every((ll) => campo(ll, "prompt")[0] === "Reunión de trabajo. Nombres y términos: Marcos."));
  assert.strictEqual(s.audios._datos.size, 0);
});

test("acta automática sin clave de Gemini: se hace con el primero que tenga clave, y si no la tiene nadie se dice cuál falta", async () => {
  const conActa = (voz, respuesta, llamadas) => async (url, opts) => {
    if (!/\/audio\/transcriptions$/.test(url)) { llamadas.push({ url: String(url), opts }); return respuestaHttp(respuesta); }
    return voz(url, opts);
  };
  const claves = { geminiKey: "", groqKey: "Q", openaiKey: "O", claudeKey: "C" };
  // El elegido es Gemini (de fábrica) y no tiene clave: la hace GPT, que sí.
  let actas = [];
  let f = conActa(fetchPorTramo({ 1: [whisperDe("hola a todos", 1)] }), respOpenai("ACTA CON GPT"), actas);
  let s = sistemaVoz({ local: { ...claves, historial: [reunion(113, 1)] }, sync: { autoActa: true }, audios: audioDe(113, 1), fetch: f }, ["groq.voz"]);
  await s.off.transcribirReunion(113);
  await hasta(() => (s.entrada(113).analisis || {})["acta·gpt"], "que se guardara el acta automática");
  assert.deepStrictEqual(actas.map((a) => a.url), ["https://api.openai.com/v1/chat/completions"]);
  assert.match(JSON.parse(actas[0].opts.body).messages[1].content, /\[00:01\] hola a todos/);
  assert.deepStrictEqual({ ...s.entrada(113).analisis }, { "acta·gpt": "ACTA CON GPT" });
  assert.strictEqual(s.entrada(113).errorActa, undefined);
  // Si el elegido tiene clave, es él, haya las que haya.
  actas = [];
  f = conActa(fetchPorTramo({ 1: [whisperDe("hola", 1)] }), respClaude("ACTA CON CLAUDE"), actas);
  s = sistemaVoz({ local: { ...claves, historial: [reunion(113, 1)] }, sync: { autoActa: true, autoActaProv: "claude" }, audios: audioDe(113, 1), fetch: f }, ["groq.voz"]);
  await s.off.transcribirReunion(113);
  await hasta(() => (s.entrada(113).analisis || {})["acta·claude"], "el acta con el elegido");
  assert.deepStrictEqual(actas.map((a) => a.url), ["https://api.anthropic.com/v1/messages"]);
  // Nadie que redacte tiene clave (la de Groq está, pero su texto está apagado): no hay acta, y el aviso dice cuál falta.
  actas = [];
  f = conActa(fetchPorTramo({ 1: [whisperDe("hola", 1)] }), respOpenai("NO"), actas);
  s = sistemaVoz({ local: { geminiKey: "", groqKey: "Q", historial: [reunion(113, 1)] }, sync: { autoActa: true }, audios: audioDe(113, 1), fetch: f }, ["groq.voz"]);
  s.off.console = { ...console, warn() {} }; // el fallo que se espera aquí también se avisa por la consola
  await s.off.transcribirReunion(113);
  await hasta(() => s.entrada(113).errorActa, "el aviso del acta");
  assert.strictEqual(s.entrada(113).errorActa, "Falta la clave de Gemini en Opciones.");
  assert.deepStrictEqual([actas.length, s.entrada(113).estado, { ...s.entrada(113).analisis }], [0, "ok", {}], "la transcripción no se toca");
});

grupo("3.8 · el service worker relanza lo pendiente (background.js)");

// Service worker con una reunión esperando una clave. `lanzadas` son las rondas
// que le pide al documento offscreen.
function bgEsperando(local = {}, encendidos = []) {
  const h = reunion(120, 1, { estado: "pendiente", tramos: [{ ...tramoPend("sin_clave"), pico: 0.3 }], reintento: { n: 3, esperaClave: true, proximo: null, ultimo: Date.now() } });
  const b = bg({ local: { historial: [h], ...local } });
  encender(b.ctx, ...encendidos);
  const lanzadas = [];
  b.chrome.runtime.sendMessage = async (m) => { if (m.target === "offscreen" && m.cmd === "transcribir") lanzadas.push(m.id); return { ok: true }; };
  return { ...b, lanzadas, reintento: () => b.chrome.storage.local._volcado().historial[0].reintento };
}

test("guardar la clave de Gemini relanza lo pendiente, como siempre; la de quien no transcribe, no", async () => {
  const a = bgEsperando();
  await a.chrome.storage.local.set({ geminiKey: "NUEVA" });
  await hasta(() => a.lanzadas.length === 1, "que se relanzara");
  assert.deepStrictEqual(a.lanzadas, [120]);
  assert.strictEqual(a.reintento().n, 0, "y la tanda de reintentos vuelve a empezar");
  // Cambiarla por otra también (la anterior pudo ser la rechazada).
  await a.chrome.storage.local.set({ geminiKey: "OTRA" });
  await hasta(() => a.lanzadas.length === 2, "que se relanzara con la segunda");
  // Guardar la misma no es un cambio, y lo que no decide quién transcribe tampoco relanza.
  await a.chrome.storage.local.set({ geminiKey: "OTRA", geminiModel: "gemini-2.5-flash", glosario: "Odoo" });
  await reposo();
  assert.strictEqual(a.lanzadas.length, 2);
  // Estado de salida: ni OpenAI, ni Mistral, ni Groq transcriben. Sus claves, y elegirlos, no relanzan nada.
  const b = bgEsperando();
  await b.chrome.storage.local.set({ openaiKey: "O", claudeKey: "C", mistralKey: "M", groqKey: "Q", deepseekKey: "D", openrouterKey: "R" });
  await b.chrome.storage.local.set({ provTranscribe: "groq" });
  await reposo();
  assert.deepStrictEqual(b.lanzadas, []);
  assert.strictEqual(b.reintento().n, 3);
  const b2 = bgEsperando({ geminiKey: "G" });
  await b2.chrome.storage.local.set({ openaiKey: "O", claudeKey: "C", mistralKey: "M", groqKey: "Q" });
  await reposo();
  assert.deepStrictEqual(b2.lanzadas, [], "habiendo clave de Gemini, tampoco: sería repetir el mismo intento");
  // Lo que se llame igual en `sync` no es una clave: las claves viven en local.
  const c = bgEsperando({ geminiKey: "G" });
  await c.chrome.storage.sync.set({ geminiKey: "X", provTranscribe: "gemini", idiomaUI: "en" });
  await reposo();
  assert.deepStrictEqual(c.lanzadas, []);
  // Quitar la clave no relanza: después del cambio no hay con quién transcribir.
  const d = bgEsperando({ geminiKey: "G" });
  await d.chrome.storage.local.set({ geminiKey: "" });
  await reposo();
  assert.deepStrictEqual(d.lanzadas, []);
});

test("con otra voz encendida: su clave, o elegirlo en «Quién transcribe», relanza si después hay con quién transcribir", async () => {
  const a = bgEsperando({}, ["groq.voz"]);
  await a.chrome.storage.local.set({ groqModel: "openai/gpt-oss-20b", groqVoz: "whisper-large-v3-turbo", openaiKey: "O" });
  await reposo();
  assert.deepStrictEqual(a.lanzadas, [], "ni el modelo ni la clave de otro que no transcribe");
  await a.chrome.storage.local.set({ groqKey: "Q" });
  await hasta(() => a.lanzadas.length === 1, "que se relanzara con la clave de Groq");
  assert.strictEqual(a.reintento().n, 0);
  // Elegir proveedor: relanza si el que queda puede transcribir…
  await a.chrome.storage.local.set({ provTranscribe: "groq" });
  await hasta(() => a.lanzadas.length === 2, "que se relanzara al elegirlo");
  // …y también si al elegido le falta la clave pero hay otro que la tiene (se transcribe con ese).
  await a.chrome.storage.local.set({ provTranscribe: "mistral" });
  await hasta(() => a.lanzadas.length === 3, "que se relanzara: queda Groq");
  // Sin ninguna clave, elegir no sirve de nada.
  const b = bgEsperando({}, TODA_LA_VOZ);
  await b.chrome.storage.local.set({ provTranscribe: "mistral" });
  await reposo();
  assert.deepStrictEqual(b.lanzadas, []);
  // Quitar una clave habiendo otra: lo pendiente se intenta con la que queda.
  const c = bgEsperando({ geminiKey: "G", groqKey: "Q" }, ["groq.voz"]);
  await c.chrome.storage.local.set({ geminiKey: "" });
  await hasta(() => c.lanzadas.length === 1, "que se relanzara con la que queda");
});

grupo("3.8 · permisos de host (manifest.json)");

const HOSTS_DE_SIEMPRE = ["https://generativelanguage.googleapis.com/*", "https://api.openai.com/*", "https://api.anthropic.com/*"];
const HOST_OPCIONAL = { mistral: "https://api.mistral.ai/*", groq: "https://api.groq.com/*", deepseek: "https://api.deepseek.com/*", openrouter: "https://openrouter.ai/*" };

// ¿Cabe esta dirección en alguno de estos patrones de permiso («https://host/*»,
// con «*.» delante para los subdominios)?
function cabeEn(url, patrones) {
  const u = new URL(url);
  return patrones.some((patron) => {
    const m = patron.match(/^(\w+):\/\/([^/]+)\/\*$/);
    if (!m || m[1] + ":" !== u.protocol) return false;
    return m[2].startsWith("*.") ? u.hostname === m[2].slice(2) || u.hostname.endsWith(m[2].slice(1)) : u.hostname === m[2];
  });
}

test("host_permissions son exactamente los tres de siempre: añadir uno desactiva Escriba al actualizar hasta que el usuario acepta", () => {
  const m = JSON.parse(leeExt("manifest.json"));
  assert.deepStrictEqual(m.host_permissions, HOSTS_DE_SIEMPRE);
  // Los de las IA nuevas son opcionales (no desactivan nada), uno por proveedor y sin
  // comodines, y solo los de lo encendido: hoy, ninguno.
  const opcionales = m.optional_host_permissions;
  assert.deepStrictEqual(opcionales.filter((o) => Object.values(HOST_OPCIONAL).includes(o)).sort(), [...prov.origenesProveedores()].sort(), "los hosts opcionales de IA del manifest son los de los proveedores encendidos, ni uno más ni uno menos");
  assert.strictEqual(new Set(opcionales).size, opcionales.length, "ninguno repetido");
  assert.deepStrictEqual(opcionales.filter((o) => m.host_permissions.includes(o)), [], "ninguno en las dos listas");
  for (const o of [...m.host_permissions, ...opcionales]) assert.match(o, /^https:\/\/(\*\.)?[a-z0-9.-]+\/\*$/, o + ": un host concreto, por https");
  assert.ok(!JSON.stringify(m).includes("<all_urls>") && !opcionales.includes("https://*/*"), "sin patrones amplios: alargan la revisión de la tienda");
  // Y los permisos que no son de host, los mismos nueve de la 3.7.
  assert.deepStrictEqual(m.permissions, ["tabCapture", "downloads", "storage", "activeTab", "offscreen", "unlimitedStorage", "alarms", "notifications", "sidePanel"]);
  assert.strictEqual(m.optional_permissions, undefined);
});

test("todo host al que llama Escriba está en el manifest: la base de cada proveedor y cada fetch del código", () => {
  const m = JSON.parse(leeExt("manifest.json"));
  const todos = [...m.host_permissions, ...m.optional_host_permissions];
  // El registro: el host de cada uno, en la lista que le toca, y dentro de él
  // todo lo que se le pide (actas, transcripción y lista de modelos).
  for (const p of Object.values(prov.PROVEEDORES)) {
    // Fijo: en host_permissions. Opcional y con algo encendido: en los opcionales.
    // Opcional y apagado: en ninguna de las dos (no se piden permisos «por si acaso»).
    const visible = prov.provsVisibles().includes(p.id);
    if (p.fijo) assert.ok(m.host_permissions.includes(p.host), `${p.id}: ${p.host} no está en host_permissions`);
    else assert.strictEqual(m.optional_host_permissions.includes(p.host), visible, `${p.id}: ${p.host} ${visible ? "falta en" : "sobra en"} optional_host_permissions (está ${visible ? "encendido" : "apagado"})`);
    assert.ok(p.fijo || !todos.includes(p.host) || visible, `${p.id}: apagado y declarado`);
    for (const url of [p.base + "/chat/completions", p.base + "/audio/transcriptions", prov.peticionModelos(p.id, "K").url]) {
      assert.ok(cabeEn(url, [p.host]), `${p.id}: ${url} cae fuera de su permiso ${p.host}`);
    }
  }
  // El código: cada fetch con la dirección escrita (o montada sobre una
  // constante del fichero) tiene que caber en el manifest. Los demás montan la
  // dirección sobre la base de un proveedor, que es lo comprobado arriba.
  const escritos = [], montados = [];
  for (const f of fsT.readdirSync(RAIZ_EXT).filter((n) => n.endsWith(".js")).sort()) {
    const src = leeExt(f);
    const constantes = Object.fromEntries([...src.matchAll(/^const (\w+) = "(https:\/\/[^"]+)";/gm)].map((x) => [x[1], x[2]]));
    for (const x of src.matchAll(/\bfetch\(\s*([^,)]+)/g)) {
      const arg = x[1].trim();
      const literal = arg.match(/^["`](https?:\/\/[^"`$]+)/), sobreConstante = arg.match(/^`\$\{(\w+)\}/);
      if (literal) escritos.push([f, literal[1]]);
      else if (sobreConstante && constantes[sobreConstante[1]]) escritos.push([f, constantes[sobreConstante[1]] + "/"]);
      else montados.push(`${f}: ${arg}`);
    }
  }
  assert.ok(escritos.length >= 4, "se encuentran los fetch del código (" + escritos.length + ")");
  for (const [f, url] of escritos) assert.ok(cabeEn(url, todos), `${f}: ${url} no está en el manifest; Chrome lo trataría como una web cualquiera`);
  // Si esta lista cambia es que hay un fetch nuevo: comprueba a dónde va antes de apuntarlo aquí.
  assert.deepStrictEqual(montados, ["config.js: pet.url", "ia.js: url", "offscreen.js: `${p.base}/audio/transcriptions`"]);
});

grupo("3.8 · la lista de modelos de cada proveedor (proveedores.js)");

test("peticionModelos: cada proveedor en su dirección y con su cabecera; la de OpenRouter, la que exige la clave", () => {
  const pet = (id) => { const r = prov.peticionModelos(id, "K"); return [r.url, { ...r.headers }]; };
  // Como las pedía Opciones hasta la 3.7.
  assert.deepStrictEqual(pet("gemini"), ["https://generativelanguage.googleapis.com/v1beta/models", { "x-goog-api-key": "K" }]);
  assert.deepStrictEqual(pet("gpt"), ["https://api.openai.com/v1/models", { Authorization: "Bearer K" }]);
  assert.deepStrictEqual(pet("claude"), ["https://api.anthropic.com/v1/models?limit=100",
    { "x-api-key": "K", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }]);
  assert.deepStrictEqual(pet("mistral"), ["https://api.mistral.ai/v1/models", { Authorization: "Bearer K" }]);
  assert.deepStrictEqual(pet("groq"), ["https://api.groq.com/openai/v1/models", { Authorization: "Bearer K" }]);
  assert.deepStrictEqual(pet("deepseek"), ["https://api.deepseek.com/models", { Authorization: "Bearer K" }]);
  // «/models» de OpenRouter es público: respondería bien a una clave inventada y no comprobaría nada.
  assert.deepStrictEqual(pet("openrouter"), ["https://openrouter.ai/api/v1/models/user", { Authorization: "Bearer K" }]);
  for (const id of ["meta", "constructor", "", undefined]) assert.strictEqual(prov.peticionModelos(id, "K"), null, String(id));
});

test("modelosDeChat: de lo que devuelve cada API, solo lo que redacta; fuera audio, imagen, filtros y los que entrenan con los datos", () => {
  const de = (id, ids) => [...prov.modelosDeChat(id, { object: "list", data: ids.map((x) => (typeof x === "string" ? { id: x } : x)) })];
  // OpenAI, como hasta la 3.7: los de conversación, y los más nuevos arriba.
  assert.deepStrictEqual(de("gpt", ["gpt-4o", "gpt-4o-mini", "gpt-4o-audio-preview", "gpt-4o-realtime-preview", "tts-1", "gpt-4o-mini-tts", "gpt-transcribe",
    "gpt-4o-transcribe-diarize", "gpt-image-1", "dall-e-3", "whisper-1", "gpt-4o-search-preview", "text-embedding-3-small", "o3", "chatgpt-4o-latest", "gpt-6.1-sol", "babbage-002"]),
  ["o3", "gpt-6.1-sol", "gpt-4o-mini", "gpt-4o", "chatgpt-4o-latest"]);
  // Anthropic: todos, en el orden en que los da (los más recientes primero).
  assert.deepStrictEqual(de("claude", ["claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-4-5"]), ["claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-4-5"]);
  // Groq no dice para qué sirve cada modelo: fuera Whisper, la voz y los filtros; delante, los que usa Escriba.
  assert.deepStrictEqual(de("groq", ["whisper-large-v3", "whisper-large-v3-turbo", "llama-x", "openai/gpt-oss-20b", "meta-llama/llama-guard-4-12b",
    "openai/gpt-oss-safeguard-20b", "playai-tts", "openai/gpt-oss-120b", { id: "retirado-1", active: false }, { id: "vivo-1", active: true }]),
  ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-x", "vivo-1"]);
  // Mistral sí lo dice: lo que no conversa no se ofrece.
  assert.deepStrictEqual(de("mistral", [
    { id: "mistral-medium-latest", capabilities: { completion_chat: true } }, { id: "mistral-small-latest", capabilities: { completion_chat: true } },
    { id: "voxtral-mini-latest", capabilities: { completion_chat: false, audio_transcription: true } }, { id: "mistral-embed", capabilities: { completion_chat: false } },
    { id: "mistral-ocr-latest", capabilities: { completion_chat: false } }, { id: "mistral-moderation-latest", capabilities: { completion_chat: true } },
    { id: "pixtral-large-latest", capabilities: { completion_chat: true } }, { id: "sin-capacidades" },
    { id: "codestral-fim-latest", capabilities: { completion_chat: false, completion_fim: true } },
  ]), ["mistral-small-latest", "mistral-medium-latest", "pixtral-large-latest", "sin-capacidades"], "también el que por el nombre parecería valer");
  assert.deepStrictEqual(de("deepseek", ["deepseek-v4-pro", "deepseek-flash"]), ["deepseek-flash", "deepseek-v4-pro"]);
  // OpenRouter: los «-contributor» entrenan con lo que se les envía y prohíben datos personales.
  assert.deepStrictEqual(de("openrouter", ["openrouter/free", "meta/muse-spark-1.1-contributor", "meta/muse-spark-1.1-contributor:free", "meta/muse-spark-1.1",
    "google/gemini-flash:free", "openai/gpt-audio", "google/gemini-flash-image", "x/contributor-de-nombre"]),
  ["openrouter/free", "meta/muse-spark-1.1", "google/gemini-flash:free", "x/contributor-de-nombre"]);
  // Gemini: los que generan texto, sin el prefijo.
  assert.deepStrictEqual([...prov.modelosDeChat("gemini", { models: [
    { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }, { name: "models/sin-metodos" },
  ] })], ["gemini-flash-latest"]);
  // Sin repetir, y sin reventar con lo que no es una lista: una respuesta rara es «ningún modelo».
  assert.deepStrictEqual(de("deepseek", ["a", "a", "b"]), ["a", "b"]);
  assert.deepStrictEqual(de("groq", [{ id: 7 }, { id: "" }, null, "bueno", { nombre: "sin id" }]), ["bueno"]);
  for (const cuerpo of [null, undefined, "texto", 7, [], {}, { data: "no es una lista" }, { data: null }, { models: [] }]) {
    for (const id of ["gpt", "claude", "groq", "gemini"]) assert.deepStrictEqual([...prov.modelosDeChat(id, cuerpo)], [], `${id}: ${JSON.stringify(cuerpo)}`);
  }
  assert.deepStrictEqual([...prov.modelosDeChat("meta", { data: [{ id: "x" }] })], [], "lo que no es un proveedor no tiene modelos");
});

grupo("3.8 · guardar la clave de un proveedor (config.js)");

// config.js con el registro delante, como en Opciones: chrome con permisos
// simulados y una red que reparte por dirección. `encendidos`, como en encender().
function claves(opciones = {}, encendidos = []) {
  const chrome = nuevoChrome({ local: opciones.local, permisos: opciones.permisos });
  const red = fetchPorUrl(opciones.red || {});
  const ctx = encender(cargar(["proveedores.js", "config.js"], { chrome, fetch: red }), ...encendidos);
  return { ctx, chrome, red, local: () => chrome.storage.local._volcado(), permisos: () => chrome._registro.permisos };
}
const listaGroq = { cuerpo: { object: "list", data: [{ id: "openai/gpt-oss-120b" }, { id: "whisper-large-v3" }, { id: "openai/gpt-oss-20b" }] } };
const plano2 = (r) => ({ ...r, ...(r.modelos ? { modelos: [...r.modelos] } : {}) });

test("host opcional: el permiso se pide en el mismo clic, antes que nada y uno solo; después se comprueba la clave y solo entonces se guarda", async () => {
  const s = claves({ red: { "api.groq.com": [listaGroq] } }, ["groq.chat", "groq.voz"]);
  const pendiente = s.ctx.guardarClaveProveedor("groq", "  gsk_1  ", { groqModel: "openai/gpt-oss-20b" });
  // Sin haber cedido el turno ni una vez: el permiso ya está pedido (es el PRIMER
  // await, dentro del gesto del usuario) y ni la red ni el almacén se han tocado.
  assert.deepStrictEqual(s.permisos(), [{ pide: [HOST_OPCIONAL.groq] }], "un proveedor por petición: así Chrome nombra su dirección");
  assert.strictEqual(s.red._llamadas.length, 0);
  const r = plano2(await pendiente);
  assert.deepStrictEqual(r, { estado: "guardada", modelos: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] });
  assert.strictEqual(s.red._llamadas.length, 1, "una sola petición");
  assert.strictEqual(s.red._llamadas[0].url, "https://api.groq.com/openai/v1/models");
  assert.strictEqual(s.red._llamadas[0].metodo, "GET");
  assert.deepStrictEqual({ ...s.red._llamadas[0].opts.headers }, { Authorization: "Bearer gsk_1" }, "la clave, sin los espacios de pegarla");
  assert.deepStrictEqual(s.local(), { groqModel: "openai/gpt-oss-20b", groqKey: "gsk_1" });
  assert.deepStrictEqual(s.chrome.storage.sync._volcado(), {}, "una clave nunca va a sync");
  assert.deepStrictEqual(s.permisos(), [{ pide: [HOST_OPCIONAL.groq] }], "y no se pide nada más");
  assert.strictEqual(s.chrome.permissions._concedidos.has(HOST_OPCIONAL.groq), true);
  // Cada proveedor pide su host y ningún otro.
  for (const [id, host] of Object.entries(HOST_OPCIONAL)) {
    const x = claves({ red: { [new URL(host.slice(0, -1)).host]: [{ cuerpo: { data: [] } }] } }, TODO_EL_TEXTO);
    assert.strictEqual((await x.ctx.guardarClaveProveedor(id, "K")).estado, "guardada", id);
    assert.deepStrictEqual(x.permisos(), [{ pide: [host] }], id);
  }
});

test("permiso denegado, o una petición que Chrome rechaza: ni se llama al proveedor ni se guarda la clave", async () => {
  for (const respuesta of [false, "lanza"]) {
    const s = claves({ permisos: { respuesta }, local: { groqKey: "la-de-antes", groqModel: "openai/gpt-oss-120b" } }, ["groq.chat"]);
    const r = await s.ctx.guardarClaveProveedor("groq", "gsk_nueva", { groqModel: "otro" });
    assert.deepStrictEqual({ ...r }, { estado: "sin_permiso" }, String(respuesta));
    assert.strictEqual(s.red._llamadas.length, 0, "sin permiso no se manda la clave a ningún sitio");
    assert.deepStrictEqual(s.local(), { groqKey: "la-de-antes", groqModel: "openai/gpt-oss-120b" }, "lo guardado, intacto");
    assert.deepStrictEqual(s.permisos(), [{ pide: [HOST_OPCIONAL.groq] }]);
  }
});

test("OpenAI y Anthropic, que ya tienen su host concedido: no se pide ningún permiso, y la clave se comprueba igual", async () => {
  const s = claves({ red: { "api.openai.com": [{ cuerpo: { data: [{ id: "gpt-4o" }, { id: "tts-1" }] } }], "api.anthropic.com": [{ cuerpo: { data: [{ id: "claude-sonnet-5" }] } }] } });
  assert.deepStrictEqual(plano2(await s.ctx.guardarClaveProveedor("gpt", "sk-O", { openaiModel: "gpt-4o" })), { estado: "guardada", modelos: ["gpt-4o"] });
  assert.deepStrictEqual(plano2(await s.ctx.guardarClaveProveedor("claude", "sk-ant-C", { claudeModel: "claude-sonnet-5" })), { estado: "guardada", modelos: ["claude-sonnet-5"] });
  assert.deepStrictEqual(s.permisos(), [], "pedirlo sacaría un diálogo de Chrome que hoy no sale");
  assert.deepStrictEqual(s.red._llamadas.map((l) => l.url), ["https://api.openai.com/v1/models", "https://api.anthropic.com/v1/models?limit=100"]);
  assert.deepStrictEqual({ ...s.red._llamadas[1].opts.headers }, { "x-api-key": "sk-ant-C", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
  assert.deepStrictEqual(s.local(), { openaiModel: "gpt-4o", openaiKey: "sk-O", claudeModel: "claude-sonnet-5", claudeKey: "sk-ant-C" });
});

test("una clave que el proveedor no acepta, o que no se ha podido comprobar, no se guarda ni pisa la que había", async () => {
  const guardado = { openaiKey: "sk-buena", openaiModel: "gpt-4o" };
  const con = (respuesta) => claves({ local: guardado, red: { "api.openai.com": [respuesta] } });
  const intenta = async (respuesta) => {
    const s = con(respuesta);
    const r = await s.ctx.guardarClaveProveedor("gpt", "sk-otra", { openaiModel: "gpt-9" });
    assert.deepStrictEqual(s.local(), guardado, JSON.stringify(respuesta));
    assert.strictEqual(s.red._llamadas.length, 1, "una petición, sin reintentos: el usuario está mirando");
    return { ...r };
  };
  assert.deepStrictEqual(await intenta({ status: 401, cuerpo: '{"error":{"message":"Incorrect API key provided"}}' }), { estado: "clave_mala", status: 401 });
  for (const status of [400, 404, 429, 500, 503]) {
    assert.deepStrictEqual(await intenta({ status, cuerpo: "{}" }), { estado: "no_comprobada", status, detalle: "HTTP " + status });
  }
  assert.deepStrictEqual(await intenta({ lanza: "Failed to fetch" }), { estado: "no_comprobada", status: 0, detalle: "Failed to fetch" });
  // 403: el proveedor reconoce la clave pero no le deja ver la lista (una clave de
  // OpenAI con permisos recortados). Redacta igual: se guarda, y se dice.
  const s = con({ status: 403, cuerpo: '{"error":{"message":"Missing scopes: api.model.read"}}' });
  assert.deepStrictEqual(plano2(await s.ctx.guardarClaveProveedor("gpt", "sk-recortada", { openaiModel: "gpt-9" })), { estado: "guardada", modelos: [], status: 403 });
  assert.deepStrictEqual(s.local(), { openaiKey: "sk-recortada", openaiModel: "gpt-9" });
  // OpenAI contesta en realidad con un 401 que habla de permisos, no con un 403: es
  // la misma clave buena, y hasta la 3.7 se podía guardar. Una falsa sigue rechazada.
  const s401 = con({ status: 401, cuerpo: '{"error":{"message":"You have insufficient permissions for this operation. Missing scopes: api.model.read.","type":"invalid_request_error"}}' });
  assert.deepStrictEqual(plano2(await s401.ctx.guardarClaveProveedor("gpt", "sk-recortada", { openaiModel: "gpt-9" })), { estado: "guardada", modelos: [], status: 401 });
  assert.deepStrictEqual(s401.local(), { openaiKey: "sk-recortada", openaiModel: "gpt-9" });
  // Responde bien pero no se entiende la lista: la clave vale, y no hay modelos que ofrecer.
  const raro = con({ status: 200, cuerpo: "<html>proxy</html>" });
  assert.deepStrictEqual(plano2(await raro.ctx.guardarClaveProveedor("gpt", "sk-otra")), { estado: "guardada", modelos: [] });
  assert.strictEqual(raro.local().openaiKey, "sk-otra");
});

test("vaciar el campo y guardar borra la clave y retira el permiso opcional; el de un host fijo no se toca", async () => {
  const s = claves({ local: { groqKey: "gsk_1", groqVoz: "whisper-large-v3-turbo", openaiKey: "sk-O" }, permisos: { concedidos: [HOST_OPCIONAL.groq, HOST_OPCIONAL.mistral] } }, ["groq.voz"]);
  assert.deepStrictEqual({ ...(await s.ctx.guardarClaveProveedor("groq", "   ")) }, { estado: "borrada" }, "solo espacios también es vacío");
  assert.deepStrictEqual(s.local(), { groqKey: "", groqVoz: "whisper-large-v3-turbo", openaiKey: "sk-O" }, "lo demás se queda");
  assert.deepStrictEqual(s.permisos(), [{ retira: [HOST_OPCIONAL.groq] }], "sin pedir nada, y solo el suyo");
  assert.deepStrictEqual([...s.chrome.permissions._concedidos], [HOST_OPCIONAL.mistral]);
  assert.strictEqual(s.red._llamadas.length, 0, "borrar no llama a nadie");
  assert.deepStrictEqual({ ...(await s.ctx.guardarClaveProveedor("gpt", "", { openaiModel: "gpt-4o" })) }, { estado: "borrada" });
  assert.strictEqual(s.local().openaiKey, "");
  assert.deepStrictEqual(s.permisos(), [{ retira: [HOST_OPCIONAL.groq] }], "el host de OpenAI es de los fijos: no se retira");
  assert.strictEqual(s.ctx.proveedorVoz(s.local()), "", "y sin su clave ya no transcribe");
});

test("interruptores: de un proveedor apagado no se pide el permiso, ni se comprueba ni se guarda su clave", async () => {
  // Estado de salida: Mistral, Groq, DeepSeek y OpenRouter no existen para el usuario.
  const s = claves({ red: { "api.": [listaGroq] } });
  for (const id of ["mistral", "groq", "deepseek", "openrouter", "meta", "constructor", ""]) {
    for (const clave of ["K", ""]) {
      await assert.rejects(s.ctx.guardarClaveProveedor(id, clave), /Proveedor desconocido/, `${id} con «${clave}»`);
    }
  }
  assert.deepStrictEqual(s.permisos(), []);
  assert.strictEqual(s.red._llamadas.length, 0);
  assert.deepStrictEqual(s.local(), {});
  // Con UNA capacidad encendida ya existe, sea la de transcribir o la de redactar.
  for (const capacidad of ["groq.voz", "groq.chat"]) {
    const x = claves({ red: { "api.groq.com": [listaGroq] } }, [capacidad]);
    assert.strictEqual((await x.ctx.guardarClaveProveedor("groq", "gsk")).estado, "guardada", capacidad);
  }
});

test("listarModelos: los modelos si la clave vale; si no, un error con el HTTP (0 sin conexión), que es lo que enseña Opciones al abrir", async () => {
  const s = claves({ red: { "openrouter.ai/api/v1/models/user": [{ cuerpo: { data: [{ id: "openrouter/free" }, { id: "x/y-contributor" }] } }, { status: 401, cuerpo: "{}" }, { lanza: "net::ERR_FAILED" }] } });
  assert.deepStrictEqual([...(await s.ctx.listarModelos("openrouter", "sk-or"))], ["openrouter/free"]);
  const fallo = (p) => p.then(() => null, (e) => [e.message, e.status]);
  assert.deepStrictEqual(await fallo(s.ctx.listarModelos("openrouter", "mala")), ["HTTP 401", 401]);
  assert.deepStrictEqual(await fallo(s.ctx.listarModelos("openrouter", "sk-or")), ["net::ERR_FAILED", 0]);
  assert.match((await fallo(s.ctx.listarModelos("meta", "K")))[0], /Proveedor desconocido: meta/);
  assert.strictEqual(s.red._llamadas.length, 3);
  assert.deepStrictEqual(s.permisos(), [], "listar no pide permisos: no hay gesto");
});

grupo("3.8 · Opciones: lo que se pinta desde el registro (options.html y options.js)");

test("todo id que options.js busca con $(\"…\") existe en options.html, y ningún id está repetido", () => {
  const html = leeExt("options.html"), js = leeExt("options.js");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "ids repetidos");
  const pedidos = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((x) => x[1]))];
  assert.ok(pedidos.length >= 25, "se encuentran los $(\"…\") (" + pedidos.length + ")");
  assert.deepStrictEqual(pedidos.filter((id) => !ids.includes(id)), []);
  // Cada entrada del índice lleva a un apartado que existe.
  const enlaces = [...html.matchAll(/<a href="#([a-z]+)"/g)].map((x) => x[1]);
  assert.ok(enlaces.includes("claves"), "«Claves de IA» está en el índice");
  for (const destino of enlaces) assert.match(html, new RegExp(`<section id="${destino}" class="apartado">`), "#" + destino);
});

test("options.html lleva escrito en español lo mismo que dice el diccionario: es lo que se ve hasta que se traduce", () => {
  const html = leeExt("options.html"), es = i18n.TEXTOS.es;
  const junto = (s) => String(s).replace(/\s+/g, " ").trim();
  const distintos = [];
  const compara = (clave, escrito) => { if (junto(escrito) !== junto(es[clave])) distintos.push(`${clave}: «${junto(escrito)}»`); };
  // El texto de un elemento, sin etiquetas dentro; y el que sí las lleva (data-i18n-html).
  let vistos = 0;
  for (const x of html.matchAll(/<(\w+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)) { vistos++; compara(x[2], x[3]); }
  for (const x of html.matchAll(/<(\w+)[^>]*\sdata-i18n-html="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) { vistos++; compara(x[2], x[3]); }
  // Y los atributos: el marcador, el título y la etiqueta para lectores de pantalla.
  for (const [etiqueta] of html.matchAll(/<\w+[^>]*>/g)) {
    for (const [, atributo, clave] of etiqueta.matchAll(/\sdata-i18n-(placeholder|title|aria-label)="([^"]+)"/g)) {
      const escrito = etiqueta.match(new RegExp(`\\s${atributo}="([^"]*)"`));
      vistos++;
      compara(clave, escrito ? escrito[1] : "(sin escribir)");
    }
  }
  assert.strictEqual(vistos, (html.match(/\sdata-i18n(-[a-z-]+)?="/g) || []).length, "se ha mirado cada data-i18n de la página");
  assert.deepStrictEqual(distintos, []);
});

test("options.html no lleva escrito ningún proveedor que no sea Gemini: tarjetas, desplegables y precios salen del registro", () => {
  const html = leeExt("options.html");
  for (const p of Object.values(prov.PROVEEDORES)) {
    if (p.id === "gemini") continue;
    for (const dato of [p.nombre, p.etiqueta, p.campoClave, p.campoModelo, p.campoVoz, new URL(p.base).host, p.urlClave, p.urlPrecios]) {
      if (dato) assert.ok(!html.includes(dato), `options.html nombra «${dato}» (${p.id}): con su interruptor apagado seguiría a la vista`);
    }
  }
  // Y options.js no decide nada por el id de un proveedor, salvo apartar a Gemini, que tiene su paso.
  const js = leeExt("options.js");
  for (const id of IDS_PROV.filter((x) => x !== "gemini")) assert.doesNotMatch(js, new RegExp(`["'\`]${id}["'\`]`), `options.js lleva «${id}» escrito`);
  for (const campo of ["openaiKey", "claudeKey", "mistralKey", "groqKey", "deepseekKey", "openrouterKey"]) assert.ok(!js.includes(campo), campo);
});

test("lo que llega de la API de un proveedor (ids de modelo) pasa por escapa() antes de ir a innerHTML", () => {
  const js = leeExt("options.js");
  // Cada plantilla que monta un <option>: todo lo que se le mete es escapa(…), o
  // un trozo fijo elegido con una condición («disabled»).
  const plantillas = [...js.matchAll(/`[^`]*<option[^`]*`/g)].map((x) => x[0]);
  assert.ok(plantillas.length >= 4, "se encuentran los <option> (" + plantillas.length + ")");
  for (const p of plantillas) {
    for (const [, dentro] of p.matchAll(/\$\{([^}]*)\}/g)) {
      assert.ok(/^escapa\(/.test(dentro) || /^\w+ \? "[^"]*" : "[^"]*"$/.test(dentro), `sin escapar: \${${dentro}} en ${p}`);
    }
  }
  // Y las listas de modelos no se montan en ningún otro sitio.
  assert.strictEqual((js.match(/<option/g) || []).length, plantillas.reduce((n, p) => n + (p.match(/<option/g) || []).length, 0));
});

test("los textos generales de Opciones no nombran a ninguna IA: valen con cualquier combinación de interruptores", () => {
  const nombres = [...new Set(Object.values(prov.PROVEEDORES).filter((p) => p.id !== "gemini").flatMap((p) => [p.nombre, p.etiqueta]))];
  // De Gemini (y de Google) solo hablan los suyos: su paso, su modelo, su capa gratuita y Google Meet.
  const deGemini = ["opc.costeTexto", "opc.modeloGemini", "opc.modeloGeminiAyuda", "opc.p1Texto", "opc.p1Titulo", "opc.preciosCargados", "opc.avisoTexto"];
  const malos = [];
  for (const idioma of ["es", "en"]) {
    for (const [k, v] of Object.entries(i18n.TEXTOS[idioma])) {
      if (!k.startsWith("opc.") || /^opc\.prov(Ayuda|Aviso)/.test(k)) continue;
      for (const n of nombres) if (new RegExp(`\\b${n}\\b`).test(v)) malos.push(`${idioma} ${k}: nombra a ${n}`);
      if (/Gemini|Google/.test(v) && !deGemini.includes(k)) malos.push(`${idioma} ${k}: nombra a Gemini o a Google`);
    }
  }
  assert.deepStrictEqual(malos, []);
  // Las frases que la 3.8 ha dejado de poder decir.
  for (const idioma of ["es", "en"]) {
    const todo = Object.entries(i18n.TEXTOS[idioma]).filter(([k]) => k.startsWith("opc.")).map(([, v]) => v).join("\n");
    assert.doesNotMatch(todo, /siempre Gemini|always done by Gemini|Google, OpenAI o Anthropic|Google, OpenAI or Anthropic/);
  }
});

// ============================================================================
// 3.8 — grabar sin clave, popup, biblioteca e importar (plan, apartados 5 y 8)
// ============================================================================
grupo("3.8 · la puerta del popup: cuándo se enseña el panel de grabar (proveedores.js)");

test("puedeGrabar: que haya con quién transcribir, o haber pedido grabar sin clave, o una grabación ya en curso", () => {
  const ctx = cargar("proveedores.js");
  const puerta = (cfg, grabando) => ctx.puedeGrabar(cfg, grabando);
  // Primer uso: nada de nada, y sale la bienvenida.
  assert.strictEqual(puerta({}, false), false);
  assert.strictEqual(puerta({ geminiKey: "", grabarSinClave: false }, false), false);
  assert.strictEqual(puerta({ geminiKey: "   " }, false), false, "una clave en blanco no es una clave");
  assert.strictEqual(puerta(undefined, undefined), false, "sin configuración no revienta");
  // Cada una de las tres cosas, por separado, la abre.
  assert.strictEqual(puerta({ geminiKey: "G" }, false), true);
  assert.strictEqual(puerta({ grabarSinClave: true }, false), true);
  assert.strictEqual(puerta({}, true), true, "una grabación arrancada con el atajo tiene que poder pararse");
  // Estado de salida: la clave de quien no transcribe no la abre…
  assert.strictEqual(puerta({ openaiKey: "O", claudeKey: "C", groqKey: "Q", mistralKey: "M" }, false), false);
  // …y el día que se encienda su voz, sí.
  encender(ctx, "groq.voz");
  assert.strictEqual(puerta({ groqKey: "Q" }, false), true);
  assert.strictEqual(puerta({ openaiKey: "O" }, false), false);
  // Siempre un booleano: popup.js lo niega tal cual.
  for (const r of [puerta({ geminiKey: "G" }, false), puerta({ grabarSinClave: 1 }, 0), puerta({}, "sí"), puerta(null, null)]) assert.strictEqual(typeof r, "boolean");
});

test("popup.js, importar.js y el panel en vivo no miran la clave de Gemini: preguntan al registro quién transcribe", () => {
  for (const f of ["popup.js", "importar.js", "vivo.js", "reuniones.js"]) {
    assert.doesNotMatch(leeExt(f), /geminiKey|geminiModel|generativelanguage/, f + " lleva a Gemini escrito a mano");
  }
  const popup = leeExt("popup.js");
  assert.match(popup, /if \(!puedeGrabar\(cfg, grabando\)\)/, "la puerta");
  assert.doesNotMatch(popup, /\bfetch\(/, "la conexión del Diagnóstico se prueba con listarModelos (config.js), sin direcciones escritas");
  assert.match(popup, /await listarModelos\(prov, clave\)/);
  assert.match(leeExt("importar.js"), /\$\("avisoClave"\)\.hidden = !!proveedorVoz\(/);
  assert.match(leeExt("vivo.js"), /!proveedorVoz\(cfg\)/);
  // Y ninguna de esas páginas trae escrito el nombre de una IA.
  for (const f of ["popup.html", "importar.html", "vivo.html", "reuniones.html"]) assert.doesNotMatch(leeExt(f), /Gemini|Google|OpenAI|Anthropic|Claude|GPT/, f);
});

test("Diagnóstico: con Gemini la línea de la conexión sale letra por letra como en la 3.7; con otro proveedor, en la misma columna", () => {
  // conGuia es de popup.js, que no se puede cargar sin DOM: se evalúa su definición tal cual.
  const trozo = leeExt("popup.js").match(/const COLUMNA_DIAG = \d+;\r?\nconst conGuia = [^\n]*;/);
  assert.ok(trozo, "COLUMNA_DIAG y conGuia siguen juntas en popup.js");
  const conGuia = require("vm").runInNewContext(trozo[0] + "\nconGuia");
  const linea = (nombre, resultado) => conGuia(i18n.t("pop.diagConexion", nombre)) + resultado;
  i18n._ponIdioma("es");
  assert.strictEqual(linea("Gemini", i18n.t("pop.diagConexionOk")), "2. Conexión con Gemini ..... OK");
  assert.strictEqual(linea("Gemini", i18n.t("pop.diagConexionHttp", 400)), "2. Conexión con Gemini ..... FALLA (HTTP 400)");
  assert.strictEqual(linea("Gemini", i18n.t("pop.diagConexionErr", "Failed to fetch")), "2. Conexión con Gemini ..... FALLA (Failed to fetch)");
  // La columna del resultado es la de las demás líneas del informe.
  const columna = i18n.t("pop.diagClaveOk", "AIzaSy").indexOf("OK");
  for (const p of Object.values(prov.PROVEEDORES).filter((x) => x.voz)) {
    assert.strictEqual(linea(p.nombre, "OK").indexOf(" OK") + 1, columna, p.nombre);
  }
  assert.match(conGuia("una etiqueta que ya pasa de la columna del informe"), / \.\. $/, "nunca menos de dos puntos");
  assert.strictEqual(i18n.t("pop.diagSinClave").search(/ NO HAY/) + 1, columna, "y la de «sin clave», también");
  i18n._ponIdioma("en");
  assert.strictEqual(linea("Gemini", i18n.t("pop.diagConexionOk")), "2. Gemini connection ....... OK");
  assert.strictEqual(linea("Gemini", i18n.t("pop.diagConexionHttp", 503)), "2. Gemini connection ....... FAILED (HTTP 503)");
  assert.strictEqual(i18n.t("pop.diagSinClave").search(/ NONE/) + 1, i18n.t("pop.diagClaveOk", "AIzaSy").indexOf("OK"));
  i18n._ponIdioma("es");
});

grupo("3.8 · grabada sin clave: ni fallo ni «incompleta» (comun.js, background.js)");

test("esperanClave y sinTranscribir: lo único que les falta a los tramos pendientes es una clave", () => {
  const ok = tramoOk("[00:01] Hablante 1: hola"), sinClave = tramoPend("sin_clave"), saturado = tramoPend("saturado");
  assert.strictEqual(comun.esperanClave([sinClave, sinClave]), true);
  assert.strictEqual(comun.esperanClave([ok, { estado: "mudo" }, sinClave]), true, "lo ya transcrito y lo mudo no cuentan");
  assert.strictEqual(comun.esperanClave([sinClave, saturado]), false, "si algo ha fallado de verdad, es una incompleta");
  assert.strictEqual(comun.esperanClave([tramoPend("clave_invalida")]), false, "una clave rechazada sí es un fallo");
  assert.strictEqual(comun.esperanClave([tramoPend("sin_saldo")]), false);
  assert.strictEqual(comun.esperanClave([{ estado: "pendiente" }]), false, "recién cerrado, sin intentar todavía: no se sabe");
  assert.strictEqual(comun.esperanClave([ok, { estado: "mudo" }, { estado: "perdido" }]), false, "sin nada pendiente no se espera nada");
  assert.strictEqual(comun.esperanClave([]), false);
  assert.strictEqual(comun.esperanClave(undefined), false);
  assert.strictEqual(comun.esperanClave([null, sinClave]), true, "un hueco en la lista no revienta");
  // La reunión: solo cuando ya está cerrada como pendiente.
  const h = (estado, tramos) => ({ id: 1, estado, tramos });
  assert.strictEqual(comun.sinTranscribir(h("pendiente", [sinClave, sinClave])), true);
  assert.strictEqual(comun.sinTranscribir(h("pendiente", [ok, sinClave])), true);
  assert.strictEqual(comun.sinTranscribir(h("transcribiendo", [sinClave])), false, "en plena ronda todavía no");
  assert.strictEqual(comun.sinTranscribir(h("grabando", [sinClave])), false);
  assert.strictEqual(comun.sinTranscribir(h("pendiente", [saturado])), false);
  assert.strictEqual(comun.sinTranscribir(h("ok", [ok])), false);
  assert.strictEqual(comun.sinTranscribir(h("error", [])), false);
  assert.strictEqual(comun.sinTranscribir({ id: 2, estado: "pendiente" }), false, "una entrada antigua, sin tramos");
  assert.strictEqual(comun.sinTranscribir(null), false);
});

test("el .md de una reunión grabada sin clave dice que se transcribirá al poner una, no que «se reintentará sola»", () => {
  i18n._ponIdioma("es");
  const md = comun.construirMarkdown({ fecha: "05/10/2026 10:00", titulo: "Comité", meta: { minutos: 10 }, tramos: [tramoPend("sin_clave"), tramoPend("sin_clave")] });
  assert.match(md, /2 de 2 tramos siguen sin transcribir/);
  assert.match(md, /se transcribirá sola en cuanto pongas en Opciones la clave/);
  assert.doesNotMatch(md, /reintent|Gemini|Google|falta/i);
  // Con algo que sí ha fallado es una incompleta de las de siempre.
  const mixta = comun.construirMarkdown({ fecha: "x", meta: { minutos: 10 }, tramos: [tramoPend("sin_clave"), tramoPend("saturado")] });
  assert.match(mixta, /se reintentará sola, y también puedes pulsar «Reintentar»/);
  assert.doesNotMatch(mixta, /en cuanto pongas en Opciones la clave/);
  // Y la de un solo tramo.
  assert.match(comun.construirMarkdown({ fecha: "x", meta: {}, tramos: [tramoPend("sin_clave")] }), /El audio sigue sin transcribir\.\*\* Su audio está guardado dentro de Escriba: se transcribirá sola/);
});

test("el icono al terminar: ✓ verde si se transcribió, «!» rojo si algo falló y ✓ en el color de la casa si se grabó sin clave", async () => {
  const { chrome, enviar } = bg();
  const ultimo = () => [chrome._registro.badges[chrome._registro.badges.length - 1], chrome._registro.colores[chrome._registro.colores.length - 1]];
  await enviar({ target: "bg", cmd: "listo", ok: true });
  assert.deepStrictEqual(ultimo(), ["✓", "#2e7d32"]);
  await enviar({ target: "bg", cmd: "listo", ok: false });
  assert.deepStrictEqual(ultimo(), ["!", "#c0392b"]);
  await enviar({ target: "bg", cmd: "listo", ok: false, sinClave: true });
  assert.deepStrictEqual(ultimo(), ["✓", "#5d2a42"], "guardada está; transcrita, no");
  // Quien avisa (offscreen.js) lo sabe por lo que le contesta finRonda.
  const b = bg({ local: { historial: [
    reunion(130, 2, { tramos: [{ ...tramoPend("sin_clave"), pico: 0.3 }, { ...tramoPend("sin_clave"), pico: 0.3 }] }),
    reunion(131, 1, { tramos: [{ ...tramoPend("saturado"), pico: 0.3 }] }),
    reunion(132, 1, { tramos: [{ estado: "ok", texto: "[00:01] Hablante 1: hola" }] }),
  ] } });
  assert.deepStrictEqual({ ...(await b.enviar({ target: "bg", cmd: "finRonda", id: 130 })) }, { ok: true, estado: "pendiente", sinClave: true });
  assert.deepStrictEqual({ ...(await b.enviar({ target: "bg", cmd: "finRonda", id: 131 })) }, { ok: true, estado: "pendiente" });
  assert.deepStrictEqual({ ...(await b.enviar({ target: "bg", cmd: "finRonda", id: 132 })) }, { ok: true, estado: "ok" });
});

grupo("3.8 · grabar sin clave, de punta a punta");

test("grabar sin clave: el audio queda guardado y la reunión «sin transcribir», sin que nada suene a fallo; al guardar una clave se transcribe sola", async () => {
  i18n._ponIdioma("es");
  const f = fetchPorTramo({ 1: [respGemini("[00:10] Hablante 1: uno")], 2: [respGemini("[00:05] Hablante 1: dos")] });
  const reloj = { t: 4000000 };
  const s = sistemaGrabando({ fetch: f, reloj, local: { geminiKey: "", geminiModel: "" }, sync: { grabarSinClave: true } });
  // Lo que deja guardado «Grabar sin transcribir» abre la puerta del popup.
  const cfg = await s.bgCtx.leerConfig();
  assert.deepStrictEqual([prov.proveedorVoz(cfg), prov.puedeGrabar(cfg, false)], ["", true]);
  await s.off.start({ modo: "mic", participantes: "Marcos" });
  const id = s.historial()[0].id;
  reloj.t += comun.DURACION_TRAMO_S * 1000;
  s.off.cortaTramo();
  await hasta(() => ((s.entrada(id).tramos || [])[0] || {}).codigo === "sin_clave", "que el primer tramo quedara esperando la clave");
  assert.strictEqual(s.entrada(id).estado, "grabando", "se sigue grabando");
  reloj.t += 60000;
  s.off.stop();
  await hasta(() => s.entrada(id).estado === "pendiente", "que se cerrara la grabación");
  await hasta(() => s.chrome._registro.badges.length > 0, "el aviso del final");
  let h = s.entrada(id);
  assert.deepStrictEqual([...h.tramos.map((t) => [t.estado, t.codigo])], [["pendiente", "sin_clave"], ["pendiente", "sin_clave"]]);
  assert.strictEqual(comun.sinTranscribir(h), true);
  assert.strictEqual(f._llamadas.length, 0, "sin clave no se llama a nadie");
  assert.strictEqual(s.audios._datos.size, 2, "el audio de los dos tramos sigue guardado");
  assert.ok(h.reintento.esperaClave);
  assert.deepStrictEqual(Object.keys(s.chrome._registro.alarmas), [], "nada que reintentar hasta que haya clave");
  // Lo que se le dice al usuario: guardado, y qué hace falta. Nada de «falta», «Gemini» ni «se reintentará».
  for (const t of h.tramos) assert.strictEqual(t.error, comun.textoError("sin_clave"));
  assert.doesNotMatch(h.tramos[0].error, /Gemini|Google|falta|reintent/i);
  assert.match(h.tramos[0].error, /El audio está guardado.*Opciones/);
  assert.match(h.transcript, /se transcribirá sola en cuanto pongas en Opciones la clave/);
  assert.doesNotMatch(h.transcript, /reintentará|Gemini/);
  // El icono: hecho, en el color de la casa. Ni el «!» rojo ni el verde de «transcrita».
  assert.deepStrictEqual([s.chrome._registro.badges, s.chrome._registro.colores], [["✓"], ["#5d2a42"]]);
  // La copia de seguridad de cada tramo, en Descargas, y el .md.
  assert.deepStrictEqual(s.chrome._registro.descargas.map((d) => d.filename.replace(/_\d{4}-\d\d-\d\d_\d{4}/, "")).sort(),
    ["reuniones/audio/tramo01.webm", "reuniones/audio/tramo02.webm", "reuniones/reunion.md"]);
  // El usuario pone una clave en Opciones: se transcribe sola, y ya es una reunión como las demás.
  await s.chrome.storage.local.set({ geminiKey: "NUEVA", geminiModel: "gemini-flash-latest" });
  await hasta(() => s.entrada(id).estado === "ok", "que se transcribiera al poner la clave");
  h = s.entrada(id);
  assert.deepStrictEqual([...h.tramos.map((t) => [t.texto, t.prov, t.codigo])], [["[00:10] Hablante 1: uno", "gemini", undefined], ["[05:05] Hablante 1: dos", "gemini", undefined]]);
  assert.strictEqual(comun.sinTranscribir(h), false);
  assert.strictEqual(s.audios._datos.size, 0, "con el texto a salvo, el audio pendiente sobra");
  assert.doesNotMatch(h.transcript, /sin transcribir|pendiente/);
  await hasta(() => s.chrome._registro.badges.length === 2, "el aviso de transcrita");
  assert.deepStrictEqual([s.chrome._registro.badges[1], s.chrome._registro.colores[1]], ["✓", "#2e7d32"]);
});

test("un archivo importado sin clave queda igual: guardado, sin transcribir, y sin una sola petición", async () => {
  const f = fetchPorTramo({ 1: [respGemini("uno")] });
  const s = sistema({ local: { geminiKey: "", historial: [reunion(150, 1, { origen: "archivo" })] }, audios: [[150, 0, blobDe(null, 1000, "audio/wav")]], fetch: f });
  await s.off.transcribirReunion(150);
  const h = s.entrada(150);
  assert.strictEqual(comun.sinTranscribir(h), true);
  assert.deepStrictEqual([f._llamadas.length, s.audios._datos.size], [0, 1]);
  assert.ok(s.chrome._registro.descargas.some((d) => /tramo01\.wav$/.test(d.filename)), "la copia en Descargas conserva su formato");
});

grupo("3.8 · textos: sin clave no suena a fallo, y nadie nombra a Gemini sin hablar de Gemini (i18n.js)");

test("ningún texto de fuera de Opciones nombra a Gemini, a Google ni a otra IA, salvo los que hablan de Gemini en concreto", () => {
  // Los que se quedan: lo que solo pasa en el camino de Gemini al transcribir (su
  // generateContent y su Files API, en offscreen.js) y su cascada de modelos al
  // redactar (ia.js). Los de Opciones tienen su test más arriba.
  const deGemini = ["ia.cambioModelo", "off.noProcesado", "off.sinConexion", "off.sinConexionSubida", "off.subidaFallo", "off.textoVacio", "off.textoVacioRazon"];
  const otras = [...new Set(Object.values(prov.PROVEEDORES).filter((p) => p.id !== "gemini").flatMap((p) => [p.nombre, p.etiqueta]))];
  const malos = [], conGemini = new Set();
  for (const idioma of ["es", "en"]) {
    for (const [k, v] of Object.entries(i18n.TEXTOS[idioma])) {
      if (k.startsWith("opc.")) continue;
      if (/Gemini|Google/.test(v)) { conGemini.add(k); if (!deGemini.includes(k)) malos.push(`${idioma} ${k}: nombra a Gemini o a Google`); }
      for (const n of otras) if (new RegExp(`\\b${n}\\b`).test(v)) malos.push(`${idioma} ${k}: nombra a ${n}`);
    }
  }
  assert.deepStrictEqual(malos, []);
  assert.deepStrictEqual([...conGemini].sort(), deGemini, "en la lista de excepciones no queda ninguna que ya no nombre a Gemini");
  // Esas siete solo se usan donde se habla con Gemini.
  for (const k of deGemini) {
    const donde = fsT.readdirSync(RAIZ_EXT).filter((n) => /\.(js|html)$/.test(n) && n !== "i18n.js" && leeExt(n).includes(`"${k}"`));
    assert.deepStrictEqual(donde, [k.startsWith("ia.") ? "ia.js" : "offscreen.js"], k);
  }
  // Los errores de un tramo valen para cualquiera que transcriba: se guardan escritos en el historial.
  for (const codigo of ["sin_clave", "clave_invalida", "sin_saldo", "saturado", "red", "interno", "otro", "perdido"]) {
    for (const idioma of ["es", "en"]) {
      i18n._ponIdioma(idioma);
      assert.doesNotMatch(comun.textoError(codigo), /Gemini|Google/, `${idioma} ${codigo}`);
    }
  }
  i18n._ponIdioma("es");
});

test("los textos de «grabada sin clave», en los dos idiomas: dicen que está guardada y qué hace falta, sin sonar a fallo", () => {
  const neutros = ["com.errSinClave", "com.mdPendSinClave", "pop.sinClave", "pop.luegoSinClave", "pop.listaSinClave", "pop.notaSinClave", "pop.badgeSinTranscribir", "pop.pararSinClave",
    "pop.guardandoEspera", "pop.diagSinClave", "pop.diagNoProbadaSinClave", "bib.estado_sin_transcribir", "bib.aviso_sin_clave_html", "bib.tramo_sin_clave",
    "imp.avisoClaveHtml", "imp.pendienteSinClave", "viv.sinClave", "viv.textoVacioSinClave", "viv.guardada", "viv.pararSinClave"];
  for (const idioma of ["es", "en"]) {
    for (const k of neutros) {
      const v = i18n.TEXTOS[idioma][k];
      assert.ok(v, `${idioma} ${k}`);
      assert.doesNotMatch(v, /\bfalta|\bfall[oóa]|\berror|reintent|\bfail|\bmissing|\bretr|couldn't|⚠/i, `${idioma} ${k}: suena a fallo`);
    }
    // Los que dicen qué hacer mandan a Opciones.
    for (const k of ["com.errSinClave", "com.mdPendSinClave", "pop.luegoSinClave", "pop.notaSinClave", "bib.aviso_sin_clave_html", "imp.avisoClaveHtml", "imp.pendienteSinClave", "viv.textoVacioSinClave"]) {
      assert.match(i18n.TEXTOS[idioma][k], /Opciones|Options/, `${idioma} ${k}`);
    }
  }
  // La línea fija del popup, como la pide el plan: se graba y se guarda, no se transcribe.
  assert.match(i18n.TEXTOS.es["pop.sinClave"], /^Sin clave de IA.*graba y guarda el audio, pero no lo transcribe\.$/);
  assert.strictEqual(i18n.TEXTOS.es["pop.grabarSinClave"], "Grabar sin transcribir");
  // Y el tramo que espera la clave lleva ese texto, no el de un fallo.
  assert.strictEqual(comun.textoError("sin_clave"), i18n.TEXTOS.es["com.errSinClave"]);
});

// Lo que una página lleva escrito en español frente al diccionario: es lo que se
// ve hasta que se traduce. Devuelve las diferencias.
function textosEnLinea(fichero) {
  const html = leeExt(fichero), es = i18n.TEXTOS.es;
  const junto = (s) => String(s).replace(/\s+/g, " ").trim();
  const distintos = [];
  const compara = (clave, escrito) => { if (junto(escrito) !== junto(es[clave])) distintos.push(`${fichero} › ${clave}: «${junto(escrito)}»`); };
  let vistos = 0;
  for (const x of html.matchAll(/<(\w+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)) { vistos++; compara(x[2], x[3]); }
  for (const x of html.matchAll(/<(\w+)[^>]*\sdata-i18n-html="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) { vistos++; compara(x[2], x[3]); }
  for (const [etiqueta] of html.matchAll(/<\w+[^>]*>/g)) {
    for (const [, atributo, clave] of etiqueta.matchAll(/\sdata-i18n-(placeholder|title|aria-label)="([^"]+)"/g)) {
      const escrito = etiqueta.match(new RegExp(`\\s${atributo}="([^"]*)"`));
      vistos++;
      compara(clave, escrito ? escrito[1] : "(sin escribir)");
    }
  }
  assert.strictEqual(vistos, (html.match(/\sdata-i18n(-[a-z-]+)?="/g) || []).length, fichero + ": se ha mirado cada data-i18n");
  return distintos;
}

test("popup, biblioteca, importar y panel en vivo: el HTML lleva escrito en español lo que dice el diccionario", () => {
  assert.deepStrictEqual(["popup.html", "reuniones.html", "importar.html", "vivo.html"].flatMap(textosEnLinea), []);
});

test("todo id que popup.js, reuniones.js, importar.js y vivo.js buscan con $(\"…\") existe en su página, y ninguno está repetido", () => {
  for (const [pagina, guion, minimo] of [["popup.html", "popup.js", 30], ["reuniones.html", "reuniones.js", 40], ["importar.html", "importar.js", 15], ["vivo.html", "vivo.js", 15]]) {
    const ids = [...leeExt(pagina).matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
    assert.deepStrictEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], pagina + ": ids repetidos");
    const pedidos = [...new Set([...leeExt(guion).matchAll(/\$\("([^"]+)"\)/g)].map((x) => x[1]))];
    assert.ok(pedidos.length >= minimo, `${guion}: se encuentran los $("…") (${pedidos.length})`);
    assert.deepStrictEqual(pedidos.filter((id) => !ids.includes(id)), [], guion);
  }
  // Lo nuevo de la 3.8 está donde se le busca.
  const popup = leeExt("popup.html");
  for (const id of ["btnSinClave", "avisoSinClave", "btnPonerClave"]) assert.ok(popup.includes(`id="${id}"`), id);
  assert.ok(popup.indexOf('id="btnSinClave"') < popup.indexOf('id="panelGrabar"'), "«Grabar sin transcribir» va en la bienvenida");
  assert.ok(popup.indexOf('id="avisoSinClave"') > popup.indexOf('id="panelGrabar"'), "y el aviso de que no habrá texto, en el panel de grabar");
  assert.match(leeExt("reuniones.html"), /id="btnEscuchar"[^>]*>.*data-i18n="bib\.escuchar"/);
});

grupo("3.8 · líneas sin hablante, y actas cortadas (comun.js, exportar.js, background.js)");

test("líneas sin hablante: se leen con su hora y sin inventarse a nadie, y lo que se exporta no lleva el carácter invisible", () => {
  // Lo que deja un proveedor que no distingue hablantes (offscreen.js: segmentosATexto).
  const tramo = ["[00:10] buenos días a todos", "[00:12] " + comun.SIN_HABLANTE + "Primer punto: hay que cerrar el presupuesto",
    comun.SIN_HABLANTE + "Segundo punto: plazos", "[00:40] vale, de acuerdo"].join("\n");
  // El visor: la biblioteca, el popup y el panel en vivo leen todos con lineasTranscripcion.
  assert.deepStrictEqual(comun.lineasTranscripcion(tramo).map((l) => [l.t, l.hablante, l.texto]), [
    [10, "", "buenos días a todos"], [12, "", "Primer punto: hay que cerrar el presupuesto"], [null, "", "Segundo punto: plazos"], [40, "", "vale, de acuerdo"]]);
  assert.deepStrictEqual(comun.hablantesDe(tramo), []);
  const md = comun.construirMarkdown({ fecha: "05/10/2026 10:00", titulo: "Comité", meta: { minutos: 1 }, tramos: [{ estado: "ok", texto: tramo }] });
  assert.ok(md.includes(comun.SIN_HABLANTE), "en el .md del historial la protección sigue: se relee");
  // Lo que sale de Escriba: copiar y .txt, Word, el .md exportado a mano y los subtítulos.
  const limpio = comun.sinMarcaInvisible(md);
  assert.ok(!limpio.includes(comun.SIN_HABLANTE));
  assert.strictEqual(limpio, md.split(comun.SIN_HABLANTE).join(""), "y no cambia nada más");
  const lineas = "[00:10] buenos días a todos\n[00:12] Primer punto: hay que cerrar el presupuesto\nSegundo punto: plazos\n[00:40] vale, de acuerdo";
  assert.ok(exportar.textoPlano(limpio).endsWith(lineas), exportar.textoPlano(limpio));
  const word = leerZip(exportar.docx("Comité", limpio.replace(/^# .*\n+/, "")))["word/document.xml"];
  assert.ok(word.includes(">[00:12] Primer punto: hay que cerrar el presupuesto<") && !word.includes(comun.SIN_HABLANTE));
  assert.strictEqual(exportar.srt(tramo),
    "1\n00:00:10,000 --> 00:00:12,000\nbuenos días a todos\n\n2\n00:00:12,000 --> 00:00:40,000\nPrimer punto: hay que cerrar el presupuesto Segundo punto: plazos\n\n3\n00:00:40,000 --> 00:00:46,000\nvale, de acuerdo\n");
  // Un texto sin ese carácter (todo lo de Gemini) pasa tal cual.
  assert.strictEqual(comun.sinMarcaInvisible("[00:01] Hablante 1: hola\n[00:05] Hablante 2: buenas"), "[00:01] Hablante 1: hola\n[00:05] Hablante 2: buenas");
  assert.strictEqual(comun.sinMarcaInvisible(undefined), "");
  // Las salidas de la biblioteca (exportar y copiar) y la del popup pasan por ahí.
  assert.strictEqual((leeExt("reuniones.js").match(/sinMarcaInvisible\(mdTranscripcion\(/g) || []).length, 2);
  assert.match(leeExt("popup.js"), /writeText\(sinMarcaInvisible\(texto\)\)/);
});

test("histAnalisis apunta las actas que el modelo cortó por longitud, y rehacerlas enteras lo quita", async () => {
  const { chrome, enviar } = bg({ local: { historial: [entradaHist(140, { analisis: { gemini: "ACTA VIEJA" } })] } });
  const h = () => chrome.storage.local._volcado().historial[0];
  await enviar({ target: "bg", cmd: "histAnalisis", id: 140, clave: "acta·gemini", texto: "ACTA A MED", uso: { entrada: 5, salida: 2 }, truncado: true });
  assert.deepStrictEqual([...h().cortadas], ["acta·gemini"]);
  await enviar({ target: "bg", cmd: "histAnalisis", id: 140, clave: "resumen·gpt", texto: "RESUMEN", truncado: false });
  assert.deepStrictEqual([...h().cortadas], ["acta·gemini"], "cada una por su clave");
  await enviar({ target: "bg", cmd: "histAnalisis", id: 140, clave: "resumen·gpt", texto: "RESUMEN A ME", truncado: true });
  assert.deepStrictEqual([...h().cortadas], ["acta·gemini", "resumen·gpt"]);
  await enviar({ target: "bg", cmd: "histAnalisis", id: 140, clave: "acta·gemini", texto: "ACTA ENTERA" });
  assert.deepStrictEqual([...h().cortadas], ["resumen·gpt"], "rehecha y entera: fuera el aviso");
  await enviar({ target: "bg", cmd: "histAnalisis", id: 140, clave: "resumen·gpt", texto: "RESUMEN ENTERO", truncado: false });
  assert.strictEqual(h().cortadas, undefined, "sin ninguna cortada no queda ni la lista");
  assert.deepStrictEqual({ ...h().analisis }, { gemini: "ACTA VIEJA", "acta·gemini": "ACTA ENTERA", "resumen·gpt": "RESUMEN ENTERO" });
});

test("el acta automática cortada también se apunta, y la biblioteca manda y enseña ese dato", async () => {
  // Gemini corta el acta por su límite de longitud (finishReason MAX_TOKENS).
  const f = fetchPorTramo({ 1: [respGemini("[00:01] Hablante 1: hola")] });
  const envoltorio = async (url, opts) => (/generateContent/.test(url) && !/TRAMO|Transcribe/.test(opts.body)
    ? respuestaHttp(respGemini("ACTA A MEDI", "MAX_TOKENS")) : f(url, opts));
  const s = sistema({ local: { historial: [reunion(141, 1)] }, sync: { autoActa: true }, audios: audioDe(141, 1), fetch: envoltorio });
  await s.off.transcribirReunion(141);
  await hasta(() => (s.entrada(141).analisis || {})["acta·gemini"], "el acta automática");
  assert.deepStrictEqual([s.entrada(141).analisis["acta·gemini"], [...s.entrada(141).cortadas]], ["ACTA A MEDI", ["acta·gemini"]]);
  // Una respuesta cortada a una pregunta: histChat guarda el mensaje como llega, con su marca.
  await s.enviar({ target: "bg", cmd: "histChat", id: 141, mensaje: { p: "¿Qué se dijo?", r: "Se dijo que", prov: "gemini", truncado: true } });
  assert.strictEqual(s.entrada(141).chat[0].truncado, true);
  const js = leeExt("reuniones.js");
  assert.match(js, /"histAnalisis", \{[^}]*truncado: !!r\.truncado/, "la biblioteca lo manda al guardar el acta");
  assert.match(js, /\(h\.cortadas \|\| \[\]\)\.includes\(actaSel\)/, "y lo avisa al leerla");
  assert.match(js, /m\.truncado \? /, "y en la respuesta a una pregunta");
});

// ============================================================================
grupo("3.8 · lo que encontró la revisión: nada sin transcribir se borra solo (background.js)");

test("una reunión transcrita con retraso no se poda nada más transcribirse: tiene una semana de margen", async () => {
  // Doce grabadas sin clave; se pone la clave y se transcriben las doce. Con el
  // límite de fábrica (10), las dos más antiguas se borraban recién transcritas.
  const tramoOk = { estado: "ok", texto: "[00:01] Hablante 1: hola", pico: 0.3 };
  const hist = Array.from({ length: 12 }, (_, i) => reunion(200 + i, 1, { estado: "transcribiendo", tramos: [tramoOk], reintento: { n: 0, esperaClave: true, proximo: null, ultimo: Date.now() } }));
  const { chrome, enviar } = bg({ local: { historial: hist }, sync: { limite: 10 } });
  for (const h of hist) await enviar({ target: "bg", cmd: "finRonda", id: h.id });
  let guardado = chrome.storage.local._volcado().historial;
  assert.ok(guardado.every((h) => h.estado === "ok" && typeof h.puestaAlDia === "number" && h.reintento === null), "todas transcritas y con su fecha apuntada");
  // Empezar otra grabación tampoco se las lleva: el tope del historial respeta el mismo margen.
  const muchas = Array.from({ length: 103 }, (_, i) => entradaHist(5000 + i, { fileMd: 900 + i, puestaAlDia: Date.now() }));
  const tope = bg({ local: { historial: muchas } });
  await tope.enviar({ target: "bg", cmd: "histCrear", item: entradaHist(4999, { estado: "grabando" }) });
  assert.strictEqual(tope.chrome.storage.local._volcado().historial.length, 104, "ni una de las recién puestas al día se cae por el tope");
  assert.deepStrictEqual(tope.chrome._registro.borrados, []);
  assert.deepStrictEqual({ ...(await enviar({ target: "bg", cmd: "podar" })) }, { ok: true, entradas: 0, ficheros: 0 });
  assert.strictEqual(chrome.storage.local._volcado().historial.length, 12, "ninguna se ha ido");
  // Pasada la semana vuelven a ser como las demás: el límite se aplica.
  guardado = guardado.map((h) => ({ ...h, puestaAlDia: Date.now() - 8 * 86400000 }));
  await chrome.storage.local.set({ historial: guardado });
  assert.strictEqual((await enviar({ target: "bg", cmd: "podar" })).entradas, 2);
  assert.strictEqual(chrome.storage.local._volcado().historial.length, 10);
});

test("una reunión que se cierra con retraso y acaba en error también tiene su semana: su copia de audio es lo único que queda", async () => {
  // Esperaba la clave; al transcribirla, el modelo dice que no hay voz en ningún tramo.
  const fallida = reunion(230, 1, { estado: "transcribiendo", fileMd: 31, filesAudio: [32], tramos: [{ estado: "mudo", pico: 0.3 }], reintento: { n: 0, esperaClave: true, proximo: null, ultimo: Date.now() } });
  const { chrome, enviar } = bg({ local: { historial: [entradaHist(231), entradaHist(232), fallida] }, sync: { limite: 1 } });
  const r = await enviar({ target: "bg", cmd: "finRonda", id: 230 });
  assert.notStrictEqual(r.estado, "pendiente");
  assert.strictEqual(typeof chrome.storage.local._volcado().historial[2].puestaAlDia, "number", "estado final " + r.estado + ": lleva su fecha");
  await enviar({ target: "bg", cmd: "podar" });
  assert.deepStrictEqual(chrome.storage.local._volcado().historial.map((h) => h.id), [231, 230], "la poda se lleva la terminada de siempre, no la recién cerrada");
  assert.ok(!chrome._registro.borrados.includes(32), "su audio de Descargas sigue en el disco");
});

test("una reunión transcrita a la primera no lleva esa fecha: para quien graba con clave la poda es la de siempre", async () => {
  const hist = [reunion(220, 1, { tramos: [{ estado: "ok", texto: "[00:01] Hablante 1: hola", pico: 0.3 }] }), entradaHist(221), entradaHist(222)];
  const { chrome, enviar } = bg({ local: { historial: hist }, sync: { limite: 1 } });
  await enviar({ target: "bg", cmd: "finRonda", id: 220 });
  assert.strictEqual(chrome.storage.local._volcado().historial[0].puestaAlDia, undefined);
  assert.strictEqual((await enviar({ target: "bg", cmd: "podar" })).entradas, 2);
  assert.deepStrictEqual(chrome.storage.local._volcado().historial.map((h) => h.id), [220]);
});

test("la grabación 101 no se lleva el audio de una que sigue sin transcribir: el tope solo quita reuniones terminadas", async () => {
  // Cien grabadas sin clave: empezar otra borraba la más antigua, con su audio.
  const pendientes = Array.from({ length: 100 }, (_, i) => reunion(1000 + i, 1, { estado: "pendiente", fileMd: 500 + i, tramos: [{ ...tramoPend("sin_clave"), pico: 0.3 }] }));
  const a = bg({ local: { historial: pendientes }, audios: pendientes.map((h) => [h.id, 0, blobDe(null)]) });
  await a.enviar({ target: "bg", cmd: "histCrear", item: entradaHist(1, { estado: "grabando" }) });
  assert.strictEqual(a.chrome.storage.local._volcado().historial.length, 101, "pasa del tope antes que borrar audio sin transcribir");
  assert.strictEqual(a.audios._datos.size, 100);
  assert.deepStrictEqual(a.chrome._registro.borrados, []);
  // Mezcladas: se van las terminadas que sobran, y solo esas.
  const mezcla = Array.from({ length: 100 }, (_, i) => (i === 99 ? reunion(2099, 1, { estado: "pendiente", fileMd: 799 }) : entradaHist(2000 + i, { fileMd: 700 + i })));
  const b = bg({ local: { historial: [entradaHist(1999, { fileMd: 699 }), ...mezcla] } });
  await b.enviar({ target: "bg", cmd: "histCrear", item: entradaHist(2, { estado: "grabando" }) });
  const ids = b.chrome.storage.local._volcado().historial.map((h) => h.id);
  assert.ok(ids.includes(2099), "la pendiente se queda aunque esté la última");
  assert.ok(!ids.includes(2098) && b.chrome._registro.borrados.includes(798), "la terminada que sobra se va, con su fichero");
  assert.ok(!b.chrome._registro.borrados.includes(799));
});

test("si la clave llega mientras se cierra una ronda sin clave, la reunión no se queda esperándola: se reintenta sola", async () => {
  const sinClave = () => reunion(300, 1, { tramos: [{ ...tramoPend("sin_clave"), pico: 0.3 }] });
  // Sin clave: espera, sin alarma (como siempre).
  const a = bg({ local: { historial: [sinClave()] } });
  await a.enviar({ target: "bg", cmd: "finRonda", id: 300 });
  assert.strictEqual(a.chrome.storage.local._volcado().historial[0].reintento.esperaClave, true);
  assert.deepStrictEqual(Object.keys(a.chrome._registro.alarmas), []);
  // La clave ya está cuando se cierra la ronda: reintento normal, con su alarma.
  const b = bg({ local: { historial: [sinClave()], geminiKey: "K" } });
  await b.enviar({ target: "bg", cmd: "finRonda", id: 300 });
  const r = b.chrome.storage.local._volcado().historial[0].reintento;
  assert.ok(!r.esperaClave && r.n === 1 && r.proximo > Date.now(), JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(b.chrome._registro.alarmas), ["reintento:300"]);
  // Una clave rechazada o sin saldo sigue esperando aunque haya clave: reintentar no lo arregla.
  for (const codigo of ["clave_invalida", "sin_saldo"]) {
    const c = bg({ local: { historial: [reunion(301, 1, { tramos: [{ ...tramoPend(codigo), pico: 0.3 }] })], geminiKey: "K" } });
    await c.enviar({ target: "bg", cmd: "finRonda", id: 301 });
    assert.strictEqual(c.chrome.storage.local._volcado().historial[0].reintento.esperaClave, true, codigo);
  }
});

test("Opciones: la clave de Gemini se puede quitar, y vaciar el campo no finge que ya no está", () => {
  const html = leeExt("options.html"), js = leeExt("options.js");
  assert.match(html, /id="quitarGemini"[^>]*data-i18n="opc\.quitarClave"/);
  const quitar = /\$\("quitarGemini"\)\.onclick = async \(\) => \{([\s\S]*?)\n\};/.exec(js)[1];
  assert.match(quitar, /guardarConfig\(\{ geminiKey: "", geminiModel: "" \}\)/, "el botón borra la clave guardada");
  assert.ok(quitar.indexOf('$("geminiKey").value = ""') < quitar.indexOf("await "), "y vacía el campo antes de su primer await: una comprobación en vuelo mira el campo");
  assert.match(js, /else if \(cfg\.geminiKey\) pinta\("e1", \(\) => t\("opc\.claveSigue"\)/, "con el campo vacío y la clave guardada, se dice que sigue");
  assert.match(js, /if \(\$\("geminiKey"\)\.value\.trim\(\) !== key\) \{ revisaVoz\(\); return; \}/, "una comprobación en vuelo no vuelve a guardar una clave que ya se quitó");
  assert.match(js, /quien === "gemini" && cfg\.geminiKey !== claveComprobada \? "" : quien/, "el paso 1 depende de la clave guardada, no de lo último tecleado");
  assert.ok(!/geminiValida/.test(js));
  assert.match(js, /if \(claveSinLista\(e\)\) pinta\(linea, \(\) => t\("opc\.provGuardadaSinLista"/, "al abrir, la clave con permisos recortados no sale como rechazada");
});

test("biblioteca: un aviso con negrita o enlace no se parte en columnas, y borrar la reunión abierta calla su audio", () => {
  assert.match(leeExt("estilo.css"), /\.aviso \.cuerpo \{[^}]*display: block;/, "«.cuerpo» es también la rejilla de la biblioteca");
  assert.match(leeExt("reuniones.js"), /if \(!actual\) paraAudio\(\);/);
  assert.match(leeExt("options.css"), /\.tarjeta\.prov \{/, "la tarjeta, no la celda «.prov» de la rejilla de precios");
  assert.ok(!/^\.prov \{/m.test(leeExt("options.css")));
});

// ============================================================================
(async function main() {
  let ok = 0, fallos = 0;
  for (const c of casos) {
    if (c.grupo) { console.log("\n" + c.grupo); continue; }
    try {
      await c.fn();
      ok++;
      console.log("  ✓ " + c.nombre);
    } catch (e) {
      fallos++;
      console.log("  ✗ " + c.nombre);
      console.log("      " + String((e && e.message) || e).split("\n").join("\n      "));
    }
  }
  console.log("\n" + ok + " correctos, " + fallos + " fallidos\n");
  process.exit(fallos ? 1 : 0);
})();
