// Escriba — service worker orquestador.
// El popup manda órdenes; la grabación/transcripción vive en un documento
// offscreen (sobrevive aunque el popup se cierre). Estado en storage.session.

importScripts("i18n.js", "config.js", "comun.js");
// Idioma de la interfaz para avisos, errores y el .md. Se vuelve a leer cuando
// cambia en Opciones (chrome.storage.onChanged, más abajo).
cargarIdiomaUI();

const OFFSCREEN_URL = "offscreen.html";
const TOPE_HISTORIAL = 100;
// Reintentos automáticos de una reunión con tramos pendientes, en minutos desde
// el fallo anterior. Más allá del último, solo a mano («Reintentar»).
const ESPERAS_REINTENTO_MIN = [1, 5, 15, 60, 180, 720];
// Reuniones que todavía necesitan su audio: ni la poda ni la limpieza las tocan.
const ESTADOS_ACTIVOS = ["grabando", "transcribiendo", "pendiente"];

// Al arrancar Chrome o instalar/actualizar la extensión:
// 1. Las claves de API vivían en storage.sync, que las replica a la cuenta de
//    Google del usuario. Se traen a local.
// 2. Una grabación que se quedó a medias (Chrome se cerró) se transcribe con lo
//    que llegó a guardarse, y las rondas que murieron con el navegador se relanzan.
// 3. Se borra el audio que ya no pertenece a ninguna reunión viva.
async function arranque() {
  await migrarConfig().catch(() => {});
  await recuperar().catch((e) => console.warn("Escriba: recuperar", e));
  await limpiarHuerfanos().catch((e) => console.warn("Escriba: limpiar audio", e));
  await revisarPendientes().catch((e) => console.warn("Escriba: pendientes", e));
}
chrome.runtime.onInstalled.addListener(() => { arranque(); });
chrome.runtime.onStartup.addListener(() => { arranque(); });

// Atajos de teclado (chrome://extensions/shortcuts): empezar/parar y marcar.
// Pulsar el atajo cuenta como invocar la extensión en la pestaña activa, así que
// sirve para capturarla igual que el botón del popup.
if (chrome.commands) {
  chrome.commands.onCommand.addListener((orden) => {
    if (orden === "grabar") alternarGrabacion().catch((e) => console.warn("Escriba: atajo", e));
    else if (orden === "marcar") marcar("").catch(() => {});
  });
}

// Aviso al entrar en una reunión (3.5, opcional en Opciones). Con el permiso de
// esas webs Chrome deja ver la dirección de sus pestañas, pero NO capturarlas:
// eso solo se puede si el usuario invoca la extensión (icono, atajo o menú).
// Probado el 01/10 en Chrome 154: ni el permiso de la web ni un popup abierto
// por código bastan. Por eso el aviso dice cómo grabar y, al pulsarlo, pone
// delante la pestaña para que el icono o el atajo la capturen a ella.
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, cambio, tab) => {
    if (cambio.status === "complete" || cambio.url) avisoReunion(tabId, tab).catch(() => {});
  });
}
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    const m = /^escriba-reunion-(\d+)$/.exec(id);
    if (!m) return;
    chrome.tabs.update(Number(m[1]), { active: true })
      .then((t) => t && chrome.windows.update(t.windowId, { focused: true }))
      .catch(() => {});
    chrome.notifications.clear(id);
  });
}

async function avisoReunion(tabId, tab) {
  const plataforma = plataformaReunion(tab && tab.url);
  if (!plataforma) return;
  const { avisoReunion: activo } = await chrome.storage.sync.get({ avisoReunion: false });
  if (!activo) return;
  // En storage.session: si el service worker se duerme, no se repite el aviso.
  const s = await chrome.storage.session.get({ grabando: false, avisosReunion: {} });
  if (s.grabando || s.avisosReunion[tabId] === tab.url) return;
  await chrome.storage.session.set({ avisosReunion: { ...s.avisosReunion, [tabId]: tab.url } });
  // El atajo de verdad: el usuario puede haberlo cambiado, o Chrome no haberlo asignado.
  let atajo = "";
  try { atajo = ((await chrome.commands.getAll()).find((c) => c.name === "grabar") || {}).shortcut || ""; } catch (_) {}
  await chrome.notifications.create("escriba-reunion-" + tabId, {
    type: "basic", iconUrl: "icon128.png", priority: 1,
    title: t("bg.avisoTitulo"),
    message: atajo ? t("bg.avisoTextoAtajo", plataforma, atajo) : t("bg.avisoTexto", plataforma),
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name.startsWith("reintento:")) lanzar(Number(a.name.slice("reintento:".length)));
});

// En cuanto el usuario guarda una clave nueva, lo que esperaba por ella se
// reintenta sin que tenga que hacer nada más.
chrome.storage.onChanged.addListener((cambios, area) => {
  if (area === "sync" && cambios.idiomaUI) cargarIdiomaUI();
  const c = area === "local" && cambios.geminiKey;
  if (c && c.newValue && c.newValue !== c.oldValue) conClaveNueva().catch(() => {});
});

// TODAS las escrituras del historial pasan por esta cola. `storage.local` no
// tiene transacciones y hay hasta tres escritores a la vez: los dos
// trabajadores que transcriben tramos y el popup guardando un análisis. Sin
// serializar, un read-modify-write pisa al otro y se pierde el progreso —o el
// análisis, que ya se ha pagado—.
let colaHist = Promise.resolve();
function enCola(fn) {
  const r = colaHist.then(fn, fn);
  colaHist = r.then(() => {}, () => {});
  return r;
}

// storage.local tiene cuota. Con el permiso unlimitedStorage no debería
// saltar, pero si salta hay que decirlo: fallar en silencio deja al usuario
// creyendo que su transcripción está guardada cuando no lo está.
async function guardarHistorial(historial) {
  try {
    await chrome.storage.local.set({ historial });
    return { ok: true };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.error("Escriba: no se pudo guardar el historial:", msg);
    return { ok: false, error: t("bg.errGuardar", msg) };
  }
}

// Una sola creación a la vez: dos llamadas simultáneas (una alarma y el popup)
// harían que la segunda fallara con «Only a single offscreen document».
let creandoOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creandoOffscreen) {
    creandoOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification: "Grabar el audio de la reunión en segundo plano y transcribirlo por tramos",
    }).finally(() => { creandoOffscreen = null; });
  }
  await creandoOffscreen;
}

// --- rondas de transcripción ---------------------------------------------------
// La transcripción la hace el documento offscreen; aquí solo se le pide.
async function lanzar(id) {
  try {
    await ensureOffscreen();
    return (await chrome.runtime.sendMessage({ target: "offscreen", cmd: "transcribir", id })) ||
      { ok: false, error: t("bg.sinTranscriptor") };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Qué está haciendo ahora el documento offscreen. null = no se sabe (existe
// pero no contesta): en ese caso NO se toca nada, por si está grabando.
async function estadoGrabador() {
  if (!(await chrome.offscreen.hasDocument())) return { grabandoId: null, enCurso: [] };
  try {
    const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "estado" });
    return r && r.ok ? { grabandoId: r.grabandoId, enCurso: r.enCurso || [] } : null;
  } catch (_) {
    return null;
  }
}

const leerHistorial = async () => (await chrome.storage.local.get({ historial: [] })).historial;

// Cierre de una ronda: estado final, .md rehecho y siguiente intento si falta algo.
async function finRonda(id) {
  const historial = await leerHistorial();
  const h = historial.find((x) => x.id === id);
  if (!h) return { ok: false, error: t("bg.entradaNoEsta") };
  const estado = estadoFinal(h.tramos);
  const md = construirMarkdown(h);
  // El .md anterior se sustituye: si no, cada reintento dejaría otra copia.
  if (typeof h.fileMd === "number") await borraDescarga(h.fileMd);
  const fichero = (h.meta && h.meta.fichero) || fechaBonita(id).fichero;
  h.fileMd = await descargaFichero("data:text/markdown;charset=utf-8," + encodeURIComponent(md), `reuniones/reunion_${fichero}.md`);
  h.transcript = md;
  h.estado = estado;
  h.progreso = "";
  h.reintento = await planificaReintento(h, estado);
  const g = await guardarHistorial(historial);
  return g.ok ? { ok: true, estado } : g;
}

// Campos que la biblioteca y el panel en vivo pueden cambiar con «histEditar».
const CAMPOS_EDITABLES = ["titulo", "participantes", "hablantes", "notas", "marcas"];

// --- grabar: lo usan el popup y el atajo de teclado -----------------------------
async function empezar({ modo, participantes }) {
  let streamId = "", tabTitle = "";
  if (modo === "tab_mic") {
    const tab = await pestanaObjetivo();
    if (!tab) return { ok: false, error: t("bg.sinPestana") };
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      tabTitle = tab.title || "";
    } catch (e) {
      return { ok: false, error: t("bg.errCaptura", tab.title || t("bg.laPestana"), (e && e.message) || e) };
    }
  }
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "start", modo, streamId, tabTitle, participantes: participantes || "" });
  if (r && r.ok) {
    await chrome.storage.session.set({
      grabando: true, t0: Date.now(), tabTitle, pausado: false, pausadoDesde: 0, pausaMs: 0,
      ultimoModo: modo, participantesBorrador: "", reunionId: r.id,
    });
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  }
  return r || { ok: false, error: t("bg.sinGrabador") };
}

async function parar() {
  const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" });
  await chrome.storage.session.set({ grabando: false, pausado: false });
  chrome.action.setBadgeText({ text: "…" });
  chrome.action.setBadgeBackgroundColor({ color: "#5d2a42" });
  return r || { ok: true };
}

async function alternarGrabacion() {
  const s = await chrome.storage.session.get({ grabando: false, ultimoModo: "tab_mic", participantesBorrador: "" });
  return s.grabando ? parar() : empezar({ modo: s.ultimoModo, participantes: s.participantesBorrador });
}

async function pausa(pausar) {
  const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: pausar ? "pausar" : "reanudar" });
  if (!r || !r.ok) return { ok: false, error: pausar ? t("bg.nadaQuePausar") : t("bg.noEnPausa") };
  const s = await chrome.storage.session.get({ pausadoDesde: 0, pausaMs: 0 });
  const ahora = Date.now();
  await chrome.storage.session.set(pausar
    ? { pausado: true, pausadoDesde: ahora }
    : { pausado: false, pausadoDesde: 0, pausaMs: s.pausaMs + (s.pausadoDesde ? ahora - s.pausadoDesde : 0) });
  chrome.action.setBadgeText({ text: pausar ? "II" : "REC" });
  chrome.action.setBadgeBackgroundColor({ color: pausar ? "#7b6b73" : "#c0392b" });
  return { ok: true };
}

// Marca el minuto GRABADO en curso: lo sabe el documento que graba.
async function marcar(nota) {
  let tiempo = null; // no `t`: es la función de los textos (i18n.js)
  if (await chrome.offscreen.hasDocument()) {
    try { tiempo = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "tiempo" }); } catch (_) {}
  }
  if (!tiempo || !tiempo.ok || !tiempo.id) return { ok: false, error: t("bg.sinGrabacion") };
  const marca = { t: tiempo.t, nota: String(nota || "").trim() };
  return enCola(async () => {
    const historial = await leerHistorial();
    const h = historial.find((x) => x.id === tiempo.id);
    if (!h) return { ok: false, error: t("bg.reunionEnCursoNoEsta") };
    h.marcas = [...(h.marcas || []), marca];
    const g = await guardarHistorial(historial);
    return g.ok ? { ok: true, marca } : g;
  });
}

// El .md de Descargas se rehace cuando el usuario cambia algo que sale en él
// (título, participantes, nombres de los hablantes). Solo en reuniones que ya
// tienen texto: una en error no tiene tramos de los que rehacerlo.
async function rehacerMd(h) {
  if (!Array.isArray(h.tramos) || !h.tramos.length || !["ok", "pendiente"].includes(h.estado)) return;
  const md = construirMarkdown(h);
  if (typeof h.fileMd === "number") await borraDescarga(h.fileMd);
  const fichero = (h.meta && h.meta.fichero) || fechaBonita(h.id).fichero;
  h.fileMd = await descargaFichero("data:text/markdown;charset=utf-8," + encodeURIComponent(md), `reuniones/reunion_${fichero}.md`);
  h.transcript = md;
}

async function planificaReintento(h, estado) {
  const alarma = "reintento:" + h.id;
  await chrome.alarms.clear(alarma);
  if (estado !== "pendiente") return null;
  const n = (h.reintento && h.reintento.n) || 0;
  const ahora = Date.now();
  const codigos = h.tramos.filter((t) => t.estado === "pendiente").map((t) => t.codigo);
  // Esperar no arregla una clave: se reintenta cuando el usuario guarde otra.
  if (codigos.length && codigos.every((c) => CODIGOS_CLAVE.includes(c))) {
    return { n, esperaClave: true, proximo: null, ultimo: ahora };
  }
  if (n >= ESPERAS_REINTENTO_MIN.length) return { n, agotado: true, proximo: null, ultimo: ahora };
  const min = ESPERAS_REINTENTO_MIN[n];
  await chrome.alarms.create(alarma, { delayInMinutes: min });
  return { n: n + 1, proximo: ahora + min * 60000, ultimo: ahora };
}

// Reintento pedido a mano: vuelve a empezar la tanda de reintentos automáticos.
async function reintentar(id) {
  const r = await enCola(async () => {
    const historial = await leerHistorial();
    const h = historial.find((x) => x.id === id);
    if (!h) return { ok: false, error: t("bg.reunionNoEsta") };
    if (!Array.isArray(h.tramos) || !h.tramos.some((tr) => tr.estado === "pendiente")) {
      return { ok: false, error: t("bg.nadaPendiente") };
    }
    h.reintento = { n: 0 };
    return guardarHistorial(historial);
  });
  return r.ok ? lanzar(id) : r;
}

async function conClaveNueva() {
  const ids = await enCola(async () => {
    const historial = await leerHistorial();
    const ids = [];
    for (const h of historial) if (h.estado === "pendiente") { h.reintento = { n: 0 }; ids.push(h.id); }
    if (ids.length) await guardarHistorial(historial);
    return ids;
  });
  for (const id of ids) await lanzar(id);
}

// Al abrir el popup: se relanza lo que toca sin esperar a la alarma, siempre
// que haya pasado un rato desde el último intento (abrir y cerrar el popup no
// debe convertirse en una ráfaga de llamadas).
async function revisarPendientes() {
  await recuperar();
  const historial = await leerHistorial();
  const { geminiKey } = await leerConfig();
  const ahora = Date.now();
  for (const h of historial) {
    if (h.estado !== "pendiente") continue;
    const r = h.reintento || {};
    const hace = r.ultimo ? ahora - r.ultimo : Infinity;
    if (r.esperaClave ? (geminiKey && hace > 60000) : (!r.agotado && hace > 2 * 60000)) await lanzar(h.id);
  }
}

// Reuniones que se quedaron a medias porque se cerró Chrome o se recargó la
// extensión. Sin esto, una grabación cortada no se transcribía nunca.
async function recuperar() {
  const vivo = await estadoGrabador();
  if (!vivo) return;
  const ids = await enCola(async () => {
    const historial = await leerHistorial();
    const relanzar = [];
    let claves = null, cambios = false;
    for (const h of historial) {
      if (h.estado === "grabando" && h.id !== vivo.grabandoId) {
        if (!claves) claves = audios ? await audios.claves().catch(() => []) : [];
        const idxs = claves.filter((k) => k[0] === h.id).map((k) => k[1]);
        // Desde la 3.3 los tramos se transcriben mientras se graba: los que ya
        // tienen texto no tienen audio (se borra al guardarse el texto) y no
        // pueden darse por perdidos.
        const previos = Array.isArray(h.tramos) ? h.tramos : [];
        const hecho = (t) => t && ["ok", "mudo"].includes(t.estado);
        cambios = true;
        if (!idxs.length && !previos.some(hecho)) {
          h.estado = "error";
          h.transcript = `# ${t("bg.grabacionInterrumpida")}\n\n${t("bg.grabacionInterrumpidaTxt")}\n`;
          continue;
        }
        const n = Math.max(idxs.length ? Math.max(...idxs) + 1 : 0, previos.length);
        h.tramos = Array.from({ length: n }, (_, i) => (hecho(previos[i]) ? previos[i] : {
          estado: idxs.includes(i) ? "pendiente" : "perdido", etiqueta: etiquetaTramo(i),
          inicioS: previos[i] && typeof previos[i].inicioS === "number" ? previos[i].inicioS : i * DURACION_TRAMO_S,
        }));
        h.meta = { ...(h.meta || {}), minutos: n * (DURACION_TRAMO_S / 60), interrumpida: true };
        h.estado = "transcribiendo";
        relanzar.push(h.id);
      } else if (h.estado === "transcribiendo" && !vivo.enCurso.includes(h.id)) {
        if (Array.isArray(h.tramos)) {
          relanzar.push(h.id); // la ronda murió con el documento que la llevaba
        } else {
          // Entrada de una versión anterior a la 3.1 cortada a medias: su audio
          // solo vivía en memoria, no hay nada que reintentar.
          h.estado = "error";
          h.progreso = "";
          h.transcript = `# ${t("bg.transcripcionInterrumpida")}\n\n${t("bg.transcripcionInterrumpidaTxt")}\n`;
          cambios = true;
        }
      }
    }
    if (cambios) await guardarHistorial(historial);
    return relanzar;
  });
  for (const id of ids) await lanzar(id);
}

// Audio en IndexedDB de reuniones que ya no lo necesitan (borradas, o que
// terminaron pero no pudieron limpiar su audio).
async function limpiarHuerfanos() {
  if (!audios) return;
  const vivo = await estadoGrabador();
  if (!vivo) return;
  const historial = await leerHistorial();
  const necesitan = new Set(historial.filter((h) => ESTADOS_ACTIVOS.includes(h.estado)).map((h) => h.id));
  if (vivo.grabandoId) necesitan.add(vivo.grabandoId);
  const sobran = new Set((await audios.claves()).map((k) => k[0]).filter((id) => !necesitan.has(id)));
  for (const id of sobran) await audios.borrarReunion(id);
  // El audio conservado vive mientras viva su reunión en el historial.
  if (audios.clavesEscucha) {
    const existen = new Set(historial.map((h) => h.id));
    if (vivo.grabandoId) existen.add(vivo.grabandoId);
    const huerfanas = new Set((await audios.clavesEscucha()).map((k) => k[0]).filter((id) => !existen.has(id)));
    for (const id of huerfanas) await audios.borrarEscucha(id);
  }
}

// Elige QUÉ pestaña grabar: la activa si es capturable y está sonando; si no,
// la primera que esté reproduciendo audio (así no se graba silencio por error).
async function pestanaObjetivo() {
  const capturable = (t) => t && t.id && t.url &&
    !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://") &&
    !t.url.startsWith("edge://") && !t.url.startsWith("https://chromewebstore.google.com");

  const [activa] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (capturable(activa) && activa.audible) return activa;

  const sonando = (await chrome.tabs.query({ audible: true })).filter(capturable);
  if (sonando.length) return sonando[0];

  return capturable(activa) ? activa : null;
}

// --- borrado de ficheros -----------------------------------------------------
// Solo se borran descargas hechas por esta extensión, identificadas por su id.
// No hay ninguna vía para tocar otro fichero del disco: la API no lo permite.

const idsDe = (h, conAudio) => [h.fileMd, ...(conAudio ? (h.filesAudio || []) : [])]
  .filter((x) => typeof x === "number");

async function borraDescarga(dlId) {
  try {
    await chrome.downloads.removeFile(dlId); // borra el fichero del disco
  } catch (_) { /* ya no existe o lo movió el usuario: seguimos */ }
  try {
    await chrome.downloads.erase({ id: dlId }); // y lo quita del historial de Chrome
  } catch (_) {}
}

async function borraFicherosDe(items, conAudio) {
  let n = 0;
  for (const h of items) {
    for (const dlId of idsDe(h, conAudio)) { await borraDescarga(dlId); n++; }
    // El audio interno pendiente de transcribir se va siempre con su reunión:
    // sin entrada en el historial ya nadie podría reintentarlo. Y el conservado
    // para escuchar, también: sin la reunión no hay dónde escucharlo.
    if (audios) await audios.borrarReunion(h.id).catch(() => {});
    if (audios && audios.borrarEscucha) await audios.borrarEscucha(h.id).catch(() => {});
    await chrome.alarms.clear("reintento:" + h.id);
  }
  return n;
}

// Devolvemos el id: es lo único que permite borrar luego ESE fichero y
// ninguno más. Sin id no se toca nada del disco.
const descargaFichero = (url, filename) => new Promise((res) =>
  chrome.downloads.download({ url, filename, saveAs: false }, res));

// Borra las entradas indicadas del historial y sus ficheros.
async function borrar(idsHist, conAudio) {
  const historial = await leerHistorial();
  const fuera = new Set(idsHist);
  const ficheros = await borraFicherosDe(historial.filter((x) => fuera.has(x.id)), conAudio);
  const quedan = historial.filter((x) => !fuera.has(x.id));
  const g = await guardarHistorial(quedan);
  if (!g.ok) return { ok: false, error: g.error, entradas: 0, ficheros };
  return { ok: true, entradas: historial.length - quedan.length, ficheros };
}

// Aplica el límite configurado: deja las N más recientes y borra el resto.
// Nunca poda una reunión que aún se está grabando o transcribiendo, o que
// espera un reintento: se perdería su audio antes de tener el texto.
async function podar() {
  const { limite } = await leerConfig(); // config.js decide en qué almacén vive
  if (!limite) return { ok: true, entradas: 0, ficheros: 0 }; // 0 = guardarlas todas
  const historial = await leerHistorial();
  const sobran = historial.slice(limite).filter((h) => !ESTADOS_ACTIVOS.includes(h.estado));
  if (!sobran.length) return { ok: true, entradas: 0, ficheros: 0 };
  // El audio de respaldo SÍ se va al podar: si no, la carpeta crece sin freno.
  return borrar(sobran.map((h) => h.id), true);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // IMPORTANTE: descartar de forma SÍNCRONA lo que no es para el service worker.
  // Si devolviéramos true para mensajes dirigidos al offscreen, el canal quedaría
  // abierto sin respuesta y sendMessage fallaría con "message channel closed".
  if (!msg || msg.target !== "bg") return false;

  (async () => {
    try {
      if (msg.cmd === "start") {
        sendResponse(await empezar(msg));

      } else if (msg.cmd === "stop") {
        sendResponse(await parar());

      } else if (msg.cmd === "pausar" || msg.cmd === "reanudar") {
        sendResponse(await pausa(msg.cmd === "pausar"));

      } else if (msg.cmd === "marcar") {
        sendResponse(await marcar(msg.nota));

      // El panel en vivo pide los niveles al documento que graba.
      } else if (msg.cmd === "niveles") {
        const hay = await chrome.offscreen.hasDocument();
        sendResponse(hay ? await chrome.runtime.sendMessage({ target: "offscreen", cmd: "niveles" }).catch(() => null) : { ok: true, id: null });

      // «¿No oyes la reunión?» del popup: el grabador cambia de forma en vivo, y
      // la elegida se recuerda para las próximas grabaciones.
      } else if (msg.cmd === "altavoz") {
        const hay = await chrome.offscreen.hasDocument();
        const r = hay ? await chrome.runtime.sendMessage({ target: "offscreen", cmd: "altavoz", accion: msg.accion }).catch(() => null) : null;
        if (r && r.ok && msg.accion === "cambiar") await guardarConfig({ modoAltavoz: r.modo });
        sendResponse(r && r.ok ? r : { ok: false, modo: null });

      // Dos minutos sin voz durante la grabación (lo detecta el offscreen).
      } else if (msg.cmd === "silencio") {
        if (msg.hay) {
          chrome.action.setBadgeText({ text: "!" });
          chrome.action.setBadgeBackgroundColor({ color: "#e67e22" });
          if (chrome.notifications) {
            chrome.notifications.create("escriba-silencio", {
              type: "basic", iconUrl: "icon128.png", priority: 2,
              title: t("bg.silencioTitulo"),
              message: t("bg.silencioTexto"),
            });
          }
        } else {
          if (chrome.notifications) chrome.notifications.clear("escriba-silencio");
          chrome.action.setBadgeText({ text: "REC" });
          chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
        }
        sendResponse({ ok: true });

      } else if (msg.cmd === "selftest") {
        const { grabando } = await chrome.storage.session.get({ grabando: false });
        if (grabando) {
          sendResponse({ ok: false, error: t("bg.diagGrabando") });
          return;
        }
        let streamId = "", tabTitle = "";
        if (msg.modo === "tab_mic") {
          const tab = await pestanaObjetivo();
          if (!tab) {
            sendResponse({ ok: false, error: t("bg.diagSinPestana") });
            return;
          }
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
            tabTitle = tab.title || "";
          } catch (e) {
            sendResponse({ ok: false, error: t("bg.diagErrCaptura", tab.title || "", (e && e.message) || e) });
            return;
          }
        }
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "selftest", modo: msg.modo, streamId, tabTitle });
        sendResponse(r || { ok: false, error: t("bg.diagSinGrabador") });

      } else if (msg.cmd === "estado") {
        const s = await chrome.storage.session.get({ grabando: false, t0: 0, tabTitle: "", pausado: false, pausadoDesde: 0, pausaMs: 0, reunionId: null, ultimoModo: "tab_mic" });
        const tab = await pestanaObjetivo();
        s.objetivo = tab ? { titulo: tab.title || "", suena: !!tab.audible } : null;
        sendResponse(s);

      } else if (msg.cmd === "listo") {
        chrome.action.setBadgeText({ text: msg.ok ? "✓" : "!" });
        chrome.action.setBadgeBackgroundColor({ color: msg.ok ? "#2e7d32" : "#c0392b" });
        setTimeout(() => chrome.action.setBadgeText({ text: "" }), 60000);
        sendResponse({ ok: true });

      } else if (msg.cmd === "descargar") {
        sendResponse({ ok: true, id: await descargaFichero(msg.url, msg.filename) });

      } else if (msg.cmd === "borrar") {
        sendResponse(await enCola(() => borrar(msg.ids || [], msg.conAudio)));

      } else if (msg.cmd === "podar") {
        sendResponse(await enCola(() => podar()));

      // El documento offscreen no tiene chrome.storage: se lo servimos nosotros.
      } else if (msg.cmd === "cfg") {
        sendResponse(await leerConfig());

      } else if (msg.cmd === "histCrear") {
        sendResponse(await enCola(async () => {
          const { historial } = await chrome.storage.local.get({ historial: [] });
          historial.unshift(msg.item);
          // Tope duro aunque el usuario elija «guardarlas todas»: storage.local
          // no es infinito. Lo que se cae por aquí se borra también del disco,
          // para no dejar ficheros huérfanos que ya nadie puede listar.
          const sobran = historial.slice(TOPE_HISTORIAL); // su audio interno también se borra
          const g = await guardarHistorial(historial.slice(0, TOPE_HISTORIAL));
          if (sobran.length) await borraFicherosDe(sobran, true);
          return g;
        }));

      } else if (msg.cmd === "histLeer") {
        sendResponse((await leerHistorial()).find((h) => h.id === msg.id) || null);

      // Resultado de UN tramo. Va por la cola y toca solo ese tramo: los dos
      // trabajadores que transcriben a la vez no pueden pisarse el uno al otro.
      } else if (msg.cmd === "histTramo") {
        sendResponse(await enCola(async () => {
          const historial = await leerHistorial();
          const h = historial.find((x) => x.id === msg.id);
          if (!h) return { ok: false, borrada: true, error: t("bg.entradaNoEsta") };
          if (!Array.isArray(h.tramos)) h.tramos = [];
          const tr = { ...(h.tramos[msg.i] || {}), ...msg.datos }; // no `t`: es la función de los textos
          if (tr.estado !== "pendiente") { delete tr.codigo; delete tr.error; delete tr.detalle; }
          h.tramos[msg.i] = tr;
          if (typeof msg.datos.dlAudio === "number") h.filesAudio = [...(h.filesAudio || []), msg.datos.dlAudio];
          const r = resumenTramos(h.tramos);
          h.progreso = t("com.progresoTramos", r.total - r.pendientes, r.total);
          return guardarHistorial(historial);
        }));

      } else if (msg.cmd === "finRonda") {
        sendResponse(await enCola(() => finRonda(msg.id)));

      } else if (msg.cmd === "transcribir") {
        sendResponse(await lanzar(msg.id));

      } else if (msg.cmd === "reintentar") {
        sendResponse(await reintentar(msg.id));

      } else if (msg.cmd === "claveNueva") {
        await conClaveNueva();
        sendResponse({ ok: true });

      } else if (msg.cmd === "revisarPendientes") {
        await revisarPendientes();
        sendResponse({ ok: true });

      } else if (msg.cmd === "histActualizar") {
        sendResponse(await enCola(async () => {
          const { historial } = await chrome.storage.local.get({ historial: [] });
          const i = historial.findIndex((h) => h.id === msg.id);
          if (i < 0) return { ok: false, error: t("bg.entradaNoEsta") };
          Object.assign(historial[i], msg.cambios);
          return guardarHistorial(historial);
        }));

      // El análisis lo pide el popup, pero lo escribe el service worker: así
      // pasa por la misma cola que el progreso de la transcripción.
      } else if (msg.cmd === "histAnalisis") {
        sendResponse(await enCola(async () => {
          const { historial } = await chrome.storage.local.get({ historial: [] });
          const i = historial.findIndex((h) => h.id === msg.id);
          // La entrada pudo podarse mientras corría el análisis. Se dice, en vez
          // de reventar con un TypeError y perder un análisis ya pagado.
          if (i < 0) return { ok: false, error: t("bg.analisisSinEntrada") };
          // Desde la 3.2 la clave es «plantilla·proveedor»; las actas de antes,
          // guardadas solo por proveedor, se conservan tal cual.
          const clave = msg.clave || msg.prov;
          historial[i].analisis = { ...(historial[i].analisis || {}), [clave]: msg.texto };
          if (msg.uso) historial[i].usoIA = [...(historial[i].usoIA || []), { clave, ...msg.uso, fecha: Date.now() }];
          const g = await guardarHistorial(historial);
          return g.ok ? { ok: true, item: historial[i] } : g;
        }));

      // Lo que el usuario puede cambiar desde la biblioteca. Solo esos campos:
      // el estado y los tramos son cosa del motor de transcripción.
      } else if (msg.cmd === "histEditar") {
        sendResponse(await enCola(async () => {
          const historial = await leerHistorial();
          const h = historial.find((x) => x.id === msg.id);
          if (!h) return { ok: false, error: t("bg.reunionNoEsta") };
          for (const k of CAMPOS_EDITABLES) if (msg.cambios && k in msg.cambios) h[k] = msg.cambios[k];
          await rehacerMd(h);
          const g = await guardarHistorial(historial);
          return g.ok ? { ok: true, item: h } : g;
        }));

      } else if (msg.cmd === "histChat") {
        sendResponse(await enCola(async () => {
          const historial = await leerHistorial();
          const h = historial.find((x) => x.id === msg.id);
          if (!h) return { ok: false, error: t("bg.chatSinEntrada") };
          h.chat = [...(h.chat || []), { ...msg.mensaje, fecha: Date.now() }];
          if (msg.mensaje && msg.mensaje.uso) {
            h.usoIA = [...(h.usoIA || []), { clave: "pregunta·" + msg.mensaje.prov, ...msg.mensaje.uso, fecha: Date.now() }];
          }
          const g = await guardarHistorial(historial);
          return g.ok ? { ok: true, item: h } : g;
        }));

      } else {
        sendResponse({ ok: false, error: "Orden desconocida: " + msg.cmd });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();

  return true; // solo para los mensajes dirigidos a "bg"
});
