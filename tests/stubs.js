// Navegador simulado para los tests: implementa la parte de las APIs de Chrome
// y del DOM que usa la extensión, y solo esa parte.
//
// Los almacenes son asíncronos de verdad (ceden el turno con setImmediate). Es
// lo que hace que las carreras de escritura se reproduzcan: con un stub
// síncrono, el fallo de "lost update" no aparece nunca.

"use strict";

const espera0 = () => new Promise((r) => setImmediate(r));

function almacen(inicial = {}) {
  let datos = { ...inicial };
  return {
    _volcado: () => ({ ...datos }),
    _poner: (o) => { datos = { ...datos, ...o }; },
    async get(peticion) {
      await espera0();
      if (peticion === null || peticion === undefined) return { ...datos };
      if (typeof peticion === "string") return { [peticion]: datos[peticion] };
      if (Array.isArray(peticion)) {
        const r = {};
        for (const k of peticion) if (k in datos) r[k] = datos[k];
        return r;
      }
      // Objeto de valores por defecto: lo guardado gana.
      const r = {};
      for (const [k, v] of Object.entries(peticion)) r[k] = k in datos ? datos[k] : v;
      return r;
    },
    async set(o) {
      await espera0();
      datos = { ...datos, ...o };
    },
    async remove(claves) {
      await espera0();
      for (const k of [].concat(claves)) delete datos[k];
    },
    async clear() { await espera0(); datos = {}; },
  };
}

// Registro de lo que la extensión le ha pedido al navegador, para poder
// afirmar sobre efectos que no dejan rastro en el almacenamiento.
function nuevoChrome(opciones = {}) {
  const registro = { descargas: [], borrados: [], borradosHist: [], badges: [], offscreen: 0 };
  let proximoIdDescarga = 1;
  const oyentes = { mensaje: [], instalado: [], arranque: [] };

  const chrome = {
    _registro: registro,
    _oyentes: oyentes,
    storage: {
      local: almacen(opciones.local || {}),
      sync: almacen(opciones.sync || {}),
      session: almacen(opciones.session || {}),
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: (f) => oyentes.mensaje.push(f) },
      onInstalled: { addListener: (f) => oyentes.instalado.push(f) },
      onStartup: { addListener: (f) => oyentes.arranque.push(f) },
      openOptionsPage() {},
      // Lo sustituyen los tests que necesiten hablar con "bg" o "offscreen".
      sendMessage: async () => ({ ok: true }),
    },
    downloads: {
      async download(opts, cb) {
        const id = proximoIdDescarga++;
        registro.descargas.push({ id, ...opts });
        if (cb) cb(id);
        return id;
      },
      async removeFile(id) { registro.borrados.push(id); },
      async erase(q) { registro.borradosHist.push(q.id); },
    },
    action: {
      setBadgeText(o) { registro.badges.push(o.text); },
      setBadgeBackgroundColor() {},
    },
    offscreen: {
      async hasDocument() { return registro.offscreen > 0; },
      async createDocument() { registro.offscreen++; },
    },
    tabs: { async query() { return []; } },
    tabCapture: { async getMediaStreamId() { return "stream-de-prueba"; } },
    desktopCapture: { chooseDesktopMedia(_t, _tab, cb) { cb("stream-de-prueba", { canRequestAudioTrack: true }); } },
  };
  return chrome;
}

// --- respuestas HTTP programables ------------------------------------------
// Cada test encola las respuestas que quiere que dé la red, en orden.
function nuevoFetch(respuestas) {
  const llamadas = [];
  const cola = respuestas.slice();
  const fn = async (url, opts = {}) => {
    llamadas.push({ url: String(url), metodo: opts.method || "GET", opts });
    const r = cola.shift();
    if (!r) throw new Error("fetch inesperado (cola vacía): " + url);
    if (r.lanza) throw new Error(r.lanza);
    const cuerpo = typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo ?? {});
    return {
      ok: r.status === undefined ? true : r.status >= 200 && r.status < 300,
      status: r.status === undefined ? 200 : r.status,
      async text() { return cuerpo; },
      async json() { return JSON.parse(cuerpo); },
    };
  };
  fn._llamadas = llamadas;
  fn._pendientes = () => cola.length;
  return fn;
}

// Respuesta de Gemini con un texto dado, en el formato que espera el parser.
const respGemini = (texto, finishReason = "STOP") =>
  ({ cuerpo: { candidates: [{ finishReason, content: { parts: [{ text: texto }] } }] } });

// --- APIs de audio ----------------------------------------------------------
// decodeAudioData devuelve las muestras que el test le haya puesto al blob:
// así se controla exactamente qué audio "oye" el medidor.
function nuevoAudioContext() {
  return function AudioContext() {
    return {
      sampleRate: 16000,
      async decodeAudioData(buffer) {
        const muestras = buffer && buffer._muestras;
        if (!muestras) throw new Error("audio no decodificable");
        return {
          sampleRate: 16000,
          length: muestras.length,
          getChannelData: () => muestras,
        };
      },
      async close() {},
      createDynamicsCompressor: () => nodo(),
      createGain: () => ({ ...nodo(), gain: { value: 1 } }),
      createAnalyser: () => ({ ...nodo(), fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0); } }),
      createMediaStreamDestination: () => ({ ...nodo(), stream: { getTracks: () => [] } }),
      createMediaStreamSource: () => nodo(),
      destination: nodo(),
    };
  };
}
const nodo = () => ({ connect() {}, disconnect() {}, channelCount: 1, channelCountMode: "max" });

// Blob de mentira que transporta las muestras que debe "contener".
function blobDe(muestras, size) {
  return {
    size: size === undefined ? 1000 : size,
    type: "audio/webm",
    async arrayBuffer() { const b = new ArrayBuffer(8); b._muestras = muestras; return b; },
  };
}

module.exports = { almacen, nuevoChrome, nuevoFetch, respGemini, nuevoAudioContext, blobDe, espera0 };
