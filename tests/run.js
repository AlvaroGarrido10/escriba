// Suite de Escriba. Sin dependencias: `node tests/run.js`.
//
// Cada caso carga el fichero real de la extensión en un contexto aislado con el
// navegador simulado de stubs.js. Los marcados REGRESIÓN cubren un fallo que
// llegó a estar en producción; si vuelven a ponerse en rojo, ha vuelto.

"use strict";

const assert = require("assert");
const { cargar, mensajero } = require("./load");
const { nuevoChrome, nuevoFetch, respGemini, nuevoAudioContext, blobDe, nuevosAudios, espera0 } = require("./stubs");
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
  const off = cargar(["comun.js", "offscreen.js"], entornoOffscreen(offChrome, fetchStub));
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
