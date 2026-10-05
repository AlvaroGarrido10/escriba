// Escriba — biblioteca de reuniones: buscar, leer con formato, poner nombre a
// cada voz, exportar, sacar actas con plantillas y preguntar a la reunión.
//
// Lee el historial de chrome.storage.local pero NO escribe en él: todo cambio va
// al service worker (histEditar, histAnalisis, histChat), que es quien serializa
// las escrituras. Así una edición aquí no pisa el progreso de una transcripción
// que esté terminando a la vez.

const $ = (id) => document.getElementById(id);
// Los proveedores salen del registro (proveedores.js). Aquí no puede declararse
// otro PROVEEDORES: los scripts de una página comparten los nombres de primer
// nivel, y repetir uno deja este fichero entero sin ejecutar.
const nombreProv = (p) => (provDe(p) || { etiqueta: p }).etiqueta;
// Icono de cada plantilla de acta (las plantillas viven en ia.js).
const ICONO_PLANTILLA = { acta: "documento", resumen: "lineas", tareas: "tareas", correo: "correo", personalizada: "varita" };
// Qué saca cada plantilla, para las tarjetas de «Acta y resúmenes» cuando aún no hay ninguna.
const DESC_PLANTILLA = {
  acta: () => t("bib.plant_desc_acta"), resumen: () => t("bib.plant_desc_resumen"), tareas: () => t("bib.plant_desc_tareas"),
  correo: () => t("bib.plant_desc_correo"), personalizada: () => t("bib.plant_desc_personalizada"),
};

let historial = [], actual = null, cfg = {}, filtro = "", actaSel = null, marcaActual = -1, generando = false, preguntando = null;
let conAudio = new Set();   // tramos de la reunión abierta que se pueden oír
let audioConservado = false; // alguno es audio conservado para escuchar, que se puede borrar
let sonando = null;         // { tramo, inicioS } del audio cargado en el reproductor

const aBgMsg = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
const escT = escapa;
const normaliza = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
// Los mensajes de progreso de ia.js llegan con un emoji delante; aquí el icono lo pone ponEstado.
const sinEmoji = (s) => String(s || "").replace(/^(?:[\p{Extended_Pictographic}\u{FE0F}]\s*)+/u, "");

// Expresión que encuentra el texto buscado sin distinguir mayúsculas ni tildes.
function reBusqueda(q) {
  const clases = { a: "aáàäâ", e: "eéèëê", i: "iíìïî", o: "oóòöô", u: "uúùüû", n: "nñ", c: "cç" };
  const patron = [...normaliza(q)].map((ch) => (clases[ch] ? `[${clases[ch]}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return patron ? new RegExp(patron, "gi") : null;
}
// Resalta sobre texto YA escapado: la búsqueda nunca mete HTML.
const resalta = (html, re) => (re ? html.replace(re, (m) => `<mark>${m}</mark>`) : html);

// ---------------------------------------------------------------------------------
// carga y sincronización
(async function init() {
  await cargarIdiomaUI(); // antes de pintar nada: todo lo que sigue sale ya en su idioma
  pintaVelocidades();
  cfg = await leerConfig();
  historial = (await chrome.storage.local.get({ historial: [] })).historial;
  pintaSelectores();
  const id = Number(location.hash.slice(1));
  abrir(historial.find((h) => h.id === id) ? id : (historial[0] && historial[0].id), false);
})();

chrome.storage.onChanged.addListener(async (cambios, area) => {
  if (area === "local" && cambios.historial) {
    historial = cambios.historial.newValue || [];
    if (actual) {
      actual = historial.find((h) => h.id === actual.id) || null;
      // Borrada mientras sonaba (desde aquí, el popup u otra pestaña): se calla.
      if (!actual) paraAudio();
    }
    pintaLista();
    pintaVista();
    // El audio cambia de sitio con el texto: el de un tramo recién transcrito se
    // borra o pasa a «escucha».
    if (actual) miraAudio();
  } else if (area === "local" || area === "sync") {
    // Cambiaron el idioma en Opciones con la biblioteca abierta: se traduce sin recargar.
    const otroIdioma = area === "sync" && !!cambios.idiomaUI;
    if (otroIdioma) { await cargarIdiomaUI(); pintaVelocidades(); }
    cfg = await leerConfig();
    pintaSelectores();
    if (cambios.precios || otroIdioma) { pintaLista(); pintaVista(); }
    if (otroIdioma && actual && !$("reproductor").hidden) pintaRepInfo();
  }
});

// Las velocidades del reproductor con la coma o el punto decimal del idioma.
function pintaVelocidades() {
  for (const o of $("velocidad").options) o.textContent = Number(o.value).toLocaleString(LOCALE_UI()) + "×";
}

window.addEventListener("hashchange", () => {
  const id = Number(location.hash.slice(1));
  if (id && (!actual || actual.id !== id)) abrir(id, false);
});

$("btnImportar").onclick = () => chrome.tabs.create({ url: "importar.html" });
$("btnOpciones").onclick = () => chrome.runtime.openOptionsPage();
$("buscar").addEventListener("input", () => { filtro = $("buscar").value; pintaLista(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    if (estrecho.matches) muestraLista(true);
    $("buscar").focus();
  }
  if (e.key === "Escape") muestraLista(false);
});

// En pantallas estrechas la lista es un cajón que se abre con el botón de la barra.
const estrecho = window.matchMedia("(max-width: 980px)");
function muestraLista(si) {
  document.body.classList.toggle("con-lista", !!si && estrecho.matches);
  $("velo").hidden = !(si && estrecho.matches);
}
$("btnLista").onclick = () => muestraLista(!document.body.classList.contains("con-lista"));
$("velo").onclick = () => muestraLista(false);
estrecho.addEventListener("change", () => muestraLista(false));

// ---------------------------------------------------------------------------------
// lista de reuniones
function textoDe(h) {
  if (Array.isArray(h.tramos) && h.tramos.length) {
    const crudo = h.tramos.filter((tr) => tr.estado === "ok").map((tr) => tr.texto || "").join("\n");
    return aplicarHablantes(crudo, mapaVisible(crudo, h.hablantes));
  }
  return h.transcript || "";
}

// Solo lo que pide atención lleva etiqueta: si todas dijeran «lista», no destacaría nada.
function pildora(h, siempre) {
  // Grabada sin clave (3.8): ni «incompleta» ni en ámbar. Está guardada.
  if (sinTranscribir(h)) return `<span class="pildora">${escT(t("bib.estado_sin_transcribir"))}</span>`;
  // Sin con quién transcribir, lo que se está haciendo al cerrar es guardar el audio (3.8.1).
  const enCurso = proveedorVoz(cfg || {}) ? t("bib.estado_transcribiendo", h.progreso || "") : t("bib.estado_guardando");
  const b = {
    ok: ["ok", t("bib.estado_ok")], error: ["err", t("bib.estado_error")],
    pendiente: ["pend", t("bib.estado_pendiente")], grabando: ["rec", t("bib.estado_grabando")],
  }[h.estado] || ["proc", enCurso];
  if (h.estado === "ok" && !siempre) return "";
  const punto = b[0] === "rec" || b[0] === "proc" ? '<span class="punto"></span>' : "";
  return `<span class="pildora ${b[0]}">${punto}${escT(b[1])}</span>`;
}

// La hora dentro de su grupo: hoy y ayer basta la hora; esta semana, el día de
// la semana; más atrás, el día y el mes.
function cuandoEnLista(h, grupo) {
  if (typeof h.id !== "number" || h.id < 1e12) return h.fecha || "";
  const d = new Date(h.id);
  const hora = d.toLocaleTimeString(LOCALE_UI(), { hour: "2-digit", minute: "2-digit" });
  if (grupo === "hoy" || grupo === "ayer") return hora;
  if (grupo === "semana") return d.toLocaleDateString(LOCALE_UI(), { weekday: "long" }) + ", " + hora;
  return d.toLocaleDateString(LOCALE_UI(), { day: "numeric", month: "short" }) + ", " + hora;
}

function pintaLista() {
  const cont = $("lista");
  const re = reBusqueda(filtro.trim());
  const q = normaliza(filtro.trim());
  const visibles = historial.filter((h) => !q || normaliza([h.titulo, h.participantes, h.fecha, textoDe(h)].join("\n")).includes(q));
  pintaPieLista();
  if (!historial.length) {
    cont.innerHTML = `<div class="sinResultados">${escT(t("bib.lista_vacia"))}</div>`;
    return;
  }
  if (!visibles.length) { cont.innerHTML = `<div class="sinResultados">${escT(t("bib.nada_coincide", filtro))}</div>`; return; }
  let grupoPrevio = null;
  cont.innerHTML = visibles.map((h) => {
    const g = grupoDeFecha(h);
    const cab = g.clave !== grupoPrevio ? `<div class="grupo">${escT(g.nombre)}</div>` : "";
    grupoPrevio = g.clave;
    let extracto = "";
    if (q) {
      const texto = textoDe(h), pos = normaliza(texto).indexOf(q);
      if (pos >= 0) {
        const desde = Math.max(0, pos - 40);
        extracto = `<div class="extracto">…${resalta(escT(texto.slice(desde, pos + q.length + 60)), re)}…</div>`;
      }
    }
    const sub = [escT(cuandoEnLista(h, g.clave))];
    if (h.meta && h.meta.minutos) sub.push(escT(t("ui.minutos", h.meta.minutos)));
    const nActas = Object.keys(h.analisis || {}).length;
    if (nActas) sub.push(escT(t(nActas > 1 ? "pop.actasVarias" : "pop.actasUna", nActas)));
    return `${cab}<button class="item${actual && actual.id === h.id ? " activa" : ""}" data-id="${h.id}">
      <span class="item-icono">${icono(h.origen === "archivo" ? "archivo-audio" : "micro")}</span>
      <span class="item-info"><span class="tit">${q ? resalta(escT(h.titulo || t("com.reunion")), re) : escT(h.titulo || t("com.reunion"))}</span>
      <span class="sub">${sub.join(" · ")} ${pildora(h)}</span>${extracto}</span></button>`;
  }).join("");
  cont.querySelectorAll(".item").forEach((el) => {
    el.onclick = () => { abrir(Number(el.dataset.id), true); muestraLista(false); };
  });
}

// Lo que llevas gastado este mes con tus claves. Sin precios no se adivina: se
// ofrece ponerlos, y solo si hay alguna reunión con gasto apuntado (tokens o, en
// la voz que se cobra por tiempo, segundos).
function pintaPieLista() {
  const pie = $("pieLista");
  const m = costeMes(historial, cfg.precios);
  const mes = new Date().toLocaleDateString(LOCALE_UI(), { month: "long" });
  if (m.euros !== null) {
    const falta = m.faltan.length ? ` <span title="${escT(t("bib.sin_precio_title", m.faltan.map(nombreProv).join(", ")))}">${escT(t("bib.sin_precio_corto"))}</span>` : "";
    const n = m.reuniones === 1 ? t("bib.n_reunion", m.reuniones) : t("bib.n_reuniones", m.reuniones);
    pie.innerHTML = `${icono("euro")}<span title="${escT(t("bib.estimacion_title"))}">${escT(mes.charAt(0).toUpperCase() + mes.slice(1))}: ≈ ${escT(formatoEuros(m.euros))}${falta} · ${escT(n)}</span>`;
  } else if (historial.some((h) => { const c = costeReunion(h, {}); return c.tokens || c.segundos; })) {
    pie.innerHTML = `${icono("euro")}<span>${t("bib.pon_precios_html")}</span>`;
  } else pie.innerHTML = "";
  const enlace = pie.querySelector("a");
  if (enlace) enlace.onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
}

function abrir(id, empujar) {
  actual = historial.find((h) => h.id === id) || null;
  actaSel = null;
  marcaActual = -1;
  if (actual) {
    if (empujar) history.pushState(null, "", "#" + id); else history.replaceState(null, "", "#" + id);
  }
  $("buscarEn").value = "";
  $("estadoActa").innerHTML = "";
  $("estadoChat").innerHTML = "";
  $("confirmaBorrar").hidden = true;
  paraAudio();
  // Lo que se podía oír era de la reunión anterior: hasta que miraAudio diga lo de esta, nada.
  conAudio = new Set();
  audioConservado = false;
  pintaLista();
  pintaVista(true);
  miraAudio();
  $("vista").scrollTop = 0;
}

// --- escuchar (3.4) ---
// El audio conservado vive en IndexedDB («escucha»), por tramos. Pulsar la marca
// de tiempo de una frase carga su tramo y salta a ese segundo.
// Desde la 3.8 se oye también el audio que sigue pendiente de transcribir (el
// almacén «audios»): es lo único que hay de una reunión grabada sin clave. De
// ahí solo se lee; ese audio hace falta para transcribirla.
async function miraAudio() {
  const id = actual && actual.id;
  const oibles = new Set();
  let conservado = false;
  if (id && typeof audios !== "undefined" && audios && audios.clavesEscucha) {
    try {
      for (const [r, i] of await audios.clavesEscucha()) if (r === id) { oibles.add(i); conservado = true; }
      // Mientras se graba no: lo que sonara aquí se colaría por el micrófono.
      if (actual && actual.id === id && actual.estado !== "grabando") {
        for (const [r, i] of await audios.claves()) if (r === id) oibles.add(i);
      }
    } catch (_) { /* sin IndexedDB no hay reproductor; el resto funciona */ }
  }
  if (!actual || actual.id !== id) return;
  conAudio = oibles;
  audioConservado = conservado;
  $("reproductor").hidden = !conAudio.size && !sonando;
  $("quitarAudio").hidden = !audioConservado;
  if (conAudio.size) pintaRepInfo();
  pintaAviso();
  pintaTexto();
}

// El audio de un tramo: el conservado o, si no, el que espera a transcribirse.
async function audioDe(id, tramo) {
  const conservado = await audios.leerEscucha(id, tramo).catch(() => null);
  return conservado || audios.leer(id, tramo).catch(() => null);
}

function pintaRepInfo() {
  // Una reunión sin transcribir no tiene frases que pulsar: se oye con
  // «Escuchar» o desde la hora de cada tramo.
  const conFrases = (actual.tramos || []).some((tr, i) => tr && tr.estado === "ok" && conAudio.has(i));
  $("repInfo").textContent = sonando
    ? t("bib.rep_tramo", sonando.tramo + 1, actual.tramos.length)
    : conFrases ? t("bib.rep_pulsa") : t("bib.rep_sin_frases");
}

function paraAudio() {
  const a = $("audio");
  a.pause();
  if (a.src) URL.revokeObjectURL(a.src);
  a.removeAttribute("src");
  sonando = null;
  document.querySelectorAll(".l.sonando").forEach((l) => l.classList.remove("sonando"));
}

async function suena(tramo, desdeS) {
  const id = actual.id, tr = (actual.tramos || [])[tramo];
  const blob = await audioDe(id, tramo);
  if (!actual || actual.id !== id) return; // mientras se leía, se abrió otra reunión
  if (!blob) { toast(t("bib.audio_no_guardado"), "atencion"); return; }
  paraAudio();
  const a = $("audio");
  sonando = { tramo, inicioS: inicioTramo(tr, tramo) };
  a.src = URL.createObjectURL(blob);
  a.playbackRate = Number($("velocidad").value) || 1;
  a.onloadedmetadata = () => {
    a.currentTime = Math.max(0, desdeS - sonando.inicioS - 1); // un segundo antes, para no cortar la frase
    a.play().catch(() => {});
  };
  pintaRepInfo();
}

$("audio").addEventListener("timeupdate", () => {
  if (!sonando) return;
  const ahora = sonando.inicioS + $("audio").currentTime;
  let actualL = null;
  for (const l of $("texto").querySelectorAll(`.l[data-tramo="${sonando.tramo}"][data-t]`)) {
    if (Number(l.dataset.t) <= ahora + 0.5) actualL = l; else break;
  }
  document.querySelectorAll(".l.sonando").forEach((l) => { if (l !== actualL) l.classList.remove("sonando"); });
  if (actualL && !actualL.classList.contains("sonando")) {
    actualL.classList.add("sonando");
    actualL.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});
// Al acabar un tramo sigue con el siguiente que tenga audio, como si fuera uno
// solo (de un tramo sin voz en medio no se guarda nada: se salta).
$("audio").addEventListener("ended", () => {
  if (!sonando || !actual) return;
  const sig = [...conAudio].filter((i) => i > sonando.tramo).sort((a, b) => a - b)[0];
  if (sig !== undefined) suena(sig, inicioTramo(actual.tramos[sig], sig));
});
// «Escuchar»: desde el primer tramo con audio. Es la forma de oír una reunión
// grabada sin clave, que no tiene frases con su hora que pulsar (3.8).
$("btnEscuchar").onclick = () => {
  if (!actual) return;
  // El reproductor sigue a la vista mientras suena algo, aunque el audio ya se
  // haya borrado (acaba de transcribirse): entonces no queda nada que empezar.
  if (!conAudio.size) { toast(t("bib.audio_no_guardado"), "atencion"); return; }
  const primero = Math.min(...conAudio);
  suena(primero, inicioTramo((actual.tramos || [])[primero], primero));
};
$("velocidad").addEventListener("change", () => { $("audio").playbackRate = Number($("velocidad").value) || 1; });
$("quitarAudio").onclick = async () => {
  if (!actual) return;
  paraAudio();
  await audios.borrarEscucha(actual.id).catch(() => {});
  toast(t("bib.audio_borrado"), "ok");
  miraAudio();
};

// ---------------------------------------------------------------------------------
// una reunión
function pintaVista(nueva) {
  $("vacio").hidden = !!actual;
  $("reunion").hidden = !actual;
  if (!actual) { document.title = t("bib.titulo_pagina"); return; }
  const h = actual;
  // Un campo que el usuario está escribiendo no se repinta: se le borraría lo tecleado.
  if (nueva || document.activeElement !== $("titulo")) $("titulo").value = h.titulo || t("com.reunion");
  if (nueva || document.activeElement !== $("participantes")) $("participantes").value = h.participantes || "";
  document.title = (h.titulo || t("com.reunion")) + " — Escriba";

  const tokens = sumaTokens(h);
  const coste = costeReunion(h, cfg.precios);
  const sinPrecio = coste.faltan.length ? ` (${t("bib.sin_precio_min", coste.faltan.map(nombreProv).join(", "))})` : "";
  $("meta").innerHTML = [
    `<span>${icono("calendario")}${escT(fechaVisible(h))}</span>`,
    h.meta && h.meta.minutos ? `<span>${icono("reloj")}${escT(t("ui.minutos", h.meta.minutos))}</span>` : "",
    `<span>${icono(h.origen === "archivo" ? "archivo-audio" : "micro")}${escT(h.origen === "archivo" ? t("bib.origen_archivo") : t("bib.origen_grabacion"))}</span>`,
    tokens ? `<span title="${escT(t("bib.tokens_title"))}">${icono("chispas")}≈ ${tokens.toLocaleString(LOCALE_UI())} tokens</span>` : "",
    coste.euros !== null ? `<span title="${escT(t("bib.estimacion_title") + sinPrecio)}">${icono("euro")}≈ ${escT(formatoEuros(coste.euros))}${coste.faltan.length ? " +" : ""}</span>` : "",
    pildora(h, false),
  ].filter(Boolean).join("");

  pintaAviso();
  // Lo que espera una clave que sigue sin estar no tiene nada que reintentar.
  $("btnReintentar").hidden = h.estado !== "pendiente" || (sinTranscribir(h) && !proveedorVoz(cfg));
  const nActas = Object.keys(h.analisis || {}).length, nChat = (h.chat || []).length;
  $("nActas").hidden = !nActas; $("nActas").textContent = nActas;
  $("nChat").hidden = !nChat; $("nChat").textContent = nChat;
  pintaNotas(nueva);
  pintaHablantes();
  pintaTexto();
  pintaActas();
  pintaChat();
}

function sumaTokens(h) {
  let n = 0;
  for (const tr of h.tramos || []) if (tr.uso) n += (tr.uso.entrada || 0) + (tr.uso.salida || 0);
  for (const u of h.usoIA || []) n += (u.entrada || 0) + (u.salida || 0);
  return n;
}

function pintaAviso() {
  const h = actual, a = $("aviso");
  a.hidden = true;
  if (sinTranscribir(h)) {
    // Grabada sin clave (3.8): no ha fallado nada. Se dice qué es, qué hace falta
    // para transcribirla y cómo oírla mientras tanto; en neutro, no en ámbar.
    const oir = conAudio.size ? t("bib.aviso_escuchar") : (h.filesAudio || []).length ? t("bib.aviso_audio_descargas") : "";
    ponAviso(a, "", t("bib.aviso_sin_clave_html") + (oir ? " " + escT(oir) : ""), "llave");
    const enlace = a.querySelector("a");
    if (enlace) enlace.onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  } else if (h.estado === "pendiente") {
    const r = resumenTramos(h.tramos);
    ponAviso(a, "atencion", escT(t("bib.aviso_pendiente", r.pendientes, r.total)), "reloj");
  } else if (h.estado === "grabando") {
    ponAviso(a, "error", escT(t("bib.aviso_grabando")), "grabar");
  } else if (h.estado === "transcribiendo") {
    ponAviso(a, "", escT(proveedorVoz(cfg || {}) ? t("bib.aviso_transcribiendo", h.progreso || "") : t("bib.aviso_guardando")), "reloj");
  } else if (h.errorActa) {
    ponAviso(a, "atencion", escT(t("bib.aviso_error_acta", h.errorActa)));
  }
}

// --- hablantes ---
function textoCrudo(h) {
  return (h.tramos || []).filter((tr) => tr.estado === "ok").map((tr) => tr.texto || "").join("\n");
}
function etiquetasOriginales(h) {
  return Array.isArray(h.tramos) && h.tramos.length ? hablantesDe(textoCrudo(h)) : hablantesDe(h.transcript || "");
}
// El color de cada voz es un token del tema (--voz-0…7): se ve bien en claro y en oscuro.
const colorVoz = (orig, lista) => `var(--voz-${Math.max(0, lista.indexOf(orig)) % 8})`;

function pintaHablantes() {
  const h = actual, cont = $("hablantes");
  if (cont.querySelector("input")) return; // renombrando: no se toca
  const etiquetas = Array.isArray(h.tramos) && h.tramos.length ? etiquetasOriginales(h) : [];
  if (!etiquetas.length) { cont.innerHTML = `<p class="ayudaH">${escT(t("bib.sin_hablantes"))}</p>`; return; }
  const mapa = h.hablantes || {}, auto = mapaVisible(textoCrudo(h), {});
  cont.innerHTML = etiquetas.map((o) => {
    const nuevo = (mapa[o] || "").trim(), visible = auto[o] || o, nombre = nuevo || visible;
    return `<button class="chipH" data-h="${escT(o)}" title="${escT(t("bib.renombrar_title"))}">` +
      `<span class="avatar" style="--c:${colorVoz(o, etiquetas)}">${escT(inicialDe(nombre))}</span>` +
      `<span class="nom">${escT(nombre)}${nuevo ? `<span class="orig">${escT(visible)}</span>` : ""}</span>${icono("lapiz")}</button>`;
  }).join("") + `<p class="ayudaH">${escT(t("bib.renombrar_ayuda"))}</p>`;
  cont.querySelectorAll(".chipH").forEach((chip) => { chip.onclick = () => renombrar(chip); });
}

function renombrar(chip) {
  const orig = chip.dataset.h, mapa = { ...(actual.hablantes || {}) };
  const sugeridos = (actual.participantes || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const avatar = chip.querySelector(".avatar").outerHTML;
  chip.innerHTML = avatar + `<input class="campo" value="${escT(mapa[orig] || "")}" placeholder="${escT(mapaVisible(textoCrudo(actual), {})[orig] || orig)}" list="listaNombres">` +
    `<datalist id="listaNombres">${sugeridos.map((s) => `<option value="${escT(s)}">`).join("")}</datalist>`;
  chip.onclick = null;
  const input = chip.querySelector("input");
  input.onclick = (e) => e.stopPropagation();
  input.focus();
  let hecho = false;
  const guardar = async (confirmar) => {
    if (hecho) return;
    hecho = true;
    if (confirmar) {
      const v = input.value.trim();
      if (v && v !== orig) mapa[orig] = v; else delete mapa[orig];
      actual.hablantes = mapa;
      chip.innerHTML = "";
      await editar({ hablantes: mapa });
    }
    $("hablantes").innerHTML = "";
    pintaHablantes();
    pintaTexto();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); guardar(true); }
    if (e.key === "Escape") { e.stopPropagation(); guardar(false); }
  };
  input.onblur = () => guardar(true);
}

async function editar(cambios) {
  const r = await aBgMsg("histEditar", { id: actual.id, cambios });
  if (!r || !r.ok) toast((r && r.error) || t("bib.no_se_pudo_guardar_punto"), "error");
  return r;
}

$("titulo").addEventListener("keydown", (e) => { if (e.key === "Enter") $("titulo").blur(); });
$("titulo").addEventListener("change", () => {
  const v = $("titulo").value.trim();
  if (actual && v && v !== actual.titulo) editar({ titulo: v });
});
$("participantes").addEventListener("keydown", (e) => { if (e.key === "Enter") $("participantes").blur(); });
$("participantes").addEventListener("change", () => {
  if (actual) editar({ participantes: $("participantes").value.trim() });
});

// --- transcripción ---
// Líneas a pintar: las del texto de cada tramo, con avisos donde falta un tramo.
function lineasDeVista(h) {
  if (!Array.isArray(h.tramos) || !h.tramos.length) {
    return lineasTranscripcion(h.transcript || "").map((l) => ({ tipo: "l", ...l, orig: l.hablante }));
  }
  const mapa = mapaVisible(textoCrudo(h), h.hablantes), out = [], total = h.tramos.length;
  h.tramos.forEach((tr, i) => {
    const cab = t("bib.tramo_cab", i + 1, total, tr.etiqueta || etiquetaTramo(i));
    if (tr.estado === "ok") {
      for (const l of lineasTranscripcion(tr.texto || "")) {
        out.push({ tipo: "l", ...l, tramo: i, orig: l.hablante, hablante: (mapa[l.hablante] || "").trim() || l.hablante });
      }
      if (tr.truncado) out.push({ tipo: "aviso", texto: t("bib.tramo_truncado", cab) });
    } else if (tr.estado === "mudo") out.push({ tipo: "mudo", texto: t("bib.tramo_mudo", cab) });
    else if (tr.estado === "perdido") out.push({ tipo: "aviso", texto: `${cab}: ${textoError("perdido")}` });
    // Lo pendiente lleva su tramo y dónde empieza: si su audio sigue guardado, se
    // puede oír desde ahí (3.8). El que solo espera una clave no es un aviso.
    else if (tr.codigo === "sin_clave") out.push({ tipo: "guardado", texto: t("bib.tramo_sin_clave", cab), tramo: i, t: inicioTramo(tr, i) });
    else out.push({ tipo: "aviso", texto: t("bib.tramo_pendiente", cab, tr.error || ""), tramo: i, t: inicioTramo(tr, i) });
  });
  return out;
}

// Las intervenciones seguidas de la misma voz van juntas, bajo un solo
// encabezado (círculo de color, nombre y hora): así se ve dónde cambia quien habla.
function pintaTexto() {
  const h = actual, cont = $("texto");
  if (h.estado === "error" || (!Array.isArray(h.tramos) && !h.transcript)) {
    cont.innerHTML = `<div class="md">${mdAHtml(h.transcript || t("bib.sin_texto"))}</div>`;
    $("nCoinc").textContent = "";
    $("coincAnt").hidden = $("coincSig").hidden = true;
    return;
  }
  const re = reBusqueda($("buscarEn").value.trim());
  const etiquetas = etiquetasOriginales(h);
  let n = 0, html = "", turno = null;
  const marca = (s) => (re ? s.replace(re, (m) => { n++; return `<mark>${m}</mark>`; }) : s);
  const cierra = () => { if (turno) { html += turno + "</div></div>"; turno = null; } };
  let quienPrevio = undefined;
  for (const l of lineasDeVista(h)) {
    if (l.tipo === "aviso" || l.tipo === "mudo" || l.tipo === "guardado") {
      cierra(); quienPrevio = undefined;
      // Un tramo sin transcribir cuyo audio sigue guardado se oye desde su hora,
      // igual que una frase.
      const oible = typeof l.tramo === "number" && conAudio.has(l.tramo);
      html += `<div class="l ${l.tipo === "aviso" ? "aviso-l" : l.tipo === "mudo" ? "mudo-l" : "guardado-l"}"${oible ? ` data-t="${l.t}" data-tramo="${l.tramo}"` : ""}>` +
        icono(l.tipo === "aviso" ? "alerta" : l.tipo === "mudo" ? "micro-no" : "archivo-audio") +
        (oible ? `<span class="t play" title="${escT(t("bib.escuchar_title"))}">${formatoTiempo(l.t)}</span>` : "") +
        `<span>${escT(l.texto)}</span></div>`;
      continue;
    }
    const escuchable = l.t !== null && typeof l.tramo === "number" && conAudio.has(l.tramo);
    const hora = l.t !== null ? `<span class="t${escuchable ? " play" : ""}"${escuchable ? ` title="${escT(t("bib.escuchar_title"))}"` : ""}>${formatoTiempo(l.t)}</span>` : "";
    const quien = l.hablante || "";
    if (quien !== quienPrevio || !turno) {
      cierra();
      quienPrevio = quien;
      const color = quien ? colorVoz(l.orig, etiquetas) : "var(--texto-3)";
      turno = `<div class="turno" style="--c:${color}">` +
        (quien ? `<span class="avatar">${escT(inicialDe(quien))}</span>` : "<span></span>") +
        `<div class="frases">` + (quien ? `<div class="turno-cab"><span class="h">${marca(escT(quien))}</span></div>` : "");
    }
    turno += `<p class="l"${l.t !== null ? ` data-t="${l.t}"` : ""}${typeof l.tramo === "number" ? ` data-tramo="${l.tramo}"` : ""}>${hora}${marca(escT(l.texto))}</p>`;
  }
  cierra();
  cont.innerHTML = html || `<div class="l mudo-l">${icono("reloj")}<span>${escT(t("bib.sin_texto_aun"))}</span></div>`;
  cont.querySelectorAll(".t.play").forEach((el) => {
    el.onclick = () => { const l = el.closest(".l"); suena(Number(l.dataset.tramo), Number(l.dataset.t)); };
  });
  $("nCoinc").textContent = re ? (n === 1 ? t("bib.n_coincidencia", n) : n ? t("bib.n_coincidencias", n) : t("bib.sin_coincidencias")) : "";
  $("coincAnt").hidden = $("coincSig").hidden = !(re && n);
}

// Salta a la coincidencia siguiente (o anterior) y la marca como la actual.
function irACoincidencia(paso) {
  const marcas = [...$("texto").querySelectorAll("mark")];
  if (!marcas.length) return;
  marcas.forEach((m) => m.classList.remove("actual"));
  marcaActual = (marcaActual + paso + marcas.length) % marcas.length;
  marcas[marcaActual].classList.add("actual");
  marcas[marcaActual].scrollIntoView({ block: "center", behavior: "smooth" });
  $("nCoinc").textContent = t("bib.coinc_de", marcaActual + 1, marcas.length);
}
$("buscarEn").addEventListener("input", () => { marcaActual = -1; pintaTexto(); });
$("buscarEn").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  irACoincidencia(e.shiftKey ? -1 : 1);
});
$("coincSig").onclick = () => irACoincidencia(1);
$("coincAnt").onclick = () => irACoincidencia(-1);

// --- notas y momentos marcados ---
function pintaNotas(nueva) {
  const h = actual, marcas = h.marcas || [];
  if (nueva || document.activeElement !== $("notas")) $("notas").value = h.notas || "";
  const partes = [];
  const etiquetas = Array.isArray(h.tramos) && h.tramos.length ? etiquetasOriginales(h).length : 0;
  if (etiquetas) partes.push(t(etiquetas > 1 ? "bib.n_voces" : "bib.n_voz", etiquetas));
  if (marcas.length) partes.push(marcas.length > 1 ? t("bib.n_momentos", marcas.length) : t("bib.n_momento", marcas.length));
  if ((h.notas || "").trim()) partes.push(t("bib.con_notas"));
  $("lateralResumen").textContent = partes.length ? "· " + partes.join(" · ") : "";
  $("notasResumen").textContent = "";
  $("marcasLista").innerHTML = marcas.length ? marcas.map((m, i) =>
    `<div class="marca" role="button" tabindex="0" data-i="${i}" title="${escT(t("bib.ir_momento_title"))}">${icono("estrella")}` +
    `<span class="tm">${formatoTiempo(m.t)}</span><span class="txt">${m.nota ? escT(m.nota) : ""}</span>` +
    `<span class="x" data-borra="${i}" title="${escT(t("bib.quitar_title"))}" role="button" aria-label="${escT(t("bib.quitar_title"))}">${icono("cerrar")}</span></div>`).join("")
    : `<p class="vacio-l">${escT(t("bib.sin_momentos"))}</p>`;
  $("marcasLista").querySelectorAll(".marca").forEach((c) => {
    const ir = (e) => {
      const i = Number(c.dataset.i);
      if (e.target.closest("[data-borra]")) {
        const quedan = (actual.marcas || []).filter((_, k) => k !== i);
        editar({ marcas: quedan });
        return;
      }
      irA((actual.marcas || [])[i].t);
    };
    c.onclick = ir;
    c.onkeydown = (e) => { if (e.key === "Enter") ir(e); };
  });
}
$("btnLateral").onclick = () => {
  const abierta = $("lateral").classList.toggle("abierta");
  $("btnLateral").setAttribute("aria-expanded", String(abierta));
};

// Lleva a la primera intervención que empieza en ese minuto o después.
function irA(seg) {
  const lineas = [...$("texto").querySelectorAll(".l[data-t]")];
  const destino = lineas.find((l) => Number(l.dataset.t) >= seg) || lineas[lineas.length - 1];
  if (!destino) return;
  destino.scrollIntoView({ block: "center", behavior: "smooth" });
  destino.classList.add("destacada");
  setTimeout(() => destino.classList.remove("destacada"), 1800);
}

// Las notas se guardan al salir del cuadro, no con cada tecla: cada guardado
// rehace el .md de Descargas.
$("notas").addEventListener("change", () => {
  if (actual && $("notas").value !== (actual.notas || "")) editar({ notas: $("notas").value });
});

// --- pestañas ---
document.querySelectorAll(".pestanas button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".pestanas button").forEach((x) => {
      x.classList.toggle("activa", x === b);
      x.setAttribute("aria-selected", String(x === b));
    });
    for (const p of ["texto", "acta", "preguntar"]) $("p-" + p).hidden = p !== b.dataset.p;
    if (b.dataset.p === "preguntar") $("pregunta").focus();
  };
});

// ---------------------------------------------------------------------------------
// exportar
const baseFichero = (h) => (h.meta && h.meta.fichero) || fechaBonita(h.id).fichero;

// Markdown de la transcripción con los nombres puestos (sin la primera línea de
// título, que en el Word ya va como título del documento).
function mdTranscripcion(h) {
  if (Array.isArray(h.tramos) && h.tramos.length) return construirMarkdown(h);
  return aplicarHablantes(h.transcript || "", mapaVisible(h.transcript || "", h.hablantes));
}

function descargar(datos, tipo, nombre) {
  const url = URL.createObjectURL(new Blob([datos], { type: tipo }));
  const fin = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (chrome.downloads) {
    chrome.downloads.download({ url, filename: "reuniones/" + nombre, saveAs: false }, () => { fin(); toast(t("bib.guardado_en", nombre), "ok"); });
  } else {
    const a = document.createElement("a");
    a.href = url; a.download = nombre; a.click(); fin();
  }
}

conMenu($("btnExportar"), $("menuExportar"));
conMenu($("btnMas"), $("menuMas"));
$("menuExportar").querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    // Lo que sale de Escriba va sin el carácter invisible de las líneas sin hablante (comun.js).
    const h = actual, md = sinMarcaInvisible(mdTranscripcion(h)), base = "reunion_" + baseFichero(h);
    const cuerpo = md.replace(/^# .*\n+/, "");
    if (b.dataset.fmt === "docx") descargar(docx(h.titulo || t("com.reunion"), cuerpo), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base + ".docx");
    else if (b.dataset.fmt === "md") descargar(md, "text/markdown;charset=utf-8", base + ".md");
    else if (b.dataset.fmt === "txt") descargar(textoPlano(md), "text/plain;charset=utf-8", base + ".txt");
    else if (b.dataset.fmt === "srt") {
      const s = srt(aplicarHablantes(textoCrudo(h), mapaVisible(textoCrudo(h), h.hablantes)));
      if (!s) { toast(t("bib.srt_sin_tiempos"), "atencion"); return; }
      descargar(s, "application/x-subrip;charset=utf-8", base + ".srt");
    } else if (b.dataset.fmt === "pdf") imprimir("imprimeTexto");
  });
});

function imprimir(clase) {
  document.body.classList.add(clase);
  window.print();
  document.body.classList.remove(clase);
}

$("btnCopiar").onclick = async () => {
  await navigator.clipboard.writeText(textoPlano(sinMarcaInvisible(mdTranscripcion(actual))));
  toast(t("bib.transcripcion_copiada"), "ok");
};

$("btnReintentar").onclick = async () => {
  const r = await aBgMsg("reintentar", { id: actual.id });
  if (r && r.ok) toast(t("bib.reintentando"));
  else toast((r && r.error) || t("bib.no_se_pudo_reintentar"), "error");
};

// Borrar es irreversible: se pregunta siempre, y el audio de respaldo aparte.
$("btnBorrar").onclick = async () => {
  const h = actual, nAudio = (h.filesAudio || []).length;
  const r = await confirmar($("confirmaBorrar"), {
    html: t("bib.borrar_pregunta_html"),
    casilla: nAudio ? (nAudio > 1 ? t("bib.borrar_audio_n", nAudio) : t("bib.borrar_audio_1", nAudio)) : "",
    si: t("bib.si_borrar"), no: t("bib.cancelar"),
  });
  if (r.si) await aBgMsg("borrar", { ids: [h.id], conAudio: r.casilla });
};

// ---------------------------------------------------------------------------------
// actas y resúmenes
function pintaSelectores() {
  const plant = $("plantilla"), previa = plant.value;
  plant.innerHTML = Object.keys(PLANTILLAS).map((k) => {
    const sinTexto = k === "personalizada" && !(cfg.plantillaPersonalizada || "").trim();
    return `<option value="${k}"${sinTexto ? " disabled" : ""}>${escT(nombrePlantilla(k))}${sinTexto ? ` (${escT(t("bib.creala_en_opciones"))})` : ""}</option>`;
  }).join("");
  plant.value = previa || cfg.autoActaPlantilla || "acta";
  for (const id of ["provActa", "provChat"]) {
    const sel = $(id), prev = sel.value;
    sel.innerHTML = provsQueRedactan().map((k) =>
      `<option value="${k}"${tieneClave(cfg, k) ? "" : " disabled"}>${escT(nombreProv(k))}${tieneClave(cfg, k) ? "" : ` (${escT(t("bib.sin_clave"))})`}</option>`).join("");
    // Elegido: el que ya lo estaba, o el del acta automática, o el primero con
    // clave. Sin ninguna clave, el primero de la lista: al pedirle algo, el error
    // dice cuál falta.
    const conClave = provsQueRedactan().filter((k) => tieneClave(cfg, k));
    sel.value = conClave.includes(prev) ? prev : (conClave.includes(cfg.autoActaProv) ? cfg.autoActaProv : conClave[0] || provsQueRedactan()[0]);
  }
  if (actual) pintaActas();
}

// El nombre de cada plantilla en el idioma de la interfaz: lo da ia.js
// (PLANTILLAS[x].nombre se traduce al leerlo).
function nombrePlantilla(id) {
  return (PLANTILLAS[id] || PLANTILLAS.acta).nombre;
}

function etiquetaAnalisis(clave) {
  const [plantilla, prov] = clave.includes("·") ? clave.split("·") : ["acta", clave];
  const nom = nombrePlantilla(PLANTILLAS[plantilla] ? plantilla : "acta");
  return `${nom} · ${nombreProv(prov)}${clave.includes("·") ? "" : ` (${t("bib.version_anterior")})`}`;
}

function pintaActas() {
  const h = actual, claves = Object.keys(h.analisis || {});
  if (actaSel && !claves.includes(actaSel)) actaSel = null;
  if (!actaSel && claves.length) actaSel = claves[claves.length - 1];
  const hayTexto = ["ok", "pendiente"].includes(h.estado) && textoDe(h).trim();
  $("btnGenerar").disabled = !hayTexto || generando;
  // También en la que sigue sin una línea de texto (grabada sin clave): si no, las
  // plantillas salen apagadas sin decir por qué. Y se quita en cuanto la tiene.
  if (!hayTexto && !$("estadoActa").textContent && ["error", "pendiente"].includes(h.estado)) ponEstado($("estadoActa"), t("bib.acta_sin_transcripcion"), "atencion");
  else if (hayTexto && $("estadoActa").textContent === t("bib.acta_sin_transcripcion")) $("estadoActa").innerHTML = "";
  // El modelo cortó esta acta por su límite de longitud (3.8): se avisa siempre
  // que se lea, no solo al generarla. Lo apunta el service worker (histAnalisis).
  if (actaSel && !generando && (h.cortadas || []).includes(actaSel)) ponAviso($("avisoActa"), "atencion", escT(t("bib.acta_cortada")));
  else $("avisoActa").hidden = true;

  // Sin actas todavía: las plantillas como tarjetas, que dicen qué saca cada una.
  const vacio = $("plantillasVacio");
  vacio.hidden = claves.length > 0 || generando;
  if (!vacio.hidden) {
    vacio.innerHTML = Object.keys(PLANTILLAS).map((k) => {
      const sinTexto = k === "personalizada" && !(cfg.plantillaPersonalizada || "").trim();
      return `<button class="plantilla" data-k="${k}"${!hayTexto || sinTexto ? " disabled" : ""}>` +
        `<span class="ic">${icono(ICONO_PLANTILLA[k] || "documento")}</span><b>${escT(nombrePlantilla(k))}</b>` +
        `<span>${escT(sinTexto ? t("bib.creala_en_opciones") : (DESC_PLANTILLA[k] || DESC_PLANTILLA.acta)())}</span></button>`;
    }).join("");
    vacio.querySelectorAll(".plantilla").forEach((b) => {
      b.onclick = () => { $("plantilla").value = b.dataset.k; generar(); };
    });
  }

  $("actas").innerHTML = claves.length > 1 || generando ? claves.map((k) => `<button class="chip${k === actaSel ? " activa" : ""}" data-k="${escT(k)}">${icono(ICONO_PLANTILLA[k.split("·")[0]] || "documento")}${escT(etiquetaAnalisis(k))}</button>`).join("") : "";
  $("actas").querySelectorAll(".chip").forEach((c) => { c.onclick = () => { actaSel = c.dataset.k; pintaActas(); }; });
  $("documentoActa").hidden = !actaSel && !generando;
  $("accionesActa").hidden = !actaSel || generando;
  if (generando) $("actaVista").innerHTML = '<div class="esqueleto"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>';
  else $("actaVista").innerHTML = actaSel ? mdAHtml(h.analisis[actaSel]) : "";
}

$("btnGenerar").onclick = () => generar();
async function generar() {
  const h = actual, plantilla = $("plantilla").value, prov = $("provActa").value;
  if (generando) return;
  generando = true;
  ponEstado($("estadoActa"), t("bib.generando", nombrePlantilla(plantilla), nombreProv(prov)));
  pintaActas();
  try {
    const r = await analizarReunion(h, plantilla, prov, cfg, { alEstado: (txt) => ponEstado($("estadoActa"), sinEmoji(txt)) });
    // `truncado`: el modelo la cortó por su límite de longitud. Se guarda con el
    // acta para avisarlo cada vez que se lea (pintaActas).
    const g = await aBgMsg("histAnalisis", { id: h.id, clave: r.clave, texto: r.texto, uso: r.uso, truncado: !!r.truncado });
    actaSel = r.clave;
    if (g && g.ok) {
      ponEstado($("estadoActa"), t("bib.acta_guardada"), "ok");
    } else {
      // Ya está hecho y pagado: se enseña aunque no se haya podido guardar.
      const cortadas = (h.cortadas || []).filter((k) => k !== r.clave).concat(r.truncado ? [r.clave] : []);
      actual = { ...h, analisis: { ...(h.analisis || {}), [r.clave]: r.texto }, cortadas };
      ponEstado($("estadoActa"), t("bib.acta_no_guardada", (g && g.error) || t("bib.no_se_pudo_guardar")), "atencion");
    }
  } catch (e) {
    ponEstado($("estadoActa"), sinEmoji((e && e.message) || e), "err");
  } finally {
    generando = false;
    if (actual) pintaActas();
  }
}

const textoActa = () => actual.analisis[actaSel] || "";
const nombreActa = () => `${actaSel.replace("·", "_")}_${baseFichero(actual)}`;
$("actaCopiar").onclick = async () => { await navigator.clipboard.writeText(textoPlano(textoActa())); toast(t("bib.copiado"), "ok"); };
$("actaMd").onclick = () => descargar(textoActa(), "text/markdown;charset=utf-8", nombreActa() + ".md");
$("actaWord").onclick = () => descargar(docx(`${etiquetaAnalisis(actaSel)} — ${actual.titulo || t("com.reunion")}`, textoActa()),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", nombreActa() + ".docx");
$("actaImprimir").onclick = () => imprimir("imprimeActa");
// Con formato: Outlook, Gmail y Teams pegan el HTML con sus títulos y tablas.
$("actaCorreo").onclick = async () => {
  const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${mdAHtml(textoActa())
    .replace(/<table>/g, '<table style="border-collapse:collapse" border="1" cellpadding="5">')}</div>`;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([textoPlano(textoActa())], { type: "text/plain" }),
    })]);
    toast(t("bib.copiado_formato"), "ok");
  } catch (_) {
    await navigator.clipboard.writeText(textoPlano(textoActa()));
    toast(t("bib.copiado_texto"), "ok");
  }
};

// ---------------------------------------------------------------------------------
// preguntar a la reunión
function pintaChat() {
  const chat = actual.chat || [];
  let html = chat.map((m) => {
    const hora = m.fecha ? new Date(m.fecha).toLocaleTimeString(LOCALE_UI(), { hour: "2-digit", minute: "2-digit" }) : "";
    // `truncado` (3.8): el modelo cortó la respuesta por su límite de longitud.
    const cortada = m.truncado ? " · " + escT(t("bib.respuesta_cortada")) : "";
    return `<div class="burbuja p">${escT(m.p)}</div><div class="burbuja r"><div class="md">${mdAHtml(m.r)}</div><div class="quien">${icono("chispas")}${escT(nombreProv(m.prov))}${hora ? " · " + hora : ""}${cortada}</div></div>`;
  }).join("");
  // La pregunta en curso, con los puntos de «pensando», mientras llega la respuesta.
  if (preguntando && preguntando.id === actual.id) {
    html += `<div class="burbuja p">${escT(preguntando.q)}</div><div class="burbuja r pensando" aria-label="${escT(t("bib.pensando"))}"><i></i><i></i><i></i></div>`;
  }
  $("chat").innerHTML = html;
  $("chatVacio").hidden = !!html;
  if (html) $("chat").lastElementChild.scrollIntoView({ block: "nearest" });
}

$("sugerencias").querySelectorAll("button").forEach((b) => {
  b.onclick = () => { $("pregunta").value = b.textContent; $("formPregunta").requestSubmit(); };
});

$("formPregunta").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("pregunta").value.trim();
  if (!q || !actual || preguntando) return;
  // Sin una línea de transcripción (grabada sin clave, o todavía en marcha) no hay
  // a qué preguntar: se dice, en vez de gastar una llamada o de pedir una clave para nada.
  if (!textoDe(actual).trim()) { ponEstado($("estadoChat"), t("bib.chat_sin_transcripcion"), "atencion"); return; }
  const h = actual, prov = $("provChat").value, boton = $("btnPreguntar");
  boton.disabled = true;
  preguntando = { id: h.id, q };
  $("pregunta").value = "";
  ponEstado($("estadoChat"), t("bib.chat_leyendo", nombreProv(prov)));
  pintaChat();
  try {
    const r = await preguntarReunion(h, q, prov, cfg, { alEstado: (txt) => ponEstado($("estadoChat"), sinEmoji(txt)) });
    preguntando = null;
    const cortada = r.truncado ? { truncado: true } : {};
    const g = await aBgMsg("histChat", { id: h.id, mensaje: { p: q, r: r.texto, prov, uso: r.uso, ...cortada } });
    if (!g || !g.ok) {
      actual = { ...h, chat: [...(h.chat || []), { p: q, r: r.texto, prov, fecha: Date.now(), ...cortada }] };
      pintaChat();
      ponEstado($("estadoChat"), (g && g.error) || t("bib.chat_no_guardada"), "atencion");
    } else {
      $("estadoChat").innerHTML = "";
    }
  } catch (err) {
    preguntando = null;
    $("pregunta").value = q; // que no se pierda lo escrito
    if (actual) pintaChat();
    ponEstado($("estadoChat"), sinEmoji((err && err.message) || err), "err");
  } finally {
    preguntando = null;
    boton.disabled = false;
    $("pregunta").focus();
  }
};
