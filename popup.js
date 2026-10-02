// Escriba — popup: control de grabación + historial + análisis IA.

const $ = (id) => document.getElementById(id);
let timerInt = null, ultimoIdVisto = null;

$("lnkOpc").onclick = () => chrome.runtime.openOptionsPage();
// Leer, exportar, sacar actas y preguntar: todo eso vive en la biblioteca, que
// tiene sitio. El popup se queda para grabar.
const abrirBiblioteca = (id) => chrome.tabs.create({ url: "reuniones.html" + (id ? "#" + id : "") });
$("lnkBiblio").onclick = () => abrirBiblioteca();

// Los participantes se guardan mientras se escriben: cerrar el popup para ir a
// la reunión no puede borrarlos.
$("participantes").addEventListener("input", () => {
  chrome.storage.session.set({ participantesBorrador: $("participantes").value });
});

// El panel lateral solo se puede abrir en respuesta a un clic, y sin esperas
// por medio: el id de la ventana se averigua antes.
let ventanaId = null;
chrome.windows.getCurrent().then((w) => { ventanaId = w.id; }).catch(() => {});
$("btnVivo").onclick = () => {
  if (chrome.sidePanel && ventanaId !== null) chrome.sidePanel.open({ windowId: ventanaId }).catch(() => {});
};
$("btnPausa").onclick = async () => {
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: s && s.pausado ? "reanudar" : "pausar" });
  if (!r || !r.ok) { $("estado").textContent = "❌ " + ((r && r.error) || t("pop.noSePudo")); return; }
  refrescaGrabacion();
};
$("btnMarca").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "marcar", nota: "" });
  $("estado").textContent = r && r.ok ? t("pop.momentoMarcado", formatoTiempo(r.marca.t)) : "❌ " + ((r && r.error) || t("pop.noSePudoMarcar"));
};

// Recordatorio legal: grabar a otros sin avisarles no es buena idea (RGPD).
chrome.storage.sync.get({ avisoRgpdOculto: false }).then(({ avisoRgpdOculto }) => {
  $("avisoRgpd").style.display = avisoRgpdOculto ? "none" : "block";
});
$("ocultaRgpd").onclick = () => { chrome.storage.sync.set({ avisoRgpdOculto: true }); $("avisoRgpd").style.display = "none"; };

// El atajo puede haberlo cambiado el usuario en chrome://extensions/shortcuts.
// Se pinta desde init(), cuando ya se sabe el idioma.
function pintaAtajo() {
  if (!chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll().then((cs) => {
    const g = cs.find((c) => c.name === "grabar");
    if (g && g.shortcut) $("atajo").textContent = " " + t("pop.atajo", g.shortcut);
  }).catch(() => {});
}
$("btnArreglaMic").onclick = () => chrome.runtime.openOptionsPage();

// El permiso de micrófono se concede al ORIGEN de la extensión, y solo lo puede
// pedir la página de Opciones: el documento offscreen que graba no puede enseñar
// el diálogo, así que sin permiso previo falla con "NotAllowedError: Permission
// dismissed" y la grabación sale sin tu voz. Mejor avisar antes de grabar.
let micOk = true;
async function revisaMicro() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    micOk = p.state === "granted";
    p.onchange = () => { micOk = p.state === "granted"; pintaAvisoMic(); };
  } catch (_) {
    micOk = true; // si no se puede consultar, no dar la lata
  }
  pintaAvisoMic();
}
function pintaAvisoMic() {
  const modo = document.querySelector(".modo input:checked").value;
  $("avisoMicTxt").textContent = modo === "mic" ? t("pop.micModoMicNada") : t("pop.micSoloPestana");
  $("avisoMic").style.display = micOk ? "none" : "block";
}
document.querySelectorAll(".modo input").forEach(r => r.addEventListener("change", pintaModo));
function pintaModo() {
  document.querySelectorAll(".modo label").forEach(l => l.classList.remove("sel"));
  document.querySelector(".modo input:checked").closest("label").classList.add("sel");
}
pintaModo();

// Repintar en cuanto la transcripción termine (aunque el popup esté abierto).
// Se engancha desde init(), cuando ya se sabe el idioma.
function alCambiarHistorial(cambios, area) {
  if (area === "local" && cambios.historial) {
    const nuevos = cambios.historial.newValue || [];
    pintaHistorial();
    const ultimo = nuevos[0];
    // Mientras trocea y transcribe, ir cantando por dónde va.
    if (ultimo && ultimo.estado === "transcribiendo" && ultimo.progreso) {
      $("estado").textContent = t("pop.transcribiendoProg", ultimo.progreso);
    }
    // Si la última grabación acaba de terminar, se avisa con un botón para abrirla.
    if (ultimo && ESTADOS_FINALES.includes(ultimo.estado) && ultimo.id !== ultimoIdVisto) {
      ultimoIdVisto = ultimo.id;
      avisaLista(ultimo);
    }
  }
}

const ESTADOS_FINALES = ["ok", "pendiente", "error"];

function avisaLista(h) {
  const caja = $("listo");
  const txt = h.estado === "ok" ? t("pop.listaOk")
    : h.estado === "pendiente" ? t("pop.listaPendiente")
      : t("pop.listaError");
  caja.innerHTML = `${txt}: <b>${esc(h.titulo)}</b>. `;
  const b = document.createElement("button");
  b.textContent = t("pop.abrir");
  b.style.cssText = "font-size:11px;padding:3px 8px;border:1px solid #2e7d32;background:#fff;color:#1f5b22;border-radius:5px;cursor:pointer;margin-left:4px";
  b.onclick = () => abrirBiblioteca(h.id);
  caja.appendChild(b);
  caja.style.display = "block";
  $("estado").textContent = "";
}

$("btnImportar").onclick = () => chrome.tabs.create({ url: "importar.html" });

init();
async function init() {
  // Antes de pintar nada: el idioma elegido en Opciones (traduce el HTML).
  await cargarIdiomaUI();
  pintaAtajo();
  chrome.storage.onChanged.addListener(alCambiarHistorial);
  // Lo que quedó pendiente se reintenta al abrir el popup, sin esperar a la
  // alarma (el service worker decide si ya toca). No se espera la respuesta.
  chrome.runtime.sendMessage({ target: "bg", cmd: "revisarPendientes" }).catch(() => {});
  // Primer uso: sin clave no se puede transcribir → llevar a la configuración.
  const { geminiKey } = await leerConfig();
  if (!geminiKey) {
    $("estado").innerHTML = t("pop.faltaClave");
    $("btnRec").textContent = t("pop.configurarAhora");
    $("btnRec").onclick = () => chrome.runtime.openOptionsPage();
    pintaHistorial(); // el historial se ve igual: puede haber reuniones esperando la clave
    return;
  }
  await revisaMicro();
  const { participantesBorrador } = await chrome.storage.session.get({ participantesBorrador: "" });
  $("participantes").value = participantesBorrador;
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  if (s && s.grabando) modoGrabando(s);
  else pintaObjetivo(s && s.objetivo);
  const { historial } = await chrome.storage.local.get({ historial: [] });
  if (historial[0]) ultimoIdVisto = ESTADOS_FINALES.includes(historial[0].estado) ? historial[0].id : null;
  pintaHistorial();
}

// Muestra qué pestaña se va a grabar y avisa si no está sonando.
function pintaObjetivo(obj) {
  const modo = document.querySelector(".modo input:checked").value;
  if (modo === "mic") { $("estado").textContent = t("pop.soloTuMicro"); return; }
  if (!obj) { $("estado").innerHTML = t("pop.sinPestanaAudio"); return; }
  const tit = obj.titulo.length > 34 ? obj.titulo.slice(0, 34) + "…" : obj.titulo;
  $("estado").innerHTML = obj.suena ? t("pop.seGrabara", esc(tit)) : t("pop.noSuena", esc(tit));
}
document.querySelectorAll(".modo input").forEach(r => r.addEventListener("change", async () => {
  pintaAvisoMic();
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  if (!s.grabando) pintaObjetivo(s.objetivo);
}));

$("btnRec").onclick = async () => {
  const grabando = $("btnRec").classList.contains("grabando");
  if (!grabando) {
    const modo = document.querySelector(".modo input:checked").value;
    $("estado").textContent = t("pop.arrancando");
    const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "start", modo, participantes: $("participantes").value.trim() });
    if (r && r.ok) refrescaGrabacion();
    else $("estado").textContent = "❌ " + ((r && r.error) || t("pop.noSePudoIniciar"));
  } else {
    await chrome.runtime.sendMessage({ target: "bg", cmd: "stop" });
    clearInterval(timerInt);
    $("btnRec").textContent = t("pop.empezar");
    $("btnRec").classList.remove("grabando");
    $("controles").style.display = "none";
    $("altavoz").style.display = "none";
    $("timer").classList.remove("pausa");
    $("estado").textContent = t("pop.transcribiendoEspera");
    $("participantes").value = "";
    $("participantes").disabled = false;
    chrome.storage.session.set({ participantesBorrador: "" });
    pintaHistorial();
  }
};

// «¿No oyes la reunión?»: cambia en vivo cómo vuelve la pestaña a los altavoces
// (reproductor de Chrome ↔ motor de audio). Lo elegido se recuerda.
$("btnAltavoz").onclick = async () => {
  $("estadoAltavoz").textContent = t("pop.altavozCambiando");
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "altavoz", accion: "cambiar" }).catch(() => null);
  $("estadoAltavoz").textContent = r && r.ok
    ? t("pop.altavozAhora", t(r.modo === "contexto" ? "pop.altavozContexto" : "pop.altavozAudio"))
    : t("pop.altavozNoGrabando");
};

// s: el estado de la sesión (t0, pausado, pausadoDesde, pausaMs). El reloj
// cuenta tiempo GRABADO: en pausa se para.
function modoGrabando(s) {
  $("btnRec").textContent = t("pop.parar");
  $("btnRec").classList.add("grabando");
  $("estado").textContent = s.pausado ? t("pop.enPausa") : t("pop.grabando");
  $("participantes").disabled = true;
  $("controles").style.display = "flex";
  // Solo con pestaña: en «Solo micro» no se devuelve nada a los altavoces.
  $("altavoz").style.display = s.ultimoModo === "tab_mic" ? "block" : "none";
  $("btnPausa").textContent = s.pausado ? t("pop.reanudar") : t("pop.pausar");
  $("timer").classList.toggle("pausa", !!s.pausado);
  clearInterval(timerInt);
  const pinta = () => {
    const ms = (s.pausado ? s.pausadoDesde : Date.now()) - s.t0 - (s.pausaMs || 0);
    $("timer").textContent = formatoTiempo(Math.max(0, ms) / 1000);
  };
  pinta();
  timerInt = setInterval(pinta, 500);
}
async function refrescaGrabacion() {
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  if (s && s.grabando) modoGrabando(s);
}

// ---------- Diagnóstico ----------
$("btnDiag").onclick = async () => {
  const out = $("diag");
  out.style.display = "block";
  const log = [];
  const escribe = (l) => { log.push(l); out.textContent = log.join("\n"); };
  escribe(t("pop.diagTitulo") + "\n");

  // 1. Configuración
  const cfg = await leerConfig();
  escribe(cfg.geminiKey ? t("pop.diagClaveOk", cfg.geminiKey.slice(0, 6)) : t("pop.diagClaveFalta"));
  escribe("   " + t("pop.diagModelo", cfg.geminiModel));

  // 2. La clave habla con Gemini
  if (cfg.geminiKey) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": cfg.geminiKey } });
      escribe(r.ok ? t("pop.diagGeminiOk") : t("pop.diagGeminiHttp", r.status));
    } catch (e) { escribe(t("pop.diagGeminiErr", e.message)); }
  }

  // 3. Permiso de micrófono (origen de la extensión)
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    escribe(p.state === "granted" ? t("pop.diagMicOk") : t("pop.diagMicNo", p.state.toUpperCase()));
  } catch (e) { escribe(t("pop.diagMicErr", e.message)); }

  // 4. Motor de grabación (offscreen) + captura real de 3 s
  escribe(t("pop.diagGrabador"));
  const modo = document.querySelector(".modo input:checked").value;
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "selftest", modo });
  if (!r || !r.ok) {
    escribe("   " + t("pop.diagFalla", (r && r.error) || t("pop.diagSinRespuesta")));
  } else {
    escribe("   " + t("pop.diagAudio", (r.bytes / 1024).toFixed(0), r.fuentes));
    if (r.niveles) escribe("   " + t("pop.diagNiveles", r.niveles));
    if (!r.bytes) escribe("   " + t("pop.diag0kb"));
    if (r.silencio) {
      escribe("   " + t("pop.diagSilencio"));
      escribe("      " + t("pop.diagSilencioConsejo"));
      escribe(t("pop.diagNoProbada1"));
      escribe("      " + t("pop.diagNoProbada2"));
    } else {
      escribe(r.transcripcion ? t("pop.diagTransOk") : t("pop.diagTransFalla"));
      if (r.transcripcion) escribe("   " + t("pop.diagTexto", r.transcripcion.slice(0, 90)));
      if (r.errorTranscripcion) escribe("   → " + r.errorTranscripcion.slice(0, 160));
    }
  }
  escribe("\n" + t("pop.diagCopia"));
};

// ---------- Historial ----------
// La transcripción, a la vista en el propio panel (3.5.2): la reunión más reciente
// sale abierta y las demás con «📄 Ver aquí», con su botón de copiar. La
// biblioteca sigue a un clic («Abrir»). Lo abierto se mantiene al repintar.
const abiertas = new Set();
let ultimaAbierta = null;

// Lo que se ve y se copia: el .md de la reunión con los nombres puestos o, si aún
// se está transcribiendo, lo que ya ha llegado de cada tramo.
function textoDelPanel(h) {
  const txt = (h.transcript && h.transcript.trim())
    ? h.transcript
    : (h.tramos || []).filter((tr) => tr && tr.estado === "ok").map((tr) => tr.texto || "").join("\n");
  return aplicarHablantes(txt, mapaVisible(txt, h.hablantes));
}

async function pintaHistorial() {
  const { historial } = await chrome.storage.local.get({ historial: [] });
  const cont = $("historial");
  cont.innerHTML = "";
  if (!historial.length) { cont.innerHTML = `<div style="font-size:11px;color:#999">${esc(t("pop.sinGrabaciones"))}</div>`; return; }
  // La más reciente con texto se abre sola, una vez: si el usuario la cierra, se queda cerrada.
  const primera = historial.find((h) => textoDelPanel(h).trim());
  if (primera && primera.id !== ultimaAbierta) { abiertas.add(primera.id); ultimaAbierta = primera.id; }
  for (const h of historial) {
    const div = document.createElement("div");
    div.className = "item";
    const badge = h.estado === "ok" ? `<span class="badge-estado ok">${esc(t("pop.badgeLista"))}</span>`
      : h.estado === "error" ? `<span class="badge-estado err">${esc(t("pop.badgeError"))}</span>`
      : h.estado === "pendiente" ? `<span class="badge-estado pend">${esc(t("pop.badgeIncompleta"))}</span>`
      : h.estado === "grabando" ? `<span class="badge-estado rec">${esc(t("pop.badgeGrabando"))}</span>`
      : `<span class="badge-estado proc">${esc(t("pop.badgeTranscribiendo", h.progreso || ""))}</span>`;
    const icono = h.origen === "archivo" ? "📂 " : "";
    div.innerHTML = `<div class="tit">${icono}${esc(h.titulo)} ${badge}</div><div class="fec">${esc(fechaVisible(h))}</div>` +
      (h.estado === "pendiente" ? `<div class="nota">${esc(notaPendiente(h))}</div>` : "") + '<div class="acc"></div>';
    const acc = div.querySelector(".acc");
    if (ESTADOS_FINALES.includes(h.estado)) {
      if (h.estado === "pendiente") boton(acc, t("pop.reintentarAhora"), (ev) => reintentar(ev.target, h));
      const nActas = Object.keys(h.analisis || {}).length;
      const actas = nActas ? " · " + t(nActas > 1 ? "pop.actasVarias" : "pop.actasUna", nActas) : "";
      boton(acc, h.estado === "error" ? t("pop.verError") : t("pop.abrir") + actas, () => abrirBiblioteca(h.id));
      boton(acc, "🗑", () => pideBorrar(acc, h));
    }
    const texto = textoDelPanel(h);
    if (texto.trim()) {
      const abierta = abiertas.has(h.id);
      boton(acc, abierta ? t("pop.ocultarTexto") : t("pop.verTexto"), () => {
        if (abierta) abiertas.delete(h.id); else abiertas.add(h.id);
        pintaHistorial();
      });
      if (abierta) {
        const caja = document.createElement("div");
        caja.className = "texto";
        const ta = document.createElement("textarea");
        ta.readOnly = true;
        ta.value = texto;
        const fila = document.createElement("div");
        fila.className = "acc";
        boton(fila, t("pop.copiar"), async (ev) => {
          await navigator.clipboard.writeText(ta.value);
          ev.target.textContent = t("pop.copiado");
        });
        caja.append(ta, fila);
        div.appendChild(caja);
      }
    }
    cont.appendChild(div);
  }
}
function boton(parent, txt, fn) { const b = document.createElement("button"); b.textContent = txt; b.onclick = fn; parent.appendChild(b); }

// Qué le falta a una reunión incompleta y qué va a pasar con ella, en una línea.
function notaPendiente(h) {
  const r = resumenTramos(h.tramos);
  const re = h.reintento || {};
  const codigo = ((h.tramos || []).find((t) => t.estado === "pendiente") || {}).codigo;
  let luego = t("pop.luegoSola");
  if (re.esperaClave) {
    luego = codigo === "sin_clave" ? t("pop.luegoSinClave") : t("pop.luegoClaveMala");
  } else if (re.agotado) {
    luego = t("pop.luegoAgotado");
  } else if (re.proximo) {
    const d = new Date(re.proximo);
    luego = t("pop.luegoALas", `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  }
  return r.total === 1 ? t("pop.notaUno", luego) : t("pop.notaVarios", r.pendientes, r.total, luego);
}

async function reintentar(btn, h) {
  btn.disabled = true;
  btn.textContent = t("pop.reintentando");
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "reintentar", id: h.id });
  if (!r || !r.ok) {
    btn.disabled = false;
    btn.textContent = t("pop.reintentarAhora");
    $("estado").textContent = "❌ " + ((r && r.error) || t("pop.noSePudoReintentar"));
  }
  // Si arranca, el historial se repinta solo con el progreso.
}

// Borrar es irreversible, así que siempre se pregunta primero — y el audio de
// respaldo se pregunta aparte, que es lo único que no se puede regenerar.
function pideBorrar(acc, h) {
  const nAudio = (h.filesAudio || []).length;
  acc.innerHTML = "";
  const caja = document.createElement("div");
  caja.style.cssText = "font-size:11px;line-height:1.45;background:#fdecef;border:1px solid #e6a9ba;color:#7d2d43;border-radius:6px;padding:7px 8px;width:100%";
  caja.innerHTML = t("pop.borrarUnaHtml")
    + (nAudio ? `<label style="display:block;margin-top:5px"><input type="checkbox" class="cbAudio" checked> ${esc(t(nAudio > 1 ? "pop.borrarAudioVarios" : "pop.borrarAudioUno", nAudio))}</label>` : "");
  const fila = document.createElement("div");
  fila.style.cssText = "display:flex;gap:4px;margin-top:6px";
  boton(fila, t("pop.siBorrar"), async () => {
    const cb = caja.querySelector(".cbAudio");
    await chrome.runtime.sendMessage({ target: "bg", cmd: "borrar", ids: [h.id], conAudio: !!(cb && cb.checked) });
    pintaHistorial();
  });
  boton(fila, t("pop.cancelar"), () => pintaHistorial());
  caja.appendChild(fila);
  acc.appendChild(caja);
}

$("btnBorrarTodo").onclick = async () => {
  const caja = $("confirmaTodo");
  if (caja.style.display === "block") { caja.style.display = "none"; return; }
  const { historial } = await chrome.storage.local.get({ historial: [] });
  if (!historial.length) return;
  const nAudio = historial.reduce((a, h) => a + (h.filesAudio || []).length, 0);
  caja.style.display = "block";
  caja.innerHTML = t("pop.borrarTodasHtml", historial.length)
    + (nAudio ? `<label style="display:block;margin-top:5px"><input type="checkbox" id="cbAudioTodo" checked> ${esc(t(nAudio > 1 ? "pop.borrarAudioTodoVarios" : "pop.borrarAudioTodoUno", nAudio))}</label>` : "");
  const fila = document.createElement("div");
  fila.style.cssText = "display:flex;gap:4px;margin-top:6px";
  boton(fila, t("pop.siBorrarTodo"), async () => {
    const cb = $("cbAudioTodo");
    const r = await chrome.runtime.sendMessage({
      target: "bg", cmd: "borrar", ids: historial.map((h) => h.id), conAudio: !!(cb && cb.checked),
    });
    caja.style.display = "none";
    pintaHistorial();
    $("estado").textContent = t("pop.borradas", r.entradas, r.ficheros);
  });
  boton(fila, t("pop.cancelar"), () => { caja.style.display = "none"; });
  caja.appendChild(fila);
};
function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
