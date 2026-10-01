// Suite de Escriba. Sin dependencias: `node tests/run.js`.
//
// Cada caso carga el fichero real de la extensión en un contexto aislado con el
// navegador simulado de stubs.js. Los marcados REGRESIÓN cubren un fallo que
// llegó a estar en producción; si vuelven a ponerse en rojo, ha vuelto.

"use strict";

const assert = require("assert");
const { cargar, mensajero } = require("./load");
const {
  nuevoChrome, nuevoFetch, respGemini, nuevoAudioContext, nuevoAudioElemento, nuevosMedios, blobDe, nuevosAudios, espera0,
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
function grabador({ fallaPlay = false } = {}) {
  const chrome = nuevoChrome();
  chrome.runtime.sendMessage = async (msg) => (msg.cmd === "cfg" ? { geminiKey: "K" } : { ok: true });
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

test("si Chrome no deja sonar el <audio>, la pestaña se oye por el AudioContext y con colchón grande", async () => {
  const { ctx, entorno } = grabador({ fallaPlay: true });
  await ctx.start({ modo: "tab_mic", streamId: "s1" });
  const ac = entorno.AudioContext._instancias[0];
  await hasta(() => vaAAltavoces(ac), "que la reunión se oyera por el AudioContext");
  assert.strictEqual(ac._opciones.latencyHint, "playback",
    "con el valor por defecto trabaja en bloques de ~10 ms y cualquier tirón suena");
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
