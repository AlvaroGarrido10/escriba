// Escriba — piezas compartidas por el service worker, el documento offscreen,
// el popup y la página de importar. Se carga como script clásico en todos (y
// con importScripts en el service worker); en Node (tests) se exporta.
//
// POR QUÉ EXISTE: hasta la 3.0 el audio de una reunión solo vivía en la memoria
// del documento que graba. Si la transcripción fallaba, lo único que quedaba era
// una copia en Descargas que la extensión ya no podía volver a leer, así que no
// había forma de reintentar. Ahora cada tramo se guarda en IndexedDB en cuanto
// se graba y solo se borra cuando su texto ya está a salvo en el historial.

// t() la define i18n.js, que se carga antes en las páginas y en el service
// worker. En Node (tests) se trae con require.
if (typeof t !== "function" && typeof require === "function") var t = require("./i18n.js").t;
if (typeof LOCALE_UI !== "function" && typeof require === "function") var LOCALE_UI = require("./i18n.js").LOCALE_UI;

const DURACION_TRAMO_S = 5 * 60; // cada tramo que se manda al modelo
// Por debajo de este pico un tramo es silencio digital. NO se manda al modelo:
// Gemini, ante silencio, se inventa una reunión entera de cero.
const PICO_SILENCIO = 0.005;
const UMBRAL_VOZ = 0.008; // rms por encima del cual una ventana cuenta como voz

// --- audio pendiente (IndexedDB) ---------------------------------------------
// Un registro por tramo, con clave compuesta [reunión, índice]. IndexedDB es del
// ORIGEN de la extensión: el service worker, el offscreen y las páginas ven la
// misma base, así que cualquiera puede guardar, leer o borrar.
function abrirAudios(idb) {
  let promesaDb = null;
  const db = () => promesaDb || (promesaDb = new Promise((ok, ko) => {
    // v2 (3.4): «escucha» guarda el audio YA transcrito que el usuario quiere
    // poder escuchar. Va aparte de «audios» (lo pendiente de transcribir), que
    // se vacía en cuanto hay texto y lo limpia el arranque.
    const r = idb.open("escriba", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("audios")) d.createObjectStore("audios", { keyPath: ["reunion", "idx"] });
      if (!d.objectStoreNames.contains("escucha")) d.createObjectStore("escucha", { keyPath: ["reunion", "idx"] });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => { d.close(); promesaDb = null; };
      ok(d);
    };
    r.onerror = () => { promesaDb = null; ko(r.error); };
  }));
  // Una escritura solo cuenta cuando su transacción se ha confirmado: el
  // `onsuccess` de la petición llega antes y todavía puede abortar por cuota.
  const confirmada = (t) => new Promise((ok, ko) => {
    t.oncomplete = () => ok();
    t.onerror = () => ko(t.error);
    t.onabort = () => ko(t.error || new Error("Transacción de IndexedDB abortada"));
  });
  const resultado = (r) => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  const rango = (reunion) => IDBKeyRange.bound([reunion, 0], [reunion, Infinity]);

  return {
    async guardar(reunion, idx, blob) {
      const t = (await db()).transaction("audios", "readwrite");
      t.objectStore("audios").put({ reunion, idx, blob, guardado: Date.now() });
      await confirmada(t);
    },
    async leer(reunion, idx) {
      const t = (await db()).transaction("audios", "readonly");
      const r = await resultado(t.objectStore("audios").get([reunion, idx]));
      return r ? r.blob : null;
    },
    async borrar(reunion, idx) {
      const t = (await db()).transaction("audios", "readwrite");
      t.objectStore("audios").delete([reunion, idx]);
      await confirmada(t);
    },
    async borrarReunion(reunion) {
      const t = (await db()).transaction("audios", "readwrite");
      t.objectStore("audios").delete(rango(reunion));
      await confirmada(t);
    },
    // Solo las claves: no carga los blobs en memoria.
    async claves() {
      const t = (await db()).transaction("audios", "readonly");
      return (await resultado(t.objectStore("audios").getAllKeys())) || [];
    },
    // --- audio conservado para escuchar ---
    async guardarEscucha(reunion, idx, blob) {
      const t = (await db()).transaction("escucha", "readwrite");
      t.objectStore("escucha").put({ reunion, idx, blob, guardado: Date.now() });
      await confirmada(t);
    },
    async leerEscucha(reunion, idx) {
      const t = (await db()).transaction("escucha", "readonly");
      const r = await resultado(t.objectStore("escucha").get([reunion, idx]));
      return r ? r.blob : null;
    },
    async borrarEscucha(reunion) {
      const t = (await db()).transaction("escucha", "readwrite");
      t.objectStore("escucha").delete(rango(reunion));
      await confirmada(t);
    },
    async clavesEscucha() {
      const t = (await db()).transaction("escucha", "readonly");
      return (await resultado(t.objectStore("escucha").getAllKeys())) || [];
    },
  };
}
// `var` y no `const`: los tests lo sustituyen por un almacén en memoria.
var audios = typeof indexedDB !== "undefined" ? abrirAudios(indexedDB) : null;

// --- errores de transcripción --------------------------------------------------
// Cada fallo lleva un código. Con él se decide cuándo reintentar y se le dice al
// usuario qué ha pasado de verdad: la 3.0 decía «falta la clave» también cuando
// lo que había fallado era la comunicación interna de la extensión.
// Con getters: el texto sale en el idioma vigente al leerlo, no en el de la carga.
const MENSAJES_ERROR = {
  get sin_clave() { return t("com.errSinClave"); },
  get clave_invalida() { return t("com.errClaveInvalida"); },
  get saturado() { return t("com.errSaturado"); },
  get red() { return t("com.errRed"); },
  get interno() { return t("com.errInterno"); },
  get otro() { return t("com.errOtro"); },
  get perdido() { return t("com.errPerdido"); },
};
// Estos no se arreglan esperando: hace falta que el usuario cambie la clave.
const CODIGOS_CLAVE = ["sin_clave", "clave_invalida"];
const textoError = (codigo) => MENSAJES_ERROR[codigo] || MENSAJES_ERROR.otro;

// --- estado de una reunión a partir de sus tramos -----------------------------
// Estados de tramo: pendiente | ok | mudo | perdido.
function resumenTramos(tramos) {
  const r = { total: 0, ok: 0, mudos: 0, pendientes: 0, perdidos: 0 };
  for (const t of tramos || []) {
    r.total++;
    if (t.estado === "ok") r.ok++;
    else if (t.estado === "mudo") r.mudos++;
    else if (t.estado === "perdido") r.perdidos++;
    else r.pendientes++;
  }
  return r;
}

// Estado de la reunión cuando no hay ninguna ronda de transcripción en marcha.
function estadoFinal(tramos) {
  const r = resumenTramos(tramos);
  if (r.pendientes) return "pendiente";
  return r.ok ? "ok" : "error";
}

const etiquetaTramo = (i) => {
  const min = DURACION_TRAMO_S / 60;
  return t("com.etiquetaTramo", i * min, (i + 1) * min);
};

// --- marcas de tiempo (3.2) ------------------------------------------------------
// El modelo marca cada intervención con [MM:SS] contados desde el principio de
// SU tramo. Aquí se pasan a tiempo de la reunión sumando dónde empieza el tramo.
const pad2 = (n) => String(n).padStart(2, "0");
function formatoTiempo(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), seg = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(seg)}` : `${pad2(m)}:${pad2(seg)}`;
}
const RE_MARCA = /^(\s*)\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;
const segundosDe = (m) => (m[4] !== undefined ? (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) : (+m[2]) * 60 + (+m[3]));

function ajustarTiempos(texto, inicioS) {
  return String(texto || "").split("\n").map((l) => {
    const m = RE_MARCA.exec(l);
    return m ? `${m[1]}[${formatoTiempo(segundosDe(m) + (inicioS || 0))}]` + l.slice(m[0].length) : l;
  }).join("\n");
}

// Dónde empieza un tramo dentro de la reunión. Las entradas anteriores a la 3.2
// no lo guardaban: todos sus tramos medían lo mismo.
const inicioTramo = (t, i) => (t && typeof t.inicioS === "number" ? t.inicioS : i * DURACION_TRAMO_S);

// --- hablantes (3.2) --------------------------------------------------------------
// Una línea de transcripción es «[MM:SS] Nombre: texto» (la marca es opcional).
// La etiqueta empieza por mayúscula y no lleva «:» ni corchetes: así «[inaudible]»
// o una frase suelta no se toman por un hablante.
const RE_LINEA = /^(\s*(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*)?)([A-ZÁÉÍÓÚÜÑ][^:\n[\]]{0,39}?):\s?(.*)$/;

function lineasTranscripcion(texto) {
  return String(texto || "").split("\n").filter((l) => l.trim()).map((l) => {
    const m = RE_LINEA.exec(l);
    if (m) {
      const t = m[2] !== undefined ? segundosDe([null, null, m[2], m[3], m[4]]) : null;
      return { t, hablante: m[5].trim(), texto: m[6].trim() };
    }
    const soloMarca = RE_MARCA.exec(l);
    if (soloMarca) return { t: segundosDe(soloMarca), hablante: "", texto: l.slice(soloMarca[0].length).trim() };
    return { t: null, hablante: "", texto: l.trim() };
  });
}

function hablantesDe(texto) {
  const vistos = [];
  for (const l of lineasTranscripcion(texto)) if (l.hablante && !vistos.includes(l.hablante)) vistos.push(l.hablante);
  return vistos;
}

// Cambia la ETIQUETA de inicio de línea («Hablante 1:» → «Marcos:»). El texto
// original no se toca: el mapa se guarda aparte y se aplica al ver y al exportar,
// así que un nombre mal puesto se corrige sin perder nada.
function aplicarHablantes(texto, mapa) {
  const nombres = mapa || {};
  if (!Object.values(nombres).some((v) => v && String(v).trim())) return String(texto || "");
  return String(texto || "").split("\n").map((l) => {
    const m = RE_LINEA.exec(l);
    if (!m) return l;
    const nuevo = nombres[m[5].trim()];
    return nuevo && String(nuevo).trim() ? `${m[1]}${String(nuevo).trim()}: ${m[6]}` : l;
  }).join("\n");
}

// Etiquetas genéricas en el idioma de la interfaz: «Hablante 2» ↔ «Speaker 2».
// Las pone el modelo según el idioma que había al transcribir, así que una
// reunión vieja puede traer las del otro idioma. Van DEBAJO de los nombres que
// haya puesto el usuario, y solo al mostrar y exportar: el texto no se toca.
const RE_GENERICA = /^(?:Hablante|Speaker)\s+(\d+)$/i;
function etiquetaGenerica(n) { return t("com.hablanteN", n); }
function mapaVisible(texto, mapa) {
  const out = {};
  for (const h of hablantesDe(texto)) {
    const m = RE_GENERICA.exec(h);
    if (m && etiquetaGenerica(m[1]) !== h) out[h] = etiquetaGenerica(m[1]);
  }
  for (const [k, v] of Object.entries(mapa || {})) if (v && String(v).trim()) out[k] = String(v).trim();
  return out;
}

// El .md se rehace entero desde el historial cada vez que cambia algo, así que
// un reintento que completa un hueco deja un documento limpio, sin avisos viejos.
function construirMarkdown(h) {
  const tramos = h.tramos || [];
  const r = resumenTramos(tramos);
  const m = h.meta || {};
  let md = `# ${t("com.mdTitulo", fechaVisible(h))}\n\n`;
  if (h.titulo) md += `**${t("com.mdOrigen")}:** ${h.titulo}\n`;
  if (h.participantes) md += `**${t("com.mdParticipantes")}:** ${h.participantes}\n`;
  const minYTramos = tramos.length === 1 ? t("com.mdMinTramo", m.minutos || 1, tramos.length)
    : t("com.mdMinTramos", m.minutos || 1, tramos.length);
  md += `**${t("com.mdDuracion")}:** ${minYTramos}\n`;
  if (m.audioLinea) md += `**${t("com.mdAudio")}:** ${m.audioLinea}\n`;
  md += m.audioAlerta || "";
  if (m.interrumpida) md += `\n> ⚠️ ${t("com.mdCortada")}\n`;
  if (r.pendientes) {
    const cuantos = tramos.length === 1 ? t("com.mdPendUnico")
      : r.pendientes === 1 ? t("com.mdPendUno", r.pendientes, tramos.length)
        : t("com.mdPendVarios", r.pendientes, tramos.length);
    md += `\n> ⏳ ${cuantos} ${t("com.mdPendTxt")}\n`;
  }
  if (r.perdidos) md += `\n> ⚠️ ${t("com.mdPerdidos", r.perdidos, tramos.length)}\n`;
  if (r.mudos) md += `\n> ℹ️ ${t("com.mdMudos", r.mudos, tramos.length)}\n`;
  if (h.notas && String(h.notas).trim()) md += `\n## ${t("com.mdNotas")}\n\n${String(h.notas).trim()}\n`;
  if (Array.isArray(h.marcas) && h.marcas.length) {
    md += `\n## ${t("com.mdMarcas")}\n\n` +
      h.marcas.map((x) => `- [${formatoTiempo(x.t)}]${x.nota ? " " + x.nota : ""}`).join("\n") + "\n";
  }

  // `tr` y no `t`: `t` es la función de los textos (i18n.js).
  const cuerpo = tramos.map((tr, i) => {
    const cab = t("com.mdCabTramo", i + 1, tramos.length, tr.etiqueta || etiquetaTramo(i));
    if (tr.estado === "ok") {
      return aplicarHablantes(tr.texto || "", mapaVisible(tr.texto || "", h.hablantes)) +
        (tr.truncado ? `\n\n> ⚠️ ${t("com.mdTruncado")}` : "");
    }
    if (tr.estado === "mudo") return `> _(${t("com.mdTramoMudo", cab)})_`;
    if (tr.estado === "perdido") return `> ⚠️ ${t("com.mdTramoPerdido", cab)}\n> ${textoError("perdido")}`;
    return `> ⏳ ${t("com.mdTramoPendiente", cab)}\n> ${tr.error || textoError(tr.codigo)}` +
      (tr.dlAudio ? `\n> ${t("com.mdCopiaDescargas")}` : "");
  }).join("\n\n");
  return md + `\n---\n\n${cuerpo}\n`;
}

// --- audio: medida y troceado --------------------------------------------------
// Pico y fracción con voz, en ventanas de 20 ms sobre TODAS las muestras. Es la
// única medida fiable para decidir que un tramo es silencio (ver offscreen.js).
function medirMuestras(datos, sampleRate, umbralVoz) {
  const ventana = Math.max(1, Math.round(sampleRate * 0.02));
  let pico = 0, conVoz = 0, ventanas = 0;
  for (let i = 0; i < datos.length; i += ventana) {
    const fin = Math.min(i + ventana, datos.length);
    let s = 0;
    for (let j = i; j < fin; j++) s += datos[j] * datos[j];
    const rms = Math.sqrt(s / (fin - i));
    if (rms > pico) pico = rms;
    if (rms > umbralVoz) conVoz++;
    ventanas++;
  }
  return { pico, voz: ventanas ? conVoz / ventanas : 0 };
}

// Cortes [desde, hasta) de `porTramo` muestras. Un resto de menos de `minimo`
// se pega al tramo anterior: mandar 10 s sueltos al modelo solo invita a que
// alucine sin contexto.
function trocear(n, porTramo, minimo) {
  const cortes = [];
  for (let i = 0; i < n; i += porTramo) cortes.push([i, Math.min(n, i + porTramo)]);
  if (cortes.length > 1) {
    const ult = cortes[cortes.length - 1];
    if (ult[1] - ult[0] < minimo) { cortes.pop(); cortes[cortes.length - 1][1] = ult[1]; }
  }
  return cortes;
}

// Tramos de uno o varios archivos importados. Varios archivos son partes
// seguidas de una misma reunión: cada uno se trocea por su cuenta y la
// etiqueta dice de cuál viene cada tramo.
function planificarTramos(archivos) {
  const plan = [];
  for (const a of archivos) {
    const sr = a.sampleRate;
    for (const [desde, hasta] of trocear(a.longitud, DURACION_TRAMO_S * sr, 30 * sr)) {
      const min = (x) => Math.round(x / sr / 60);
      plan.push({
        archivo: a.nombre, desde, hasta,
        etiqueta: (archivos.length > 1 ? a.nombre + ", " : "") + t("com.etiquetaArchivo", min(desde), Math.max(1, min(hasta))),
      });
    }
  }
  return plan;
}

// WAV PCM 16 bits mono. Es el formato que cualquier modelo acepta y no hace
// falta ningún codificador: la página de importar lo genera sin librerías.
function codificarWav(muestras, sampleRate) {
  const n = muestras.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const txt = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); txt(8, "WAVE");
  txt(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  txt(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, muestras[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function fechaBonita(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return {
    legible: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`,
    fichero: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

// La fecha de una reunión para enseñarla. En español, la que se guardó al crearla
// («01/10/2026 22:11»); en inglés se rehace desde el id, que es su marca de
// tiempo, porque «01/10/2026» se leería como 10 de enero.
function fechaVisible(h) {
  if (LOCALE_UI() === "en-US" && typeof h.id === "number" && h.id > 1e12) {
    return new Date(h.id).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return h.fecha || "";
}

// --- coste estimado (3.5) ---
// Con los precios que pone el usuario en Opciones, en € por millón de tokens:
// { gemini: { audio, entrada, salida }, gpt: { entrada, salida }, claude: { entrada, salida } }.
// Escriba no se inventa precios: cambian cada pocos meses y dependen del plan de
// cada clave. Un precio vacío es «sin precio» (null); un 0 es la capa gratuita.
function precioValido(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}

// Transcribir es audio de Gemini; las actas y preguntas, texto del proveedor que
// las hizo (va en la clave: «acta·gpt», «pregunta·claude», o «gemini» a secas en
// las de la 3.1). Devuelve { euros (null si no se puede saber), faltan, tokens }.
function costeReunion(h, precios) {
  const p = precios || {};
  let euros = 0, conPrecio = false, tokens = 0;
  const faltan = new Set();
  const suma = (prov, tipoEntrada, entrada, salida) => {
    tokens += entrada + salida;
    for (const [n, tipo] of [[entrada, tipoEntrada], [salida, "salida"]]) {
      if (!n) continue;
      const precio = precioValido((p[prov] || {})[tipo]);
      if (precio === null) faltan.add(prov);
      else { euros += (n * precio) / 1e6; conPrecio = true; }
    }
  };
  for (const t of (h && h.tramos) || []) {
    if (t && t.uso) suma("gemini", "audio", t.uso.entrada || 0, t.uso.salida || 0);
  }
  for (const u of (h && h.usoIA) || []) suma(String(u.clave || "").split("·").pop(), "entrada", u.entrada || 0, u.salida || 0);
  return { euros: tokens && conPrecio ? euros : null, faltan: [...faltan], tokens };
}

// Lo gastado en el mes natural de `ahora` (por defecto, el actual).
function costeMes(historial, precios, ahora) {
  const ref = new Date(ahora || Date.now());
  let euros = 0, reuniones = 0;
  const faltan = new Set();
  for (const h of historial || []) {
    const d = new Date(h.id);
    if (d.getFullYear() !== ref.getFullYear() || d.getMonth() !== ref.getMonth()) continue;
    const c = costeReunion(h, precios);
    if (c.euros === null) continue;
    euros += c.euros;
    reuniones++;
    c.faltan.forEach((f) => faltan.add(f));
  }
  return { euros: reuniones ? euros : null, reuniones, faltan: [...faltan] };
}

// --- aviso al entrar en una reunión (3.5) ---
// Solo salas de reunión, no la portada de cada web: avisar en meet.google.com a
// secas sería ruido. Las webs tienen que estar en ORIGENES_REUNION (config.js).
const SALAS_REUNION = [
  [/^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(?:[/?#]|$)/i, "Google Meet"],
  [/^https:\/\/teams\.(?:microsoft|live)\.com\/(?:.*meetup-join|meet\/\d|.*meetingjoin)/i, "Microsoft Teams"],
  [/^https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/wc\//i, "Zoom"],
  // Un nombre que cambia con el idioma va como función: se traduce al usarlo.
  [/^https:\/\/kmeet\.infomaniak\.com\/[^/?#]+/i, () => t("com.kmeet")],
  [/^https:\/\/meet\.jit\.si\/[^/?#]+/i, "Jitsi Meet"],
];
function plataformaReunion(url) {
  const s = String(url || "");
  const hit = SALAS_REUNION.find(([re]) => re.test(s));
  return hit ? (typeof hit[1] === "function" ? hit[1]() : hit[1]) : "";
}

// Coma decimal en español, punto en inglés; el símbolo, donde toque en cada uno.
function formatoEuros(n) {
  if (n === 0) return t("com.euros", "0");
  if (n < 0.005) return t("com.menosCentimo");
  const cifra = n.toFixed(2);
  return t("com.euros", LOCALE_UI() === "en-US" ? cifra : cifra.replace(".", ","));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DURACION_TRAMO_S, PICO_SILENCIO, UMBRAL_VOZ, abrirAudios, MENSAJES_ERROR, CODIGOS_CLAVE, textoError, resumenTramos, estadoFinal,
    etiquetaTramo, construirMarkdown, medirMuestras, trocear, planificarTramos, codificarWav, fechaBonita,
    formatoTiempo, ajustarTiempos, inicioTramo, lineasTranscripcion, hablantesDe, aplicarHablantes,
    precioValido, costeReunion, costeMes, formatoEuros, plataformaReunion, fechaVisible, mapaVisible, etiquetaGenerica,
  };
}
