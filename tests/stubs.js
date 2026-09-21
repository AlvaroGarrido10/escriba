// Navegador simulado para los tests: implementa la parte de las APIs de Chrome
// y del DOM que usa la extensión, y solo esa parte.
//
// Los almacenes son asíncronos de verdad (ceden el turno con setImmediate). Es
// lo que hace que las carreras de escritura se reproduzcan: con un stub
// síncrono, el fallo de "lost update" no aparece nunca.

"use strict";

const espera0 = () => new Promise((r) => setImmediate(r));

// `avisar(cambios)` imita chrome.storage.onChanged: se llama tras cada set.
function almacen(inicial = {}, avisar = () => {}) {
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
      const cambios = {};
      for (const [k, v] of Object.entries(o)) {
        if (JSON.stringify(datos[k]) !== JSON.stringify(v)) cambios[k] = { oldValue: datos[k], newValue: v };
      }
      datos = { ...datos, ...o };
      if (Object.keys(cambios).length) avisar(cambios);
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
  const registro = { descargas: [], borrados: [], borradosHist: [], badges: [], offscreen: 0, alarmas: {} };
  let proximoIdDescarga = 1;
  const oyentes = { mensaje: [], instalado: [], arranque: [], cambios: [], alarma: [] };
  const avisa = (area) => (cambios) => oyentes.cambios.forEach((f) => f(cambios, area));

  const chrome = {
    _registro: registro,
    _oyentes: oyentes,
    storage: {
      local: almacen(opciones.local || {}, avisa("local")),
      sync: almacen(opciones.sync || {}, avisa("sync")),
      session: almacen(opciones.session || {}, avisa("session")),
      onChanged: { addListener: (f) => oyentes.cambios.push(f) },
    },
    alarms: {
      async create(nombre, o) { registro.alarmas[nombre] = o; },
      async clear(nombre) { const habia = nombre in registro.alarmas; delete registro.alarmas[nombre]; return habia; },
      onAlarm: { addListener: (f) => oyentes.alarma.push(f) },
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

// Almacén de audio en memoria con la misma interfaz que abrirAudios(indexedDB)
// de comun.js. `fallaLectura` simula un IndexedDB que no responde.
function nuevosAudios(inicial = []) {
  const datos = new Map(inicial.map(([reunion, idx, blob]) => [reunion + ":" + idx, { reunion, idx, blob }]));
  return {
    _datos: datos,
    fallaLectura: false,
    async guardar(reunion, idx, blob) { await espera0(); datos.set(reunion + ":" + idx, { reunion, idx, blob }); },
    async leer(reunion, idx) {
      await espera0();
      if (this.fallaLectura) throw new Error("IndexedDB no responde");
      const r = datos.get(reunion + ":" + idx);
      return r ? r.blob : null;
    },
    async borrar(reunion, idx) { await espera0(); datos.delete(reunion + ":" + idx); },
    async borrarReunion(reunion) {
      await espera0();
      for (const [k, v] of datos) if (v.reunion === reunion) datos.delete(k);
    },
    async claves() { await espera0(); return [...datos.values()].map((v) => [v.reunion, v.idx]); },
  };
}

module.exports = { almacen, nuevoChrome, nuevoFetch, respGemini, nuevoAudioContext, blobDe, nuevosAudios, espera0 };
