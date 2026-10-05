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
  const registro = { descargas: [], borrados: [], borradosHist: [], badges: [], colores: [], offscreen: 0, alarmas: {}, notificaciones: [], pestanasActivadas: [], ventanasEnfocadas: [], permisos: [] };
  let proximoIdDescarga = 1;
  // Permisos opcionales de host (3.8). `opciones.permisos`: los orígenes que ya
  // están concedidos (`concedidos`) y lo que contesta el usuario al diálogo de
  // Chrome (`respuesta`: true, false, o "lanza" para una petición que Chrome
  // rechaza, como la que llega fuera de un gesto). La respuesta se puede cambiar
  // a mitad de test con chrome.permissions._responde(…).
  const concedidos = new Set((opciones.permisos && opciones.permisos.concedidos) || []);
  let respuestaPermiso = opciones.permisos && "respuesta" in opciones.permisos ? opciones.permisos.respuesta : true;
  const oyentes = { mensaje: [], instalado: [], arranque: [], cambios: [], alarma: [], comando: [], pestana: [], clicAviso: [] };
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
      setBadgeBackgroundColor(o) { registro.colores.push(o.color); },
    },
    commands: {
      onCommand: { addListener: (f) => oyentes.comando.push(f) },
      async getAll() { return opciones.atajos || [{ name: "grabar", shortcut: "Alt+Shift+G" }, { name: "marcar", shortcut: "Alt+Shift+M" }]; },
    },
    notifications: {
      create(id, o) { registro.notificaciones.push({ id, ...o }); return Promise.resolve(id); },
      clear(id) { registro.notificaciones = registro.notificaciones.filter((n) => n.id !== id); return Promise.resolve(true); },
      onClicked: { addListener: (f) => oyentes.clicAviso.push(f) },
    },
    windows: { async update(id, o) { registro.ventanasEnfocadas.push({ id, ...o }); return { id }; } },
    i18n: { getUILanguage: () => opciones.idiomaNavegador || "es-ES" },
    sidePanel: { async setPanelBehavior() {}, async open() {} },
    offscreen: {
      async hasDocument() { return registro.offscreen > 0; },
      async createDocument() { registro.offscreen++; },
    },
    tabs: {
      async query() { return []; },
      async update(id, o) { registro.pestanasActivadas.push({ id, ...o }); return { id, windowId: 7 }; },
      onUpdated: { addListener: (f) => oyentes.pestana.push(f) },
    },
    tabCapture: { async getMediaStreamId() { return "stream-de-prueba"; } },
    // Cada petición y cada retirada quedan apuntadas en `_registro.permisos`, en
    // orden y EN EL MOMENTO de la llamada (antes de ceder el turno): así un test
    // ve si el permiso se pidió antes de cualquier otro `await`, que es lo que
    // exige Chrome para darlo por hecho dentro del gesto del usuario.
    permissions: {
      _concedidos: concedidos,
      _responde(r) { respuestaPermiso = r; },
      async request(p) {
        registro.permisos.push({ pide: [...((p && p.origins) || [])] });
        await espera0();
        if (respuestaPermiso === "lanza") throw new Error("This function must be called during a user gesture");
        if (respuestaPermiso) for (const o of p.origins || []) concedidos.add(o);
        return !!respuestaPermiso;
      },
      async contains(p) {
        await espera0();
        return ((p && p.origins) || []).every((o) => concedidos.has(o));
      },
      async remove(p) {
        registro.permisos.push({ retira: [...((p && p.origins) || [])] });
        await espera0();
        for (const o of p.origins || []) concedidos.delete(o);
        return true;
      },
    },
  };
  return chrome;
}

// --- respuestas HTTP programables ------------------------------------------
// Lo que ve la extensión a partir de lo que programa el test: { status, cuerpo,
// cabeceras }. Sin `status` es un 200; las cabeceras se leen sin distinguir
// mayúsculas, como en una respuesta de verdad.
function respuestaHttp(r) {
  const cuerpo = typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo ?? {});
  const status = r.status === undefined ? 200 : r.status;
  const cabeceras = Object.fromEntries(Object.entries(r.cabeceras || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (nombre) => { const k = String(nombre).toLowerCase(); return k in cabeceras ? cabeceras[k] : null; } },
    async text() { return cuerpo; },
    async json() { return JSON.parse(cuerpo); },
  };
}

// Cada test encola las respuestas que quiere que dé la red, en orden.
function nuevoFetch(respuestas) {
  const llamadas = [];
  const cola = respuestas.slice();
  const fn = async (url, opts = {}) => {
    llamadas.push({ url: String(url), metodo: opts.method || "GET", opts });
    const r = cola.shift();
    if (!r) throw new Error("fetch inesperado (cola vacía): " + url);
    if (r.lanza) throw new Error(r.lanza);
    return respuestaHttp(r);
  };
  fn._llamadas = llamadas;
  fn._pendientes = () => cola.length;
  return fn;
}

// Respuestas repartidas por destino, para cuando hay más de un proveedor en
// juego: { "api.groq.com": [r1, r2…], "api.mistral.ai/v1/audio": […] }. Cada
// petición gasta una respuesta de la primera clave del mapa que aparezca en su
// URL. Lo que no esté en el mapa, o se acabe, hace fallar el test.
function fetchPorUrl(mapa) {
  const colas = Object.entries(mapa).map(([trozo, rs]) => [trozo, rs.slice()]);
  const llamadas = [];
  const fn = async (url, opts = {}) => {
    llamadas.push({ url: String(url), metodo: opts.method || "GET", opts });
    const cola = (colas.find(([trozo]) => String(url).includes(trozo)) || [])[1];
    const r = cola && cola.shift();
    if (!r) throw new Error("fetch inesperado: " + url);
    if (r.lanza) throw new Error(r.lanza);
    return respuestaHttp(r);
  };
  fn._llamadas = llamadas;
  fn._pendientes = () => colas.reduce((n, [, cola]) => n + cola.length, 0);
  return fn;
}

// Respuesta de Gemini con un texto dado, en el formato que espera el parser.
const respGemini = (texto, finishReason = "STOP") =>
  ({ cuerpo: { candidates: [{ finishReason, content: { parts: [{ text: texto }] } }] } });

// --- APIs de audio ----------------------------------------------------------
// decodeAudioData devuelve las muestras que el test le haya puesto al blob:
// así se controla exactamente qué audio "oye" el medidor. Cada contexto queda
// en `_instancias` con sus opciones y sus fuentes, para ver qué se conectó a
// los altavoces (`destination`).
// Con `fallaModulo`, el AudioWorklet no carga (un Chrome que no deja usar el
// altavoz con colchón).
function nuevoAudioContext({ fallaModulo = false } = {}) {
  const instancias = [];
  function AudioContext(opciones = {}) {
    const ctx = {
      _opciones: opciones,
      _fuentes: [],
      _modulos: [],
      audioWorklet: {
        async addModule(url) {
          if (fallaModulo) throw new Error("AbortError: Unable to load a worklet's module.");
          ctx._modulos.push(url);
        },
      },
      sampleRate: 16000,
      state: "running",
      async resume() { ctx.state = "running"; },
      async decodeAudioData(buffer) {
        const muestras = buffer && buffer._muestras;
        if (!muestras) throw new Error("audio no decodificable");
        return {
          sampleRate: 16000,
          length: muestras.length,
          getChannelData: () => muestras,
        };
      },
      async close() { ctx.state = "closed"; },
      createDynamicsCompressor: () => ({
        ...nodo(), threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 1 }, attack: { value: 0 }, release: { value: 0 },
      }),
      createGain: () => ({ ...nodo(), gain: { value: 1 } }),
      createAnalyser: () => ({ ...nodo(), fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0); } }),
      createMediaStreamDestination: () => ({ ...nodo(), stream: { getTracks: () => [] } }),
      createMediaStreamSource: (stream) => { const n = { ...nodo(), _stream: stream }; ctx._fuentes.push(n); return n; },
      destination: nodo(),
    };
    instancias.push(ctx);
    return ctx;
  }
  AudioContext._instancias = instancias;
  return AudioContext;
}
const nodo = () => {
  const n = { _destinos: [], connect(d) { n._destinos.push(d); return d; }, disconnect() { n._destinos = []; }, channelCount: 1, channelCountMode: "max" };
  return n;
};

// <audio> de mentira. Con `falla`, play() se rechaza como cuando Chrome no deja
// reproducir sin un gesto del usuario.
function nuevoAudioElemento({ falla = false } = {}) {
  const creados = [];
  function Audio() {
    const el = {
      srcObject: null, paused: true, currentTime: 0, readyState: 4, ended: false,
      async play() {
        if (falla) throw new Error("NotAllowedError: play() failed because the user didn't interact with the document first.");
        el.paused = false;
      },
      pause() { el.paused = true; },
    };
    creados.push(el);
    return el;
  }
  Audio._creados = creados;
  return Audio;
}

// Piezas del altavoz con colchón (3.7.0): el lector de la pista, el hilo de la
// bomba y el nodo que suena. No mueven audio: apuntan lo que se les pide.
function nuevoColchon() {
  const reg = { procesadores: [], hilos: [], nodos: [] };
  function MediaStreamTrackProcessor({ track }) {
    const p = { track, readable: { _de: track } };
    reg.procesadores.push(p);
    return p;
  }
  function Worker(url) {
    const w = { url, mensajes: [], terminado: false, onmessage: null, postMessage(m) { w.mensajes.push(m); }, terminate() { w.terminado = true; } };
    reg.hilos.push(w);
    return w;
  }
  function AudioWorkletNode(ctx, nombre, opciones) {
    const n = { ...nodo(), ctx, nombre, opciones, port: { mensajes: [], onmessage: null, postMessage(m) { n.port.mensajes.push(m); } } };
    reg.nodos.push(n);
    return n;
  }
  function MessageChannel() { return { port1: { lado: 1 }, port2: { lado: 2 } }; }
  return { MediaStreamTrackProcessor, Worker, AudioWorkletNode, MessageChannel, _reg: reg };
}

// getUserMedia y MediaRecorder mínimos para arrancar y parar una grabación.
// Cada stream guarda las restricciones con que se pidió (`_c`).
// Con `conAudio`, cada tramo entrega un trozo de audio al pararse, como uno real.
// `compartir` dice qué pasa en la ventana de Chrome de «elegir qué compartir»:
// "pestana" (con sonido), "pantalla" (con el sonido del equipo), "ventana" (sin
// sonido) o "cancela".
function nuevosMedios({ conAudio = false, compartir = "pestana" } = {}) {
  const pista = (extra = {}) => {
    const oyentesPista = {};
    const p = {
      parada: false, stop() { p.parada = true; },
      getSettings: () => ({ sampleRate: 48000, ...extra }),
      clone() { const c = pista(); c._copiaDe = p; return c; },
      addEventListener(tipo, f) { (oyentesPista[tipo] = oyentesPista[tipo] || []).push(f); },
      _dispara(tipo) { (oyentesPista[tipo] || []).forEach((f) => f({ type: tipo })); },
    };
    return p;
  };
  const oyentes = {};
  const mediaDevices = {
    _compartidos: [],
    addEventListener(tipo, f) { (oyentes[tipo] = oyentes[tipo] || []).push(f); },
    _dispara(tipo) { (oyentes[tipo] || []).forEach((f) => f({ type: tipo })); },
    async getUserMedia(c) {
      const pistas = [pista()];
      return { _c: c, getTracks: () => pistas, getAudioTracks: () => pistas };
    },
    async getDisplayMedia(c) {
      if (compartir === "cancela") { const e = new Error("Permission denied by user"); e.name = "NotAllowedError"; throw e; }
      const video = [pista({ displaySurface: compartir === "pestana" ? "browser" : compartir === "pantalla" ? "monitor" : "window" })];
      const audio = compartir === "ventana" ? [] : [pista()];
      const s = { _c: c, getTracks: () => [...video, ...audio], getAudioTracks: () => audio, getVideoTracks: () => video };
      mediaDevices._compartidos.push(s);
      return s;
    },
  };
  const creados = [];
  function MediaRecorder() {
    const r = {
      state: "inactive", ondataavailable: null, onstop: null, pausas: 0,
      start() { r.state = "recording"; },
      pause() { r.state = "paused"; r.pausas++; },
      resume() { r.state = "recording"; },
      stop() {
        r.state = "inactive";
        setImmediate(() => {
          if (conAudio && r.ondataavailable) r.ondataavailable({ data: { size: 1000, type: "audio/webm" } });
          if (r.onstop) r.onstop();
        });
      },
    };
    creados.push(r);
    return r;
  }
  MediaRecorder._creados = creados;
  return { mediaDevices, MediaRecorder };
}

// Blob de mentira que transporta las muestras que debe "contener".
function blobDe(muestras, size, type = "audio/webm") {
  return {
    size: size === undefined ? 1000 : size,
    type,
    async arrayBuffer() { const b = new ArrayBuffer(8); b._muestras = muestras; return b; },
  };
}

// El constructor `Blob` que usa la extensión (lo grabado, y el WAV al que se
// convierte un tramo). Guarda de qué está hecho (`_partes`) para que el test
// pueda mirar dentro; el tamaño es el de sus trozos (los de un MediaRecorder
// simulado son { size, type }) y el tipo, el que se le pida. No se puede
// «decodificar»: lo que hay que decodificar en un test se hace con blobDe.
function nuevoBlob() {
  const tam = (p) => (p && typeof p.byteLength === "number" ? p.byteLength : p && typeof p.size === "number" ? p.size : 1);
  return function Blob(partes = [], opciones = {}) {
    return {
      _partes: partes,
      size: partes.reduce((n, p) => n + tam(p), 0),
      type: opciones.type || "",
      async arrayBuffer() { return new ArrayBuffer(8); },
    };
  };
}

// FormData de mentira: los campos, en el orden en que se añaden, como
// [nombre, valor] o, si es un fichero, [nombre, blob, nombreDelFichero]. Lo que
// no es un fichero se guarda como texto, igual que hace el de verdad.
function nuevoFormData() {
  return function FormData() {
    const campos = [];
    return {
      _campos: campos,
      append(nombre, valor, fichero) {
        campos.push(valor && typeof valor === "object"
          ? [String(nombre), valor, fichero === undefined ? "blob" : String(fichero)]
          : [String(nombre), String(valor)]);
      },
      get(nombre) { const c = campos.find(([n]) => n === nombre); return c ? c[1] : null; },
      getAll(nombre) { return campos.filter(([n]) => n === nombre).map((c) => c[1]); },
      has(nombre) { return campos.some(([n]) => n === nombre); },
    };
  };
}

// Almacén de audio en memoria con la misma interfaz que abrirAudios(indexedDB)
// de comun.js. `fallaLectura` simula un IndexedDB que no responde.
function nuevosAudios(inicial = []) {
  const datos = new Map(inicial.map(([reunion, idx, blob]) => [reunion + ":" + idx, { reunion, idx, blob }]));
  const escucha = new Map();
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
    // Audio que se conserva para escucharlo en la biblioteca (3.4).
    _escucha: escucha,
    async guardarEscucha(reunion, idx, blob) { await espera0(); escucha.set(reunion + ":" + idx, { reunion, idx, blob }); },
    async leerEscucha(reunion, idx) { await espera0(); const r = escucha.get(reunion + ":" + idx); return r ? r.blob : null; },
    async borrarEscucha(reunion) { await espera0(); for (const [k, v] of escucha) if (v.reunion === reunion) escucha.delete(k); },
    async clavesEscucha() { await espera0(); return [...escucha.values()].map((v) => [v.reunion, v.idx]); },
  };
}

module.exports = {
  almacen, nuevoChrome, nuevoFetch, fetchPorUrl, respuestaHttp, respGemini, nuevoAudioContext, nuevoAudioElemento, nuevoColchon, nuevosMedios, blobDe, nuevoBlob, nuevoFormData,
  nuevosAudios, espera0,
};
