// TranscriptorGod v2 — service worker orquestador.
// El popup manda órdenes; la grabación/transcripción vive en un documento
// offscreen (sobrevive aunque el popup se cierre). Estado en storage.session.

const OFFSCREEN_URL = "offscreen.html";
const TOPE_HISTORIAL = 100;

async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Grabar audio de la reunión (pestaña y/o micrófono) en segundo plano",
    });
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
  }
  return n;
}

// Borra las entradas indicadas del historial y sus ficheros.
async function borrar(idsHist, conAudio) {
  const { historial } = await chrome.storage.local.get({ historial: [] });
  const fuera = new Set(idsHist);
  const ficheros = await borraFicherosDe(historial.filter((x) => fuera.has(x.id)), conAudio);
  const quedan = historial.filter((x) => !fuera.has(x.id));
  await chrome.storage.local.set({ historial: quedan });
  return { ok: true, entradas: historial.length - quedan.length, ficheros };
}

// Aplica el límite configurado: deja las N más recientes y borra el resto.
async function podar() {
  const { limite } = await chrome.storage.sync.get({ limite: 10 });
  if (!limite) return { ok: true, entradas: 0, ficheros: 0 }; // 0 = guardarlas todas
  const { historial } = await chrome.storage.local.get({ historial: [] });
  if (historial.length <= limite) return { ok: true, entradas: 0, ficheros: 0 };
  // El audio de respaldo SÍ se va al podar: si no, la carpeta crece sin freno.
  return borrar(historial.slice(limite).map((h) => h.id), true);
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
        // Devolvemos el id: es lo único que permite borrar luego ESE fichero y
        // ninguno más. Sin id no se toca nada del disco.
        const dlId = await new Promise((res) =>
          chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false }, res));
        sendResponse({ ok: true, id: dlId });

      } else if (msg.cmd === "borrar") {
        sendResponse(await borrar(msg.ids || [], msg.conAudio));

      } else if (msg.cmd === "podar") {
        sendResponse(await podar());

      // El documento offscreen no tiene chrome.storage: se lo servimos nosotros.
      } else if (msg.cmd === "cfg") {
        sendResponse(await chrome.storage.sync.get({ geminiKey: "", geminiModel: "gemini-flash-latest", glosario: "" }));

      } else if (msg.cmd === "histCrear") {
        const { historial } = await chrome.storage.local.get({ historial: [] });
        historial.unshift(msg.item);
        // Tope duro aunque el usuario elija «guardarlas todas»: storage.local no
        // es infinito. Lo que se cae por aquí se borra también del disco, para
        // no dejar ficheros huérfanos que ya nadie puede listar.
        const sobran = historial.slice(TOPE_HISTORIAL);
        await chrome.storage.local.set({ historial: historial.slice(0, TOPE_HISTORIAL) });
        if (sobran.length) await borraFicherosDe(sobran, true);
        sendResponse({ ok: true });

      } else if (msg.cmd === "histActualizar") {
        const { historial } = await chrome.storage.local.get({ historial: [] });
        const i = historial.findIndex((h) => h.id === msg.id);
        if (i >= 0) {
          Object.assign(historial[i], msg.cambios);
          await chrome.storage.local.set({ historial });
        }
        sendResponse({ ok: true });

      } else {
        sendResponse({ ok: false, error: "Orden desconocida: " + msg.cmd });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();

  return true; // solo para los mensajes dirigidos a "bg"
});
