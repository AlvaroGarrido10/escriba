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
// Los campos de cada proveedor van escritos uno a uno, y no generados desde el
// registro (proveedores.js), para que se vea de un vistazo qué se guarda. Un test
// comprueba que los dos coinciden: clave, modelo de actas y modelo de voz.
const CFG_LOCAL = {
  geminiKey: "", geminiModel: "",
  openaiKey: "", openaiModel: "gpt-4o", openaiVoz: "gpt-transcribe",
  claudeKey: "", claudeModel: "claude-sonnet-5",
  mistralKey: "", mistralModel: "mistral-small-latest", mistralVoz: "voxtral-mini-latest",
  groqKey: "", groqModel: "openai/gpt-oss-120b", groqVoz: "whisper-large-v3",
  deepseekKey: "", deepseekModel: "deepseek-flash",
  openrouterKey: "", openrouterModel: "openrouter/free",
  // Con quién se transcribe: "auto" (la primera clave que haya) o el id de un
  // proveedor. Va en local, con las claves: en otro equipo puede no haber la misma.
  provTranscribe: "auto",
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
  modoGrabar: "orig_mic",      // forma de grabar que sale elegida en el popup: "orig_mic", "tab_mic" o "mic"
  modoAltavoz: "auto",         // solo en "tab_mic": cómo vuelve la pestaña a los altavoces: "auto", "colchon", "audio" o "contexto" (offscreen.js)
  tema: "auto",                // apariencia: "auto" (la del sistema), "claro" u "oscuro" (ui.js)
  grabarSinClave: false,       // grabar aunque no haya clave de ninguna IA: se guarda el audio y no se transcribe
};

// Webs de reunión que se vigilan para el aviso. Van en optional_host_permissions
// del manifest, junto a los hosts de los proveedores de IA de host opcional que
// estén encendidos (hoy, ninguno; proveedores.js: origenesProveedores; un test
// comprueba que son esos y ninguno más), y se piden solo al activarlo: sin ese
// permiso Chrome no deja ver la dirección de esas pestañas.
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

// --- las claves de los demás proveedores de IA (3.8) ---
// La de Gemini la valida y la guarda Opciones a su manera (options.js:
// validarClave), que además le elige modelo. El resto pasa por aquí.

// La lista de modelos de un proveedor, pedida con su clave. Si responde bien, la
// clave vale: de paso sirve para comprobarla. Devuelve los ids que valen para
// actas y preguntas (proveedores.js: modelosDeChat). Si no, lanza un Error con
// `status`: el HTTP, o 0 si ni siquiera hubo conexión.
async function listarModelos(id, clave) {
  const pet = peticionModelos(id, clave);
  if (!pet) throw new Error(t("ia.provDesconocido", id));
  let r;
  try {
    r = await fetch(pet.url, { headers: pet.headers });
  } catch (e) {
    throw Object.assign(new Error((e && e.message) || String(e)), { status: 0 });
  }
  if (!r.ok) {
    // El motivo viaja con el error: un 401 puede ser una clave falsa o una
    // buena sin permiso para ver esta lista (guardarClaveProveedor las distingue).
    let motivo = "";
    try { motivo = detalleErrorApi(await r.text()); } catch (_) { /* sin cuerpo */ }
    throw Object.assign(new Error("HTTP " + r.status), { status: r.status, motivo });
  }
  let cuerpo = null;
  // Ha respondido bien: la clave vale aunque la lista no se pueda leer.
  try { cuerpo = await r.json(); } catch (_) { /* se queda sin lista */ }
  return modelosDeChat(id, cuerpo);
}

// Guarda la clave de un proveedor, o la borra si llega vacía. Es lo que hace el
// botón «Guardar» de su tarjeta en Opciones, y el orden importa:
//  1. El permiso de host, si el suyo es opcional. Chrome solo lo concede dentro
//     del gesto del usuario (el clic), y el gesto caduca enseguida: por eso
//     `permissions.request` es el PRIMER await, antes de tocar la red. Se pide un
//     solo proveedor por petición: así el aviso de Chrome nombra su dirección
//     (con cuatro o más diría «una serie de sitios web»).
//  2. La clave se comprueba pidiendo su lista de modelos.
//  3. Solo entonces se guarda, con los `otros` campos que vengan (su modelo).
// Una clave que no se ha podido comprobar no se guarda ni pisa la que hubiera.
// Devuelve { estado }:
//   "guardada"       con `modelos`. Lleva además `status` (403, o el 401 de
//                    OpenAI que dice «insufficient permissions… Missing scopes»)
//                    si el proveedor reconoce la clave pero no le deja ver la
//                    lista: una clave con permisos recortados redacta igual, y
//                    hasta la 3.7 se podía guardar.
//   "borrada"        llegó vacía: se borra y se retira el permiso opcional
//   "sin_permiso"    el usuario no dio el permiso: no se guarda
//   "clave_mala"     el proveedor la rechaza (401): no se guarda
//   "no_comprobada"  cualquier otro fallo (`status`; 0 es sin conexión, con su
//                    `detalle`): no se guarda
// Una clave que el proveedor reconoce pero a la que no deja ver la lista de
// modelos: el 403, o el 401 con el que OpenAI contesta «insufficient
// permissions… Missing scopes». Sirve igual para redactar.
const claveSinLista = (e) => !!e && (e.status === 403 || (e.status === 401 && /insufficient permissions|missing scopes/i.test(e.motivo || "")));

async function guardarClaveProveedor(id, clave, otros) {
  const p = provDe(id);
  // Lo apagado no existe: ni se le pide permiso ni se le manda nada.
  if (!p || !(transcribe(id) || redacta(id))) throw new Error(t("ia.provDesconocido", id));
  const k = String(clave || "").trim();
  const campos = { ...(otros || {}), [p.campoClave]: k };
  if (!k) {
    await guardarConfig(campos);
    if (!p.fijo) await chrome.permissions.remove({ origins: [p.host] }).catch(() => false);
    return { estado: "borrada" };
  }
  if (!p.fijo) {
    const concedido = await chrome.permissions.request({ origins: [p.host] }).catch(() => false);
    if (!concedido) return { estado: "sin_permiso" };
  }
  let modelos = [], sinLista = 0;
  try {
    modelos = await listarModelos(id, k);
  } catch (e) {
    const recortada = claveSinLista(e);
    if (e.status === 401 && !recortada) return { estado: "clave_mala", status: 401 };
    if (!recortada) return { estado: "no_comprobada", status: e.status || 0, detalle: e.message };
    sinLista = e.status;
  }
  await guardarConfig(campos);
  return sinLista ? { estado: "guardada", modelos, status: sinLista } : { estado: "guardada", modelos };
}

// --- precios de referencia (3.6.1) ---
// Precios de lista en DÓLARES por millón de tokens, copiados de las páginas
// oficiales en la fecha indicada (Gemini: nivel de pago «Standard»). Opciones los
// enseña como pista en cada casilla y los carga con un botón; nunca se aplican
// solos. Cambian cada pocos meses: al actualizarlos, cambia también la fecha.
// Cada proveedor es una lista [patrón del nombre del modelo, precios]; vale la
// primera fila que encaje, así que las variantes («-mini», «-lite») van antes.
// Los modelos que transcriben fuera de Gemini no cobran por tokens sino por
// tiempo: su precio es `minuto`, en DÓLARES por minuto de audio (3.8).
const PRECIOS_REFERENCIA = {
  fecha: "2026-10-05",
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
    // Los de voz, delante: «gpt-4o-transcribe-diarize» también empieza por «gpt-4o».
    [/^gpt-4o-transcribe-diarize|^whisper-1/, { minuto: 0.006 }],
    [/^gpt-transcribe/, { minuto: 0.0045 }],
    [/^gpt-4o-mini/, { entrada: 0.15, salida: 0.60 }],
    [/^gpt-4o/, { entrada: 2.50, salida: 10.00 }],
    [/^gpt-4\.1-nano/, { entrada: 0.10, salida: 0.40 }],
    [/^gpt-4\.1-mini/, { entrada: 0.40, salida: 1.60 }],
    [/^gpt-4\.1/, { entrada: 2.00, salida: 8.00 }],
    [/^gpt-6-luna/, { entrada: 0.10, salida: 0.50 }],
    [/^gpt-6\.1-sol/, { entrada: 2.00, salida: 10.00 }],
    [/^gpt-6-astra/, { entrada: 10.00, salida: 50.00 }],
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
  mistral: [
    [/voxtral/, { minuto: 0.003 }],
    [/small/, { entrada: 0.15, salida: 0.60 }],
    [/medium/, { entrada: 1.50, salida: 7.50 }],
    [/large/, { entrada: 0.50, salida: 1.50 }],
  ],
  groq: [
    [/whisper-large-v3-turbo/, { minuto: 0.00067 }],
    [/whisper-large-v3/, { minuto: 0.00185 }],
    [/gpt-oss-120b/, { entrada: 0.15, salida: 0.60 }],
    [/gpt-oss-20b/, { entrada: 0.075, salida: 0.30 }],
  ],
  // El precio de hora punta (días laborables, de 01:00 a 04:00 y de 06:00 a 10:00 UTC);
  // en hora valle cuesta la mitad.
  deepseek: [
    [/flash/, { entrada: 0.30, salida: 1.20 }],
    [/v4-pro/, { entrada: 1.32, salida: 3.96 }],
  ],
};

// Precio de referencia de un modelo, en EUROS: por millón de tokens (3 decimales)
// y, en los de voz, por minuto de audio (5 decimales: son milésimas de euro). O
// null si no hay ninguno para ese nombre. `hoy` solo para los tests.
function precioReferencia(prov, modelo, hoy) {
  const fila = (PRECIOS_REFERENCIA[prov] || []).find(([re]) => re.test(String(modelo || "")));
  if (!fila) return null;
  let usd = fila[1];
  if (usd.cambia && (hoy || new Date()) >= new Date(usd.cambia.desde + "T00:00:00")) usd = usd.cambia.precios;
  const eur = {};
  for (const [k, redondeo] of [["audio", 1e3], ["entrada", 1e3], ["salida", 1e3], ["minuto", 1e5]]) {
    if (typeof usd[k] === "number") eur[k] = Math.round((usd[k] / PRECIOS_REFERENCIA.dolaresPorEuro) * redondeo) / redondeo;
  }
  return eur;
}

// Cargado como script clásico tanto en páginas como en el service worker; en
// Node (tests) se exporta.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CFG_LOCAL, CFG_SYNC, ORIGENES_REUNION, PRECIOS_REFERENCIA, leerConfig, guardarConfig, migrarConfig, precioReferencia,
    listarModelos, guardarClaveProveedor,
  };
}
