// Escriba — piezas compartidas por el service worker, el documento offscreen,
// el popup y la página de importar. Se carga como script clásico en todos (y
// con importScripts en el service worker); en Node (tests) se exporta.
//
// POR QUÉ EXISTE: hasta la 3.0 el audio de una reunión solo vivía en la memoria
// del documento que graba. Si la transcripción fallaba, lo único que quedaba era
// una copia en Descargas que la extensión ya no podía volver a leer, así que no
// había forma de reintentar. Ahora cada tramo se guarda en IndexedDB en cuanto
// se graba y solo se borra cuando su texto ya está a salvo en el historial.

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
    const r = idb.open("escriba", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("audios", { keyPath: ["reunion", "idx"] });
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
  };
}
// `var` y no `const`: los tests lo sustituyen por un almacén en memoria.
var audios = typeof indexedDB !== "undefined" ? abrirAudios(indexedDB) : null;

// --- errores de transcripción --------------------------------------------------
// Cada fallo lleva un código. Con él se decide cuándo reintentar y se le dice al
// usuario qué ha pasado de verdad: la 3.0 decía «falta la clave» también cuando
// lo que había fallado era la comunicación interna de la extensión.
const MENSAJES_ERROR = {
  sin_clave: "Falta la clave de Gemini. Ponla en Opciones: en cuanto la guardes, Escriba lo reintentará sola.",
  clave_invalida: "Google rechaza la clave de Gemini (caducada, borrada o sin permisos). Pon una nueva en Opciones y Escriba lo reintentará sola.",
  saturado: "Gemini está saturado en este momento. Escriba lo reintentará sola dentro de unos minutos.",
  red: "No había conexión con Gemini. Escriba lo reintentará sola.",
  interno: "Fallo interno de Escriba al preparar la transcripción. Se reintentará sola.",
  otro: "Gemini devolvió un error inesperado. Escriba lo reintentará sola.",
  perdido: "El audio de este tramo ya no está disponible, así que no se puede transcribir.",
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
  return `≈ minuto ${i * min} al ${(i + 1) * min}`;
};

// El .md se rehace entero desde el historial cada vez que cambia algo, así que
// un reintento que completa un hueco deja un documento limpio, sin avisos viejos.
function construirMarkdown(h) {
  const tramos = h.tramos || [];
  const r = resumenTramos(tramos);
  const m = h.meta || {};
  let md = `# Transcripción de reunión — ${h.fecha}\n\n`;
  if (h.titulo) md += `**Origen:** ${h.titulo}\n`;
  md += `**Duración:** ${m.minutos || 1} min · ${tramos.length} tramo${tramos.length === 1 ? "" : "s"}\n`;
  if (m.audioLinea) md += `**Audio:** ${m.audioLinea}\n`;
  md += m.audioAlerta || "";
  if (m.interrumpida) {
    md += "\n> ⚠️ **La grabación se cortó antes de tiempo** (se cerró Chrome o se reinició la extensión). " +
      "Se ha recuperado lo grabado hasta ese momento; puede faltar el último medio minuto.\n";
  }
  if (r.pendientes) {
    const cuantos = tramos.length === 1 ? "El audio sigue" : `${r.pendientes} de ${tramos.length} tramos ${r.pendientes === 1 ? "sigue" : "siguen"}`;
    md += `\n> ⏳ **${cuantos} sin transcribir.** ` +
      "Su audio está a salvo dentro de Escriba: se reintentará sola, y también puedes pulsar «Reintentar» en el historial.\n";
  }
  if (r.perdidos) md += `\n> ⚠️ **${r.perdidos} de ${tramos.length} tramos no se pueden recuperar:** su audio ya no está disponible.\n`;
  if (r.mudos) md += `\n> ℹ️ **${r.mudos} de ${tramos.length} tramos venían sin voz** y se han dejado en blanco a propósito.\n`;

  const cuerpo = tramos.map((t, i) => {
    const cab = `Tramo ${i + 1} de ${tramos.length} (${t.etiqueta || etiquetaTramo(i)})`;
    if (t.estado === "ok") {
      return (t.texto || "") + (t.truncado ? "\n\n> ⚠️ Este tramo se cortó por límite de longitud del modelo." : "");
    }
    if (t.estado === "mudo") return `> _(${cab}: sin voz — no se transcribe para no inventar texto.)_`;
    if (t.estado === "perdido") return `> ⚠️ **${cab}: no se puede transcribir.**\n> ${textoError("perdido")}`;
    return `> ⏳ **${cab}: pendiente de transcribir.**\n> ${t.error || textoError(t.codigo)}` +
      (t.dlAudio ? "\n> Hay además una copia de su audio en Descargas/reuniones." : "");
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
        etiqueta: (archivos.length > 1 ? a.nombre + ", " : "") + `minuto ${min(desde)} al ${Math.max(1, min(hasta))}`,
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DURACION_TRAMO_S, PICO_SILENCIO, UMBRAL_VOZ, abrirAudios, MENSAJES_ERROR, CODIGOS_CLAVE, textoError, resumenTramos, estadoFinal,
    etiquetaTramo, construirMarkdown, medirMuestras, trocear, planificarTramos, codificarWav, fechaBonita,
  };
}
