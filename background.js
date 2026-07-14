// TranscriptorGod v2 — service worker orquestador.
// El popup manda órdenes; la grabación/transcripción vive en un documento
// offscreen (sobrevive aunque el popup se cierre). Estado en storage.session.

const OFFSCREEN_URL = "offscreen.html";

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // IMPORTANTE: descartar de forma SÍNCRONA lo que no es para el service worker.
  // Si devolviéramos true para mensajes dirigidos al offscreen, el canal quedaría
  // abierto sin respuesta y sendMessage fallaría con "message channel closed".
  if (!msg || msg.target !== "bg") return false;

  (async () => {
    try {
      if (msg.cmd === "start") {
        let streamId = "", tabTitle = "";
        if (msg.modo === "tab_mic") {
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
        if (msg.modo === "tab_mic") {
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
        chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false });
        sendResponse({ ok: true });

      // El documento offscreen no tiene chrome.storage: se lo servimos nosotros.
      } else if (msg.cmd === "cfg") {
        sendResponse(await chrome.storage.sync.get({ geminiKey: "", geminiModel: "gemini-flash-lite-latest", glosario: "" }));

      } else if (msg.cmd === "histCrear") {
        const { historial } = await chrome.storage.local.get({ historial: [] });
        historial.unshift(msg.item);
        await chrome.storage.local.set({ historial: historial.slice(0, 30) });
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
