// Escriba — acceso a la configuración, compartido por popup, opciones y el
// service worker (que lo carga con importScripts).
//
// POR QUÉ ESTÁ SEPARADO: las claves de API NO pueden vivir en chrome.storage.sync.
// `sync` replica su contenido a la cuenta de Google del usuario y lo reparte a
// todos sus Chrome; una clave de API no debe viajar a ningún sitio. Van en
// `storage.local`, que no sale del equipo. Lo que sí es cómodo sincronizar
// (glosario y retención) se queda en `sync`.
//
// `sync` tiene además un tope de 8 KB por elemento, así que un glosario largo
// también se guarda en local.

// Secretos y elección de modelo: SOLO local.
const CFG_LOCAL = {
  geminiKey: "", geminiModel: "",
  openaiKey: "", openaiModel: "gpt-4o",
  claudeKey: "", claudeModel: "claude-sonnet-5",
  glosario: "",
  plantillaPersonalizada: "", // puede ser larga: sync tiene un tope de 8 KB por elemento
};
// Preferencias sin datos sensibles: se sincronizan entre equipos.
const CFG_SYNC = {
  limite: 10,
  idioma: "es",                // "auto" o un código: es, en, ca, pt, fr, de, it
  autoActa: false,             // generar el acta sola al terminar la transcripción
  autoActaProv: "gemini",
  autoActaPlantilla: "acta",
  conservarAudio: false,       // guardar el audio para escucharlo en la biblioteca
  precios: {},                 // € por millón de tokens, los que ponga el usuario (comun.js: costeReunion)
  avisoReunion: false,         // avisar al entrar en una reunión (pide permiso para ORIGENES_REUNION)
  idiomaUI: "auto",            // idioma de la interfaz: "auto" (el de Chrome), "es" o "en" (i18n.js)
  modoAltavoz: "auto",         // cómo vuelve la pestaña a los altavoces: "auto", "audio" o "contexto" (offscreen.js)
  tema: "auto",                // apariencia: "auto" (la del sistema), "claro" u "oscuro" (ui.js)
};

// Webs de reunión que se vigilan para el aviso. Van en optional_host_permissions
// del manifest (un test comprueba que coinciden) y se piden solo al activarlo:
// sin ese permiso Chrome no deja ver la dirección de esas pestañas.
const ORIGENES_REUNION = [
  "https://meet.google.com/*",
  "https://teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://*.zoom.us/*",
  "https://kmeet.infomaniak.com/*",
  "https://meet.jit.si/*",
];

async function leerConfig() {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(CFG_LOCAL),
    chrome.storage.sync.get(CFG_SYNC),
  ]);
  return { ...local, ...sync };
}

async function guardarConfig(campos) {
  const local = {}, sync = {};
  for (const [k, v] of Object.entries(campos)) {
    if (k in CFG_LOCAL) local[k] = v;
    else if (k in CFG_SYNC) sync[k] = v;
  }
  const tareas = [];
  if (Object.keys(local).length) tareas.push(chrome.storage.local.set(local));
  if (Object.keys(sync).length) tareas.push(chrome.storage.sync.set(sync));
  await Promise.all(tareas);
}

// Versiones anteriores guardaban las claves en `sync`. Se traen a `local` y se
// borran de `sync`, que es lo que las saca de la nube de Google. Idempotente:
// si no queda nada que migrar, no escribe.
async function migrarConfig() {
  const claves = Object.keys(CFG_LOCAL);
  const viejo = await chrome.storage.sync.get(claves);
  const presentes = claves.filter((k) => viejo[k] !== undefined && viejo[k] !== "");
  if (!presentes.length) return { migradas: 0 };

  const actual = await chrome.storage.local.get(CFG_LOCAL);
  const traer = {};
  // No pisar lo que ya haya en local: allí está el valor bueno.
  for (const k of presentes) if (!actual[k]) traer[k] = viejo[k];
  if (Object.keys(traer).length) await chrome.storage.local.set(traer);
  await chrome.storage.sync.remove(claves);
  return { migradas: presentes.length };
}

// --- precios de referencia (3.6.1) ---
// Precios de lista en DÓLARES por millón de tokens, copiados de las páginas
// oficiales en la fecha indicada (Gemini: nivel de pago «Standard»). Opciones los
// enseña como pista en cada casilla y los carga con un botón; nunca se aplican
// solos. Cambian cada pocos meses: al actualizarlos, cambia también la fecha.
// Cada proveedor es una lista [patrón del nombre del modelo, precios]; vale la
// primera fila que encaje, así que las variantes («-mini», «-lite») van antes.
const PRECIOS_REFERENCIA = {
  fecha: "2026-10-02",
  dolaresPorEuro: 1.15,
  gemini: [
    [/flash-lite-latest|3\.5-flash-lite/, { audio: 0.30, entrada: 0.30, salida: 2.50 }],
    [/3\.1-flash-lite/, { audio: 0.50, entrada: 0.25, salida: 1.50 }],
    [/2\.5-flash-lite/, { audio: 0.30, entrada: 0.10, salida: 0.40 }],
    // Precio de lanzamiento hasta el 31/12/2026; desde el 1/1/2027, el doble.
    [/flash-latest|3\.[678]-flash/, { audio: 0.75, entrada: 0.75, salida: 3.75,
      cambia: { desde: "2027-01-01", precios: { audio: 1.50, entrada: 1.50, salida: 7.50 } } }],
    [/3\.5-flash/, { audio: 1.50, entrada: 1.50, salida: 9.00 }],
    [/2\.5-flash/, { audio: 1.00, entrada: 0.30, salida: 2.50 }],
    [/pro-latest|3\.1-pro/, { audio: 2.00, entrada: 2.00, salida: 12.00 }],
    [/2\.5-pro/, { audio: 1.25, entrada: 1.25, salida: 10.00 }],
  ],
  gpt: [
    [/^gpt-4o-mini/, { entrada: 0.15, salida: 0.60 }],
    [/^gpt-4o/, { entrada: 2.50, salida: 10.00 }],
    [/^gpt-4\.1-nano/, { entrada: 0.10, salida: 0.40 }],
    [/^gpt-4\.1-mini/, { entrada: 0.40, salida: 1.60 }],
    [/^gpt-4\.1/, { entrada: 2.00, salida: 8.00 }],
    [/^gpt-5-nano/, { entrada: 0.05, salida: 0.40 }],
    [/^gpt-5-mini/, { entrada: 0.25, salida: 2.00 }],
    [/^gpt-5/, { entrada: 1.25, salida: 10.00 }],
  ],
  claude: [
    [/fable/, { entrada: 10, salida: 50 }],
    [/opus-5-5/, { entrada: 4, salida: 20 }],
    [/opus/, { entrada: 5, salida: 25 }],
    [/sonnet-5/, { entrada: 2, salida: 10 }],
    [/sonnet/, { entrada: 3, salida: 15 }],
    [/haiku/, { entrada: 1, salida: 5 }],
  ],
};

// Precio de referencia de un modelo, en EUROS por millón de tokens (3 decimales),
// o null si no hay ninguno para ese nombre. `hoy` solo para los tests.
function precioReferencia(prov, modelo, hoy) {
  const fila = (PRECIOS_REFERENCIA[prov] || []).find(([re]) => re.test(String(modelo || "")));
  if (!fila) return null;
  let usd = fila[1];
  if (usd.cambia && (hoy || new Date()) >= new Date(usd.cambia.desde + "T00:00:00")) usd = usd.cambia.precios;
  const eur = {};
  for (const k of ["audio", "entrada", "salida"]) {
    if (typeof usd[k] === "number") eur[k] = Math.round((usd[k] / PRECIOS_REFERENCIA.dolaresPorEuro) * 1000) / 1000;
  }
  return eur;
}

// Cargado como script clásico tanto en páginas como en el service worker; en
// Node (tests) se exporta.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CFG_LOCAL, CFG_SYNC, ORIGENES_REUNION, PRECIOS_REFERENCIA, leerConfig, guardarConfig, migrarConfig, precioReferencia };
}
