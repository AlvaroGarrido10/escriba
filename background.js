// Escriba — service worker orquestador.
// El popup manda órdenes; la grabación/transcripción vive en un documento
// offscreen (sobrevive aunque el popup se cierre). Estado en storage.session.

importScripts("config.js", "comun.js");

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

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name.startsWith("reintento:")) lanzar(Number(a.name.slice("reintento:".length)));
});

// En cuanto el usuario guarda una clave nueva, lo que esperaba por ella se
// reintenta sin que tenga que hacer nada más.
chrome.storage.onChanged.addListener((cambios, area) => {
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
    return { ok: false, error: "No se pudo guardar en el almacenamiento local: " + msg };
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
      { ok: false, error: "El transcriptor no respondió." };
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
  if (!h) return { ok: false, error: "La entrada ya no está en el historial." };
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
    if (!h) return { ok: false, error: "Esa reunión ya no está en el historial." };
    if (!Array.isArray(h.tramos) || !h.tramos.some((t) => t.estado === "pendiente")) {
      return { ok: false, error: "No le queda nada pendiente." };
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
        cambios = true;
        if (!idxs.length) {
          h.estado = "error";
          h.transcript = "# La grabación se interrumpió\n\nSe cerró Chrome o se reinició la extensión antes de " +
            "completar el primer tramo, así que no llegó a guardarse audio.\n";
          continue;
        }
        const n = Math.max(...idxs) + 1;
        h.tramos = Array.from({ length: n }, (_, i) => ({
          estado: idxs.includes(i) ? "pendiente" : "perdido", etiqueta: etiquetaTramo(i),
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
          h.transcript = "# La transcripción se interrumpió\n\nEscriba se cerró o se actualizó mientras " +
            "transcribía esta reunión, y la versión que la grabó no guardaba el audio para reintentar.\n";
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
    // sin entrada en el historial ya nadie podría reintentarlo.
    if (audios) await audios.borrarReunion(h.id).catch(() => {});
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

// Audio de TODO el PC. Chrome obliga a que el usuario elija la fuente cada vez;
// no hay forma de saltarse el selector. En Windows el audio del sistema solo
// viaja si se comparte una PANTALLA COMPLETA y se marca la casilla de audio.
async function elegirEscritorio() {
  const [activa] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await new Promise((res) =>
    chrome.desktopCapture.chooseDesktopMedia(["screen", "audio"], activa,
      (streamId, opciones) => res({ streamId, opciones: opciones || {} })));
  if (!r.streamId) {
    return { ok: false, error: "Has cancelado la selección de pantalla." };
  }
  if (r.opciones.canRequestAudioTrack === false) {
    return { ok: false, error: "Elegiste la pantalla pero sin marcar «Compartir también el audio del sistema». Vuelve a intentarlo y marca esa casilla abajo a la izquierda del selector." };
  }
  return { ok: true, streamId: r.streamId };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // IMPORTANTE: descartar de forma SÍNCRONA lo que no es para el service worker.
  // Si devolviéramos true para mensajes dirigidos al offscreen, el canal quedaría
  // abierto sin respuesta y sendMessage fallaría con "message channel closed".
  if (!msg || msg.target !== "bg") return false;

  (async () => {
    try {
      if (msg.cmd === "start") {
        let streamId = "", tabTitle = "";
        if (msg.modo === "pc_mic") {
          const r = await elegirEscritorio();
          if (!r.ok) { sendResponse(r); return; }
          streamId = r.streamId;
          tabTitle = "Todo el audio del PC";
        } else if (msg.modo === "tab_mic") {
          const tab = await pestanaObjetivo();
          if (!tab) {
            sendResponse({ ok: false, error: "No encuentro ninguna pestaña con la reunión. Ábrela (Meet, Teams, YouTube…) o usa «Solo micro»." });
            return;
          }
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
            tabTitle = tab.title || "";
          } catch (e) {
            sendResponse({ ok: false, error: "No se pudo capturar «" + (tab.title || "la pestaña") + "»: " + ((e && e.message) || e) });
            return;
          }
        }
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "start", modo: msg.modo, streamId, tabTitle });
        if (r && r.ok) {
          await chrome.storage.session.set({ grabando: true, t0: Date.now(), tabTitle });
          chrome.action.setBadgeText({ text: "REC" });
          chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
        }
        sendResponse(r || { ok: false, error: "El grabador no respondió." });

      } else if (msg.cmd === "stop") {
        const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" });
        await chrome.storage.session.set({ grabando: false });
        chrome.action.setBadgeText({ text: "…" });
        chrome.action.setBadgeBackgroundColor({ color: "#5d2a42" });
        sendResponse(r || { ok: true });

      } else if (msg.cmd === "selftest") {
        const { grabando } = await chrome.storage.session.get({ grabando: false });
        if (grabando) {
          sendResponse({ ok: false, error: "Hay una grabación en curso. Párala antes de diagnosticar." });
          return;
        }
        let streamId = "", tabTitle = "";
        if (msg.modo === "pc_mic") {
          const r = await elegirEscritorio();
          if (!r.ok) { sendResponse(r); return; }
          streamId = r.streamId;
        } else if (msg.modo === "tab_mic") {
          const tab = await pestanaObjetivo();
          if (!tab) {
            sendResponse({ ok: false, error: "No hay ninguna pestaña capturable. Abre la reunión (o un vídeo) y reintenta." });
            return;
          }
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
            tabTitle = tab.title || "";
          } catch (e) {
            sendResponse({ ok: false, error: "tabCapture falló en «" + (tab.title || "") + "»: " + ((e && e.message) || e) });
            return;
          }
        }
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "selftest", modo: msg.modo, streamId, tabTitle });
        sendResponse(r || { ok: false, error: "el grabador no respondió" });

      } else if (msg.cmd === "estado") {
        const s = await chrome.storage.session.get({ grabando: false, t0: 0, tabTitle: "" });
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
          if (!h) return { ok: false, borrada: true, error: "La entrada ya no está en el historial." };
          if (!Array.isArray(h.tramos)) h.tramos = [];
          const t = { ...(h.tramos[msg.i] || {}), ...msg.datos };
          if (t.estado !== "pendiente") { delete t.codigo; delete t.error; delete t.detalle; }
          h.tramos[msg.i] = t;
          if (typeof msg.datos.dlAudio === "number") h.filesAudio = [...(h.filesAudio || []), msg.datos.dlAudio];
          const r = resumenTramos(h.tramos);
          h.progreso = `${r.total - r.pendientes}/${r.total} tramos`;
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
          if (i < 0) return { ok: false, error: "La entrada ya no está en el historial." };
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
          if (i < 0) return { ok: false, error: "Esa transcripción ya no está en el historial; el análisis no se ha podido guardar." };
          historial[i].analisis = { ...(historial[i].analisis || {}), [msg.prov]: msg.texto };
          const g = await guardarHistorial(historial);
          return g.ok ? { ok: true, item: historial[i] } : g;
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
