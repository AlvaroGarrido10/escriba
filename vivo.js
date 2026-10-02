// Escriba — panel lateral en vivo: se queda abierto junto a la reunión (el popup
// se cierra en cuanto se pulsa fuera). Enseña el texto según llega, el nivel de
// cada fuente y deja pausar, marcar momentos y tomar notas.
//
// Como la biblioteca, no escribe en el historial: todo pasa por el service worker.

const $ = (id) => document.getElementById(id);
const aBgMsg = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
let sesion = {}, reunion = null, relojInt = null, nivelesInt = null, notasTimer = null, ultimoTextoLineas = -1;

$("btnBiblio").onclick = () => chrome.tabs.create({ url: "reuniones.html" });

(async function init() {
  // Antes de pintar nada: el idioma elegido en Opciones (traduce el HTML).
  await cargarIdiomaUI();
  if (chrome.commands && chrome.commands.getAll) {
    chrome.commands.getAll().then((cs) => {
      const g = cs.find((c) => c.name === "grabar");
      if (g && g.shortcut) $("atajo").textContent = " " + t("viv.oCon", g.shortcut);
    }).catch(() => {});
  }
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
  $("conGrabacion").classList.toggle("pausa", !!sesion.pausado);
  const est = $("estadoRec");
  est.className = "pildora" + (sesion.grabando ? (sesion.pausado ? "" : " rec") : "");
  est.innerHTML = sesion.grabando
    ? (sesion.pausado ? icono("pausa") + escapa(t("viv.enPausaBadge")) : '<span class="punto"></span>' + escapa(t("viv.grabandoBadge")))
    : escapa(t("viv.sinGrabacion"));
  $("btnPausa").innerHTML = icono(sesion.pausado ? "play" : "pausa") + `<span>${escapa(t(sesion.pausado ? "viv.reanudar" : "viv.pausar"))}</span>`;
  $("sub").textContent = sesion.pausado ? t("viv.enPausa") : "";
  clearInterval(relojInt);
  clearInterval(nivelesInt);
  if (sesion.grabando) {
    pintaReloj();
    relojInt = setInterval(pintaReloj, 500);
    nivelesInt = setInterval(pintaNiveles, 150);
    pintaNiveles();
  }
  pintaReunion(historial);
}

function pintaReloj() {
  const ms = (sesion.pausado ? sesion.pausadoDesde : Date.now()) - sesion.t0 - (sesion.pausaMs || 0);
  const s = Math.max(0, ms) / 1000;
  $("reloj").textContent = formatoTiempo(s);
  const enTramo = s % DURACION_TRAMO_S;
  $("progTramo").style.width = Math.round((enTramo / DURACION_TRAMO_S) * 100) + "%";
  if (!sesion.pausado) $("sub").textContent = t("viv.siguienteTrozo", formatoTiempo(DURACION_TRAMO_S - enTramo));
}

// Cada 150 ms; si una respuesta tarda más, no se amontonan las peticiones.
let pidiendoNiveles = false;
async function pintaNiveles() {
  if (pidiendoNiveles) return;
  pidiendoNiveles = true;
  const r = await aBgMsg("niveles").catch(() => null);
  pidiendoNiveles = false;
  if (!r || !r.ok || !r.id) return;
  actualizaNiveles($("niveles"), r.fuentes || []);
  const aviso = $("avisoNivel");
  if (r.sinMicro && aviso.hidden) ponAviso(aviso, "atencion", escapa(t("viv.sinMicro")), "micro-no");
  else if (!r.sinMicro) aviso.hidden = true;
}

// La reunión en curso (o la última, si ya se paró).
function pintaReunion(historial) {
  const id = sesion.reunionId;
  reunion = (id && historial.find((h) => h.id === id)) || null;
  if (!sesion.grabando) {
    const h = reunion || historial[0];
    const u = $("ultima");
    u.innerHTML = "";
    if (h && ["transcribiendo", "ok", "pendiente"].includes(h.estado)) {
      const transcribiendo = h.estado === "transcribiendo";
      u.innerHTML = avisoHtml(transcribiendo ? "" : "ok", t(transcribiendo ? "viv.transcribiendoFinal" : "viv.lista", escapa(h.titulo)), transcribiendo ? "reloj" : "ok");
      if (!transcribiendo) {
        const b = botonUI({ texto: t("viv.abrirBiblio"), icono: "libro", clase: "btn-peq btn-primario", alPulsar: () => chrome.tabs.create({ url: "reuniones.html#" + h.id }) });
        b.style.marginTop = "8px";
        u.querySelector(".cuerpo").appendChild(document.createElement("div")).appendChild(b);
      }
    }
    return;
  }
  if (!reunion) return;
  // Notas: no se pisa lo que se está escribiendo.
  if (document.activeElement !== $("notas")) $("notas").value = reunion.notas || "";
  $("marcas").innerHTML = (reunion.marcas || []).map((m) => `<li>${icono("estrella")}<b>${formatoTiempo(m.t)}</b>${escapa(m.nota || "")}</li>`).join("");
  const lineas = [];
  for (const tr of reunion.tramos || []) {
    if (tr.estado === "ok") lineas.push(...lineasTranscripcion(aplicarHablantes(tr.texto || "", mapaVisible(tr.texto || "", reunion.hablantes))));
  }
  if (lineas.length !== ultimoTextoLineas) {
    ultimoTextoLineas = lineas.length;
    const cont = $("texto");
    if (lineas.length) {
      const abajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 30;
      cont.innerHTML = htmlTurnos(lineas);
      if (abajo) cont.scrollTop = cont.scrollHeight;
      revisaIrFinal();
    }
  }
}

// Las frases seguidas de la misma voz, juntas bajo su nombre.
function htmlTurnos(lineas) {
  const voces = [];
  let html = "", previo;
  for (const l of lineas) {
    const quien = l.hablante || "";
    if (quien && !voces.includes(quien)) voces.push(quien);
    if (quien !== previo) {
      if (previo !== undefined) html += "</div>";
      previo = quien;
      html += `<div class="turno" style="--c:var(--voz-${Math.max(0, voces.indexOf(quien)) % 8})">` +
        (quien ? `<div class="quien"><span class="avatar">${escapa(inicialDe(quien))}</span>${escapa(quien)}${l.t !== null ? `<span class="t">${formatoTiempo(l.t)}</span>` : ""}</div>` : "");
    }
    html += `<p>${escapa(l.texto)}</p>`;
  }
  return html + (previo !== undefined ? "</div>" : "");
}

// «Ir al final» solo si el usuario ha subido a leer algo anterior.
function revisaIrFinal() {
  const c = $("texto");
  $("irFinal").hidden = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
}
$("texto").addEventListener("scroll", revisaIrFinal);
$("irFinal").onclick = () => { $("texto").scrollTo({ top: $("texto").scrollHeight, behavior: "smooth" }); };

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
  if (r && r.ok) { $("notaMarca").value = ""; toast(t("viv.marcado", formatoTiempo(r.marca.t)), "ok"); }
  else toast((r && r.error) || t("viv.noSePudoMarcar"), "error");
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
  $("guardado").textContent = r && r.ok ? t("viv.guardado") : t("viv.noGuardadas");
  $("guardado").style.color = r && r.ok ? "" : "var(--error)";
}
