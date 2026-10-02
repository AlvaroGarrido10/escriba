// Escriba — popup: grabar, y las últimas reuniones a mano.
//
// Tres estados, uno cada vez (3.6): sin configurar (falta la clave), listo para
// grabar y grabando. Lo de leer a fondo, exportar y sacar actas vive en la
// biblioteca; aquí la transcripción se ve y se copia sin salir del panel.

const $ = (id) => document.getElementById(id);
let timerInt = null, nivelesInt = null, ultimoIdVisto = null, sesion = null;

$("lnkOpc").onclick = () => chrome.runtime.openOptionsPage();
$("btnConfigurar").onclick = () => chrome.runtime.openOptionsPage();
const abrirBiblioteca = (id) => chrome.tabs.create({ url: "reuniones.html" + (id ? "#" + id : "") });
$("lnkBiblio").onclick = () => abrirBiblioteca();
$("btnVerTodas").onclick = () => abrirBiblioteca();
$("btnImportar").onclick = () => chrome.tabs.create({ url: "importar.html" });
$("btnArreglaMic").onclick = () => chrome.runtime.openOptionsPage();
const modoElegido = () => document.querySelector(".modo input:checked").value;

// La línea de estado de debajo del botón: icono según el tipo y el texto.
// `html` solo para textos nuestros de i18n (llevan <b>); el resto, escapado.
function estado(texto, tipo, { html = false, ic } = {}) {
  const el = $("estado");
  el.className = "linea-estado" + (tipo ? " " + tipo : "");
  const nombre = ic || (tipo ? iconoDeTipo(tipo) : null);
  el.dataset.ic = texto ? nombre || "" : "";
  if (!texto) { el.innerHTML = ""; return; }
  el.innerHTML = (nombre ? icono(nombre) : "") + `<span>${html ? texto : escapa(texto)}</span>`;
}

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
  if (!r || !r.ok) { estado((r && r.error) || t("pop.noSePudo"), "error"); return; }
  refrescaGrabacion();
};
$("btnMarca").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "marcar", nota: "" });
  if (r && r.ok) estado(t("pop.momentoMarcado", formatoTiempo(r.marca.t)), null, { ic: "estrella" });
  else estado((r && r.error) || t("pop.noSePudoMarcar"), "error");
};

// Recordatorio legal: grabar a otros sin avisarles no es buena idea (RGPD).
chrome.storage.sync.get({ avisoRgpdOculto: false }).then(({ avisoRgpdOculto }) => {
  $("avisoRgpd").hidden = !!avisoRgpdOculto;
});
$("ocultaRgpd").onclick = () => { chrome.storage.sync.set({ avisoRgpdOculto: true }); $("avisoRgpd").hidden = true; };

// El atajo puede haberlo cambiado el usuario en chrome://extensions/shortcuts.
// Se pinta desde init(), cuando ya se sabe el idioma.
function pintaAtajo() {
  if (!chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll().then((cs) => {
    const g = cs.find((c) => c.name === "grabar");
    if (g && g.shortcut) $("atajo").textContent = t("pop.atajo", g.shortcut);
  }).catch(() => {});
}

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
  $("avisoMicTxt").textContent = modoElegido() === "mic" ? t("pop.micModoMicNada") : t("pop.micSoloPestana");
  $("avisoMic").hidden = micOk || !!(sesion && sesion.grabando);
}

// Repintar en cuanto la transcripción termine (aunque el popup esté abierto).
// Se engancha desde init(), cuando ya se sabe el idioma.
function alCambiar(cambios, area) {
  if (area === "session" && (cambios.grabando || cambios.pausado)) { refrescaGrabacion(); return; }
  if (area !== "local" || !cambios.historial) return;
  const nuevos = cambios.historial.newValue || [];
  pintaHistorial();
  const ultimo = nuevos[0];
  // Mientras trocea y transcribe, ir cantando por dónde va.
  if (ultimo && ultimo.estado === "transcribiendo" && ultimo.progreso && !(sesion && sesion.grabando)) {
    estado(t("pop.transcribiendoProg", ultimo.progreso), null, { ic: "reloj" });
  }
  // Si la última grabación acaba de terminar, se avisa con un botón para abrirla.
  if (ultimo && ESTADOS_FINALES.includes(ultimo.estado) && ultimo.id !== ultimoIdVisto) {
    ultimoIdVisto = ultimo.id;
    avisaLista(ultimo);
  }
}

const ESTADOS_FINALES = ["ok", "pendiente", "error"];

function avisaLista(h) {
  const caja = $("listo");
  const tipo = h.estado === "ok" ? "ok" : h.estado === "pendiente" ? "atencion" : "error";
  const txt = h.estado === "ok" ? t("pop.listaOk") : h.estado === "pendiente" ? t("pop.listaPendiente") : t("pop.listaError");
  ponAviso(caja, tipo, `${escapa(txt)}: <b>${escapa(h.titulo)}</b>`);
  const b = botonUI({ texto: t("pop.abrirBiblio"), icono: "libro", clase: "btn-peq", alPulsar: () => abrirBiblioteca(h.id) });
  caja.querySelector(".cuerpo").appendChild(document.createElement("div")).appendChild(b);
  estado("");
}

init();
async function init() {
  // Antes de pintar nada: el idioma elegido en Opciones (traduce el HTML).
  await cargarIdiomaUI();
  pintaAtajo();
  chrome.storage.onChanged.addListener(alCambiar);
  // Lo que quedó pendiente se reintenta al abrir el popup, sin esperar a la
  // alarma (el service worker decide si ya toca). No se espera la respuesta.
  chrome.runtime.sendMessage({ target: "bg", cmd: "revisarPendientes" }).catch(() => {});
  const { historial } = await chrome.storage.local.get({ historial: [] });
  if (historial[0]) ultimoIdVisto = ESTADOS_FINALES.includes(historial[0].estado) ? historial[0].id : null;
  // Primer uso: sin clave no se puede transcribir → llevar a la configuración.
  // El historial se ve igual: puede haber reuniones esperando la clave.
  const { geminiKey } = await leerConfig();
  if (!geminiKey) {
    $("panelConfig").hidden = false;
    $("panelGrabar").hidden = true;
    pintaHistorial();
    return;
  }
  await revisaMicro();
  const { participantesBorrador } = await chrome.storage.session.get({ participantesBorrador: "" });
  $("participantes").value = participantesBorrador;
  await refrescaGrabacion();
  pintaHistorial();
}

// Qué pestaña se va a grabar y si está sonando.
function pintaObjetivo(obj) {
  const el = $("objetivo");
  el.className = "objetivo";
  if (modoElegido() === "mic") {
    el.innerHTML = icono("micro") + `<span class="txt">${escapa(t("pop.soloTuMicro"))}</span>`;
    return;
  }
  if (!obj) {
    el.classList.add("mudo");
    el.innerHTML = icono("alerta") + `<span class="txt">${t("pop.sinPestanaAudio")}</span>`;
    return;
  }
  const tit = escapa(obj.titulo.length > 60 ? obj.titulo.slice(0, 60) + "…" : obj.titulo);
  el.classList.add(obj.suena ? "suena" : "mudo");
  el.innerHTML = obj.suena
    ? icono("pestana") + `<span class="txt">${t("pop.seGrabara", tit)}</span><span class="ondas-vivas" aria-hidden="true"><i></i><i></i><i></i></span>`
    : icono("alerta") + `<span class="txt">${t("pop.noSuena", tit)}</span>`;
}
document.querySelectorAll(".modo input").forEach((r) => r.addEventListener("change", async () => {
  pintaAvisoMic();
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  if (!s.grabando) pintaObjetivo(s.objetivo);
}));

$("btnRec").onclick = async () => {
  const b = $("btnRec");
  if (b.disabled) return;
  b.disabled = true;
  try {
    if (!(sesion && sesion.grabando)) {
      estado(t("pop.arrancando"), null, { ic: "reloj" });
      const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "start", modo: modoElegido(), participantes: $("participantes").value.trim() });
      if (r && r.ok) { estado(""); await refrescaGrabacion(); }
      else estado((r && r.error) || t("pop.noSePudoIniciar"), "error");
    } else {
      await chrome.runtime.sendMessage({ target: "bg", cmd: "stop" });
      $("participantes").value = "";
      chrome.storage.session.set({ participantesBorrador: "" });
      await refrescaGrabacion();
      estado(t("pop.transcribiendoEspera"), null, { ic: "reloj" });
      pintaHistorial();
    }
  } finally {
    b.disabled = false;
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

function pintaBotonRec(grabando) {
  const b = $("btnRec");
  b.className = "btn btn-grande btn-bloque " + (grabando ? "btn-grabar" : "btn-primario");
  b.innerHTML = icono(grabando ? "parar" : "grabar") + `<span>${escapa(t(grabando ? "pop.parar" : "pop.empezar"))}</span>`;
}

// Pinta el estado de la sesión (t0, pausado, pausadoDesde, pausaMs). El reloj
// cuenta tiempo GRABADO: en pausa se para.
async function refrescaGrabacion() {
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" }).catch(() => null);
  sesion = s || { grabando: false };
  const grabando = !!sesion.grabando;
  $("preparar").hidden = grabando;
  $("enVivo").hidden = !grabando;
  $("enVivo").classList.toggle("pausa", grabando && !!sesion.pausado);
  // Solo con pestaña: en «Solo micro» no se devuelve nada a los altavoces.
  $("altavoz").hidden = !(grabando && sesion.ultimoModo === "tab_mic");
  pintaBotonRec(grabando);
  pintaAvisoMic();
  clearInterval(timerInt);
  clearInterval(nivelesInt);
  if (!grabando) {
    $("niveles").innerHTML = "";
    pintaObjetivo(sesion.objetivo);
    return;
  }
  $("estadoRec").textContent = sesion.pausado ? t("pop.enPausaCorto") : t("pop.grabando");
  $("queGraba").textContent = sesion.ultimoModo === "mic" ? t("pop.queGrabaMic")
    : sesion.tabTitle ? t("pop.queGraba", sesion.tabTitle) : t("pop.modoTabMic");
  $("btnPausa").innerHTML = icono(sesion.pausado ? "play" : "pausa") + `<span>${escapa(t(sesion.pausado ? "pop.reanudar" : "pop.pausar"))}</span>`;
  if (sesion.pausado) estado(t("pop.enPausa"), null, { ic: "pausa" });
  else if ($("estado").dataset.ic === "pausa") estado("");
  const pinta = () => {
    const ms = (sesion.pausado ? sesion.pausadoDesde : Date.now()) - sesion.t0 - (sesion.pausaMs || 0);
    $("timer").textContent = formatoTiempo(Math.max(0, ms) / 1000);
  };
  pinta();
  timerInt = setInterval(pinta, 500);
  pintaNiveles();
  nivelesInt = setInterval(pintaNiveles, 700);
}

// Lo que oye el grabador, fuente a fuente, como un vúmetro.
async function pintaNiveles() {
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "niveles" }).catch(() => null);
  if (!r || !r.ok || !r.id) return;
  $("niveles").innerHTML = (r.fuentes || []).map(htmlNivel).join("") +
    (r.sinMicro ? avisoHtml("atencion", escapa(t("viv.sinMicro")), "micro-no") : "");
}
// ---------- Diagnóstico ----------
$("diagCerrar").onclick = () => { $("diagCaja").hidden = true; };
$("diagCopiar").onclick = async () => {
  await navigator.clipboard.writeText($("diag").textContent);
  toast(t("pop.copiado"), "ok");
};
$("btnDiag").onclick = async () => {
  const out = $("diag");
  $("diagCaja").hidden = false;
  $("diagCaja").scrollIntoView({ block: "nearest" });
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
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "selftest", modo: modoElegido() });
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

// ---------- Recientes ----------
// La transcripción, a la vista en el propio panel (3.5.2): la reunión más
// reciente sale abierta, las demás se abren con un clic, y cada una tiene su
// botón de copiar. La biblioteca sigue a un clic. Lo abierto se mantiene al
// repintar.
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

// Lo que se LEE en el panel: solo lo hablado, sin la cabecera del .md (título,
// origen, participantes…), que sí va en lo que se copia.
function textoHablado(h) {
  const tramos = (h.tramos || []).filter((tr) => tr && tr.estado === "ok");
  if (tramos.length) {
    const txt = tramos.map((tr) => tr.texto || "").join("\n");
    return aplicarHablantes(txt, mapaVisible(txt, h.hablantes));
  }
  const md = textoDelPanel(h);
  const corte = md.indexOf("\n---\n");
  return corte >= 0 ? md.slice(corte + 5) : md;
}

// El texto con formato: hora atenuada y cada voz de su color.
function htmlTexto(texto) {
  const voces = [];
  return lineasTranscripcion(texto).filter((l) => l.texto || l.hablante).map((l) => {
    let quien = "";
    if (l.hablante) {
      if (!voces.includes(l.hablante)) voces.push(l.hablante);
      quien = `<span class="h" style="color:var(--voz-${voces.indexOf(l.hablante) % 8})">${escapa(l.hablante)}:</span>`;
    }
    const hora = l.t !== null ? `<span class="t">${formatoTiempo(l.t)}</span>` : "";
    return `<p class="ln">${hora}${quien}${escapa(l.texto)}</p>`;
  }).join("");
}

function pildora(h) {
  if (h.estado === "error") return `<span class="pildora err">${escapa(t("pop.badgeError"))}</span>`;
  if (h.estado === "pendiente") return `<span class="pildora pend">${escapa(t("pop.badgeIncompleta"))}</span>`;
  if (h.estado === "grabando") return `<span class="pildora rec"><span class="punto"></span>${escapa(t("pop.badgeGrabando"))}</span>`;
  if (h.estado === "transcribiendo") return `<span class="pildora proc"><span class="punto"></span>${escapa(t("pop.badgeTranscribiendo", h.progreso || ""))}</span>`;
  return "";
}

async function pintaHistorial() {
  const { historial } = await chrome.storage.local.get({ historial: [] });
  const cont = $("historial");
  cont.innerHTML = "";
  if (!historial.length) {
    cont.innerHTML = `<div class="sin-reuniones">${escapa(t("pop.sinGrabaciones"))}</div>`;
    return;
  }
  // La más reciente con texto se abre sola, una vez: si el usuario la cierra, se queda cerrada.
  const primera = historial.find((h) => textoDelPanel(h).trim());
  if (primera && primera.id !== ultimaAbierta) { abiertas.add(primera.id); ultimaAbierta = primera.id; }
  for (const h of historial.slice(0, 15)) cont.appendChild(tarjeta(h));
}

function tarjeta(h) {
  const div = document.createElement("div");
  const abierta = abiertas.has(h.id);
  div.className = "reu" + (abierta ? " abierta" : "");
  const nActas = Object.keys(h.analisis || {}).length;
  const sub = [fechaCorta(h)];
  if (h.meta && h.meta.minutos) sub.push(t("ui.minutos", h.meta.minutos));
  if (nActas) sub.push(t(nActas > 1 ? "pop.actasVarias" : "pop.actasUna", nActas));
  const cab = document.createElement("button");
  cab.className = "reu-cab";
  cab.setAttribute("aria-expanded", String(abierta));
  cab.innerHTML = `<span class="reu-icono">${icono(h.origen === "archivo" ? "archivo-audio" : "micro")}</span>` +
    `<span class="reu-info"><span class="reu-tit">${escapa(h.titulo || t("com.reunion"))}</span><span class="reu-sub">${escapa(sub.join(" · "))}</span></span>` +
    pildora(h) + icono("abajo");
  cab.title = abierta ? t("pop.ocultarTexto") : t("pop.mostrarTexto");
  cab.onclick = () => {
    if (abiertas.has(h.id)) abiertas.delete(h.id); else abiertas.add(h.id);
    pintaHistorial();
  };
  div.appendChild(cab);

  if (h.estado === "transcribiendo" && Array.isArray(h.tramos) && h.tramos.length) {
    const r = resumenTramos(h.tramos);
    const p = document.createElement("div");
    p.className = "progreso";
    p.innerHTML = `<div style="width:${Math.round(((r.total - r.pendientes) / r.total) * 100)}%"></div>`;
    div.appendChild(p);
  }
  if (!abierta) return div;

  const cuerpo = document.createElement("div");
  cuerpo.className = "reu-cuerpo";
  if (h.estado === "pendiente") {
    cuerpo.insertAdjacentHTML("beforeend", `<div class="reu-nota">${icono("alerta")}<span>${escapa(notaPendiente(h))}</span></div>`);
  }
  const texto = textoDelPanel(h);
  const caja = document.createElement("div");
  caja.className = "reu-texto";
  if (h.estado === "error") caja.innerHTML = `<p class="ln">${escapa((h.transcript || "").replace(/^[^\n]*\n+/, "").slice(0, 400) || t("pop.listaError"))}</p>`;
  else {
    const hablado = textoHablado(h);
    caja.innerHTML = hablado.trim() ? htmlTexto(hablado) : `<p class="vacio-t">${escapa(t("pop.sinTexto"))}</p>`;
  }
  cuerpo.appendChild(caja);

  const acc = document.createElement("div");
  acc.className = "reu-acc";
  if (texto.trim() && h.estado !== "error") {
    acc.appendChild(botonUI({ texto: t("pop.copiar"), icono: "copiar", clase: "btn-peq btn-primario", alPulsar: async (ev) => {
      const b = ev.currentTarget; // después del await ya no existe
      await navigator.clipboard.writeText(texto);
      b.innerHTML = icono("check") + `<span>${escapa(t("pop.copiado"))}</span>`;
      setTimeout(() => { b.innerHTML = icono("copiar") + `<span>${escapa(t("pop.copiar"))}</span>`; }, 1600);
    } }));
  }
  if (ESTADOS_FINALES.includes(h.estado)) {
    acc.appendChild(botonUI({ texto: h.estado === "error" ? t("pop.verError") : t("pop.abrirBiblio"), icono: "libro", clase: "btn-peq", alPulsar: () => abrirBiblioteca(h.id) }));
    // Lo que se usa poco o es delicado, en el menú «⋯».
    const menu = document.createElement("div");
    menu.className = "menu";
    const bMas = botonUI({ icono: "mas", clase: "btn-peq btn-icono btn-fantasma", titulo: t("pop.mas") });
    const lista = document.createElement("div");
    lista.className = "menu-lista arriba";
    lista.hidden = true;
    if (h.estado === "pendiente") {
      lista.appendChild(itemMenu({ texto: t("pop.reintentarAhora"), icono: "reintentar", alPulsar: () => reintentar(h) }));
    }
    lista.appendChild(itemMenu({ texto: t("pop.borrar"), icono: "borrar", peligro: true, alPulsar: () => pideBorrar(confirma, h) }));
    menu.append(bMas, lista);
    conMenu(bMas, lista);
    acc.appendChild(menu);
  }
  cuerpo.appendChild(acc);
  const confirma = document.createElement("div");
  confirma.hidden = true;
  cuerpo.appendChild(confirma);
  div.appendChild(cuerpo);
  return div;
}

// Qué le falta a una reunión incompleta y qué va a pasar con ella, en una línea.
function notaPendiente(h) {
  const r = resumenTramos(h.tramos);
  const re = h.reintento || {};
  const codigo = ((h.tramos || []).find((tr) => tr.estado === "pendiente") || {}).codigo;
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

async function reintentar(h) {
  estado(t("pop.reintentando"), null, { ic: "reintentar" });
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "reintentar", id: h.id });
  if (!r || !r.ok) estado((r && r.error) || t("pop.noSePudoReintentar"), "error");
  // Si arranca, el historial se repinta solo con el progreso.
}

// Borrar es irreversible, así que siempre se pregunta primero — y el audio de
// respaldo se pregunta aparte, que es lo único que no se puede regenerar.
async function pideBorrar(donde, h) {
  const nAudio = (h.filesAudio || []).length;
  const r = await confirmar(donde, {
    html: t("pop.borrarUnaHtml"),
    casilla: nAudio ? t(nAudio > 1 ? "pop.borrarAudioVarios" : "pop.borrarAudioUno", nAudio) : "",
    si: t("pop.siBorrar"), no: t("pop.cancelar"),
  });
  if (!r.si) return;
  abiertas.delete(h.id);
  await chrome.runtime.sendMessage({ target: "bg", cmd: "borrar", ids: [h.id], conAudio: r.casilla });
  pintaHistorial();
}

$("btnBorrarTodo").onclick = async () => {
  const caja = $("confirmaTodo");
  if (!caja.hidden) { caja.hidden = true; caja.innerHTML = ""; return; }
  const { historial } = await chrome.storage.local.get({ historial: [] });
  if (!historial.length) return;
  const nAudio = historial.reduce((a, h) => a + (h.filesAudio || []).length, 0);
  caja.scrollIntoView({ block: "nearest" });
  const r = await confirmar(caja, {
    html: t("pop.borrarTodasHtml", historial.length),
    casilla: nAudio ? t(nAudio > 1 ? "pop.borrarAudioTodoVarios" : "pop.borrarAudioTodoUno", nAudio) : "",
    si: t("pop.siBorrarTodo"), no: t("pop.cancelar"),
  });
  if (!r.si) return;
  const res = await chrome.runtime.sendMessage({ target: "bg", cmd: "borrar", ids: historial.map((h) => h.id), conAudio: r.casilla });
  pintaHistorial();
  toast(t("pop.borradas", res.entradas, res.ficheros), "ok");
};
