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
};
// Preferencias sin datos sensibles: se sincronizan entre equipos.
const CFG_SYNC = { limite: 10 };

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

// Cargado como script clásico tanto en páginas como en el service worker; en
// Node (tests) se exporta.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CFG_LOCAL, CFG_SYNC, leerConfig, guardarConfig, migrarConfig };
}
