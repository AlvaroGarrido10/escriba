// Suite de Escriba. Sin dependencias: `node tests/run.js`.
//
// Cada caso carga el fichero real de la extensión en un contexto aislado con el
// navegador simulado de stubs.js. Los marcados REGRESIÓN cubren un fallo que
// llegó a estar en producción; si vuelven a ponerse en rojo, ha vuelto.

"use strict";

const assert = require("assert");
const { cargar, mensajero } = require("./load");
const {
  nuevoChrome, nuevoFetch, respGemini, nuevoAudioContext, nuevoAudioElemento, nuevoColchon, nuevosMedios, blobDe, nuevosAudios, espera0,
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
    Blob: function Blob(partes) { return { size: (partes || []).length, type: "audio/webm" }; },
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
  return cargar(["comun.js", "offscreen.js"], entornoOffscreen(chrome, fetchStub));
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
  return { ctx: cargar(["comun.js", "offscreen.js"], entorno), entorno };
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
  return { ctx: cargar(["comun.js", "offscreen.js"], entorno), entorno, piezas: colchon._reg };
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
  const ctx = cargar(["comun.js", "offscreen.js"], entornoOffscreen(chrome, f));
  const r = await ctx.transcribirGemini(blobDe(null, 1000), 1, 1);
  assert.strictEqual(r.texto, "texto del tramo");
  assert.strictEqual(llamadas, 2);
});

test("si la configuración no llega nunca, el error es «interno», no «falta la clave»", async () => {
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? { ok: false, error: "reiniciando" } : { ok: true });
  const f = nuevoFetch([]);
  const ctx = cargar(["comun.js", "offscreen.js"], entornoOffscreen(chrome, f));
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
  assert.match(md, /saturado/);
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
  const off = cargar(["comun.js", "ia.js", "offscreen.js"], entornoOffscreen(offChrome, fetchStub));
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
// suyas aunque dos se transcriban a la vez.
function fetchPorTramo(porTramo) {
  const colas = {};
  for (const [k, v] of Object.entries(porTramo)) colas[k] = v.slice();
  const llamadas = [];
  const fn = async (url, opts = {}) => {
    const prompt = JSON.parse(opts.body || "{}").contents?.[0]?.parts?.[0]?.text || "";
    const m = /TRAMO (\d+) de/.exec(prompt);
    const idx = m ? Number(m[1]) : 1;
    llamadas.push({ url: String(url), idx });
    const r = (colas[idx] || []).shift();
    if (!r) throw new Error("fetch inesperado para el tramo " + idx);
    if (r.lanza) throw new Error(r.lanza);
    const cuerpo = typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo ?? {});
    const status = r.status === undefined ? 200 : r.status;
    return { ok: status < 300, status, async text() { return cuerpo; }, async json() { return JSON.parse(cuerpo); } };
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
  return cargar(["comun.js", "ia.js"], { fetch: fetchStub, setTimeout: (fn) => setImmediate(fn) });
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
function sistemaGrabando({ fetch: fetchStub = nuevoFetch([]), local = {}, sync = {}, reloj = null, retenerTimeouts = false } = {}) {
  const chrome = nuevoChrome({ local: { geminiKey: "K", geminiModel: "gemini-flash-latest", ...local }, sync });
  const aud = nuevosAudios();
  const bgCtx = cargar("background.js", { chrome, fetch: async () => { throw new Error("bg no debe llamar a la red"); } });
  bgCtx.audios = aud;
  const enviarBg = mensajero(chrome);
  const offChrome = nuevoChrome();
  offChrome.runtime.sendMessage = (msg) => enviarBg(msg);
  const medios = nuevosMedios({ conAudio: true });
  const timeouts = [];
  const entorno = {
    ...entornoOffscreen(offChrome, fetchStub),
    navigator: { mediaDevices: medios.mediaDevices },
    MediaRecorder: medios.MediaRecorder,
    Audio: nuevoAudioElemento(),
  };
  if (reloj) entorno.Date = relojFalso(reloj);
  if (retenerTimeouts) entorno.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };
  const off = cargar(["comun.js", "ia.js", "offscreen.js"], entorno);
  off.audios = aud;
  const enviarOff = mensajero(offChrome);
  chrome.runtime.sendMessage = (msg) => (msg.target === "offscreen" ? enviarOff(msg) : enviarBg(msg));
  chrome._registro.offscreen = 1;
  const historial = () => chrome.storage.local._volcado().historial || [];
  return { chrome, bgCtx, off, audios: aud, medios, timeouts, enviar: enviarBg, historial, entrada: (id) => historial().find((h) => h.id === id) };
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

test("el manifest pide como opcionales justo las webs que se reconocen", () => {
  const m = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "manifest.json"), "utf8"));
  global.chrome = nuevoChrome();
  delete require.cache[require.resolve("../config.js")];
  const cfg = require("../config.js");
  assert.deepStrictEqual([...m.optional_host_permissions].sort(), [...cfg.ORIGENES_REUNION].sort());
  assert.ok(!(m.host_permissions || []).some((o) => /meet|teams|zoom|jit\.si/.test(o)), "no se piden de entrada: solo al activar el aviso");
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
