// Escriba — panel lateral en vivo: se queda abierto junto a la reunión (el popup
// se cierra en cuanto se pulsa fuera). Enseña el texto según llega, el nivel de
// cada fuente y deja pausar, marcar momentos y tomar notas.
//
// Como la biblioteca, no escribe en el historial: todo pasa por el service worker.

const $ = (id) => document.getElementById(id);
const aBgMsg = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
const escV = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let sesion = {}, reunion = null, relojInt = null, nivelesInt = null, notasTimer = null, ultimoTextoLineas = -1;

$("btnBiblio").onclick = () => chrome.tabs.create({ url: "reuniones.html" });

if (chrome.commands && chrome.commands.getAll) {
  chrome.commands.getAll().then((cs) => {
    const g = cs.find((c) => c.name === "grabar");
    if (g && g.shortcut) $("atajo").textContent = ` o con ${g.shortcut}`;
  }).catch(() => {});
}

(async function init() {
  await refresca();
  chrome.storage.onChanged.addListener((cambios, area) => {
    if (area === "session") refresca();
    if (area === "local" && cambios.historial) pintaReunion(cambios.historial.newValue || []);
  });
})();

async function refresca() {
  sesion = await chrome.storage.session.get({ grabando: false, t0: 0, pausado: false, pausadoDesde: 0, pausaMs: 0, reunionId: null });
  const { historial } = await chrome.storage.local.get({ historial: [] });
  $("sinGrabacion").hidden = !!sesion.grabando;
  $("conGrabacion").hidden = !sesion.grabando;
  const est = $("estadoRec");
  est.className = sesion.grabando ? (sesion.pausado ? "pausa" : "rec") : "";
  est.textContent = sesion.grabando ? (sesion.pausado ? "II en pausa" : "● grabando") : "sin grabación";
  $("btnPausa").textContent = sesion.pausado ? "▶ Reanudar" : "⏸ Pausar";
  $("reloj").classList.toggle("pausa", !!sesion.pausado);
  $("sub").textContent = sesion.pausado ? "En pausa: no se graba nada hasta que reanudes." : "";
  clearInterval(relojInt);
  clearInterval(nivelesInt);
  if (sesion.grabando) {
    pintaReloj();
    relojInt = setInterval(pintaReloj, 500);
    nivelesInt = setInterval(pintaNiveles, 700);
    pintaNiveles();
  }
  pintaReunion(historial);
}

function pintaReloj() {
  const ms = (sesion.pausado ? sesion.pausadoDesde : Date.now()) - sesion.t0 - (sesion.pausaMs || 0);
  const s = Math.max(0, ms) / 1000;
  $("reloj").textContent = formatoTiempo(s);
  if (!sesion.pausado) {
    const enTramo = s % DURACION_TRAMO_S;
    $("sub").textContent = `El siguiente trozo de texto llega en ${formatoTiempo(DURACION_TRAMO_S - enTramo)}.`;
  }
}

async function pintaNiveles() {
  const r = await aBgMsg("niveles").catch(() => null);
  if (!r || !r.ok || !r.id) return;
  $("niveles").innerHTML = (r.fuentes || []).map((f) => {
    // En decibelios, como un vúmetro: -60 dB (silencio) = 0 %, -10 dB = lleno.
    const db = 20 * Math.log10(Math.max(f.rms, 1e-6));
    const pct = Math.max(0, Math.min(100, Math.round(((db + 60) / 50) * 100)));
    return `<div class="nivel"><span>${f.nombre === "pestaña" ? "🖥️ Pestaña" : "🎙️ Micro"}</span><div class="barra"><div style="width:${pct}%"></div></div></div>`;
  }).join("");
  const aviso = $("avisoNivel");
  if (r.sinMicro) { aviso.hidden = false; aviso.textContent = "⚠️ El micrófono no está disponible: tu voz no se está grabando. Autorízalo en Opciones."; }
  else aviso.hidden = true;
}

// La reunión en curso (o la última, si ya se paró).
function pintaReunion(historial) {
  const id = sesion.reunionId;
  reunion = (id && historial.find((h) => h.id === id)) || null;
  if (!sesion.grabando) {
    const h = reunion || historial[0];
    const u = $("ultima");
    if (h && ["transcribiendo", "ok", "pendiente"].includes(h.estado)) {
      u.innerHTML = `<p class="vacio">${h.estado === "transcribiendo" ? "✍️ Transcribiendo el final de" : "✅ Lista:"} <b>${escV(h.titulo)}</b></p>`;
      if (h.estado !== "transcribiendo") {
        const b = document.createElement("button");
        b.textContent = "📖 Abrir en la biblioteca";
        b.style.cssText = "width:100%;margin-bottom:6px";
        b.onclick = () => chrome.tabs.create({ url: "reuniones.html#" + h.id });
        u.appendChild(b);
      }
    } else u.innerHTML = "";
    return;
  }
  if (!reunion) return;
  // Notas: no se pisa lo que se está escribiendo.
  if (document.activeElement !== $("notas")) $("notas").value = reunion.notas || "";
  $("marcas").innerHTML = (reunion.marcas || []).map((m) => `<li><b>${formatoTiempo(m.t)}</b>${escV(m.nota || "⭐")}</li>`).join("");
  const lineas = [];
  for (const t of reunion.tramos || []) {
    if (t.estado === "ok") lineas.push(...lineasTranscripcion(aplicarHablantes(t.texto || "", reunion.hablantes)));
  }
  if (lineas.length !== ultimoTextoLineas) {
    ultimoTextoLineas = lineas.length;
    const cont = $("texto");
    if (lineas.length) {
      const abajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 30;
      cont.innerHTML = lineas.map((l) => `<div class="l">${l.t !== null ? `<span class="t">${formatoTiempo(l.t)}</span>` : ""}${l.hablante ? `<span class="h">${escV(l.hablante)}:</span>` : ""}${escV(l.texto)}</div>`).join("");
      if (abajo) cont.scrollTop = cont.scrollHeight;
    }
  }
}

$("btnPausa").onclick = async () => {
  $("btnPausa").disabled = true;
  await aBgMsg(sesion.pausado ? "reanudar" : "pausar");
  $("btnPausa").disabled = false;
};
$("btnParar").onclick = async () => {
  $("btnParar").disabled = true;
  await guardaNotas();
  await aBgMsg("stop");
  $("btnParar").disabled = false;
};

$("formMarca").onsubmit = async (e) => {
  e.preventDefault();
  const r = await aBgMsg("marcar", { nota: $("notaMarca").value });
  if (r && r.ok) $("notaMarca").value = "";
  else $("sub").textContent = "❌ " + ((r && r.error) || "No se pudo marcar.");
};

$("notas").addEventListener("input", () => {
  $("guardado").textContent = "";
  clearTimeout(notasTimer);
  notasTimer = setTimeout(guardaNotas, 800);
});
async function guardaNotas() {
  clearTimeout(notasTimer);
  if (!reunion) return;
  const notas = $("notas").value;
  if (notas === (reunion.notas || "")) return;
  const r = await aBgMsg("histEditar", { id: reunion.id, cambios: { notas } });
  $("guardado").textContent = r && r.ok ? "Guardado ✓" : "❌ No se pudieron guardar las notas";
}
