// Escriba — biblioteca de reuniones: buscar, leer con formato, poner nombre a
// cada voz, exportar, sacar actas con plantillas y preguntar a la reunión.
//
// Lee el historial de chrome.storage.local pero NO escribe en él: todo cambio va
// al service worker (histEditar, histAnalisis, histChat), que es quien serializa
// las escrituras. Así una edición aquí no pisa el progreso de una transcripción
// que esté terminando a la vez.

const $ = (id) => document.getElementById(id);
const COLORES_VOZ = ["#5d2a42", "#1f6f8b", "#2e7d32", "#b8570a", "#6b3fa0", "#a3261b", "#0f766e", "#8a6d00"];
const PROVEEDORES = [["gemini", "Gemini", "geminiKey"], ["gpt", "GPT", "openaiKey"], ["claude", "Claude", "claudeKey"]];
const nombreProv = (p) => (PROVEEDORES.find((x) => x[0] === p) || [p, p])[1];

let historial = [], actual = null, cfg = {}, filtro = "", actaSel = null, marcaActual = -1;
let conAudio = new Set();   // tramos de la reunión abierta con audio conservado
let sonando = null;         // { tramo, inicioS } del audio cargado en el reproductor

const aBgMsg = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
const escT = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const normaliza = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

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
    if (actual) actual = historial.find((h) => h.id === actual.id) || null;
    pintaLista();
    pintaVista();
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
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $("buscar").focus(); }
  if (e.key === "Escape") $("menuExportar").hidden = true;
});
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $("menuExportar").hidden = true; });

// ---------------------------------------------------------------------------------
// lista de reuniones
function textoDe(h) {
  if (Array.isArray(h.tramos) && h.tramos.length) {
    return aplicarHablantes(h.tramos.filter((t) => t.estado === "ok").map((t) => t.texto || "").join("\n"), h.hablantes);
  }
  return h.transcript || "";
}

function badge(h) {
  const b = {
    ok: ["ok", t("bib.estado_ok")], error: ["err", t("bib.estado_error")],
    pendiente: ["pend", t("bib.estado_pendiente")], grabando: ["rec", t("bib.estado_grabando")],
  }[h.estado] || ["proc", t("bib.estado_transcribiendo", h.progreso || "")];
  return `<span class="badge ${b[0]}">${escT(b[1])}</span>`;
}

function pintaLista() {
  const cont = $("lista");
  const re = reBusqueda(filtro.trim());
  const q = normaliza(filtro.trim());
  const visibles = historial.filter((h) => !q || normaliza([h.titulo, h.participantes, h.fecha, textoDe(h)].join("\n")).includes(q));
  if (!historial.length) {
    cont.innerHTML = `<div class="sinResultados">${escT(t("bib.lista_vacia"))}</div>`;
    return;
  }
  if (!visibles.length) { cont.innerHTML = `<div class="sinResultados">${escT(t("bib.nada_coincide", filtro))}</div>`; return; }
  cont.innerHTML = resumenMes() + visibles.map((h) => {
    let extracto = "";
    if (q) {
      const texto = textoDe(h), pos = normaliza(texto).indexOf(q);
      if (pos >= 0) {
        const desde = Math.max(0, pos - 40);
        extracto = `<div class="extracto">…${resalta(escT(texto.slice(desde, pos + q.length + 60)), re)}…</div>`;
      }
    }
    const min = h.meta && h.meta.minutos ? ` · ${h.meta.minutos} min` : "";
    return `<div class="item${actual && actual.id === h.id ? " activa" : ""}" data-id="${h.id}">
      <div class="tit">${h.origen === "archivo" ? "📂 " : ""}${escT(h.titulo || t("com.reunion"))}</div>
      <div class="sub">${escT(fechaVisible(h))}${min} ${badge(h)}</div>${extracto}</div>`;
  }).join("");
  cont.querySelectorAll(".item").forEach((el) => { el.onclick = () => abrir(Number(el.dataset.id), true); });
  const enlace = cont.querySelector(".mes a");
  if (enlace) enlace.onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
}

// Lo que llevas gastado este mes con tus claves. Sin precios no se adivina: se
// ofrece ponerlos, y solo si hay alguna reunión con tokens apuntados.
function resumenMes() {
  const m = costeMes(historial, cfg.precios);
  const mes = new Date().toLocaleDateString(LOCALE_UI(), { month: "long" });
  if (m.euros !== null) {
    const falta = m.faltan.length ? ` <span title="${escT(t("bib.sin_precio_title", m.faltan.map(nombreProv).join(", ")))}">${escT(t("bib.sin_precio_corto"))}</span>` : "";
    const n = m.reuniones === 1 ? t("bib.n_reunion", m.reuniones) : t("bib.n_reuniones", m.reuniones);
    return `<div class="mes" title="${escT(t("bib.estimacion_title"))}">💶 ${escT(mes)}: ≈ ${escT(formatoEuros(m.euros))}${falta} · ${escT(n)}</div>`;
  }
  return historial.some((h) => costeReunion(h, {}).tokens)
    ? `<div class="mes">💶 ${t("bib.pon_precios_html")}</div>`
    : "";
}

function abrir(id, empujar) {
  actual = historial.find((h) => h.id === id) || null;
  actaSel = null;
  marcaActual = -1;
  if (actual) {
    if (empujar) history.pushState(null, "", "#" + id); else history.replaceState(null, "", "#" + id);
  }
  $("buscarEn").value = "";
  paraAudio();
  pintaLista();
  pintaVista(true);
  miraAudio();
}

// --- escuchar (3.4) ---
// El audio conservado vive en IndexedDB («escucha»), por tramos. Pulsar la marca
// de tiempo de una frase carga su tramo y salta a ese segundo.
async function miraAudio() {
  const id = actual && actual.id;
  conAudio = new Set();
  if (id && typeof audios !== "undefined" && audios && audios.clavesEscucha) {
    try {
      for (const [r, i] of await audios.clavesEscucha()) if (r === id) conAudio.add(i);
    } catch (_) { /* sin IndexedDB no hay reproductor; el resto funciona */ }
  }
  if (!actual || actual.id !== id) return;
  $("reproductor").hidden = !conAudio.size;
  if (conAudio.size) pintaRepInfo();
  pintaTexto();
}

function pintaRepInfo() {
  $("repInfo").textContent = sonando
    ? t("bib.rep_tramo", sonando.tramo + 1, actual.tramos.length)
    : t("bib.rep_pulsa");
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
  const tr = (actual.tramos || [])[tramo];
  const blob = await audios.leerEscucha(actual.id, tramo).catch(() => null);
  if (!blob) { toast(t("bib.audio_no_guardado")); return; }
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
// Al acabar un tramo sigue con el siguiente, como si fuera un solo audio.
$("audio").addEventListener("ended", () => {
  if (!sonando) return;
  const sig = sonando.tramo + 1;
  if (conAudio.has(sig)) suena(sig, inicioTramo(actual.tramos[sig], sig));
});
$("velocidad").addEventListener("change", () => { $("audio").playbackRate = Number($("velocidad").value) || 1; });
$("quitarAudio").onclick = async () => {
  if (!actual) return;
  paraAudio();
  await audios.borrarEscucha(actual.id).catch(() => {});
  toast(t("bib.audio_borrado"));
  miraAudio();
};

// ---------------------------------------------------------------------------------
// una reunión
function pintaVista(nueva) {
  $("vacio").hidden = !!actual;
  $("reunion").hidden = !actual;
  if (!actual) return;
  const h = actual;
  // Un campo que el usuario está escribiendo no se repinta: se le borraría lo tecleado.
  if (nueva || document.activeElement !== $("titulo")) $("titulo").value = h.titulo || t("com.reunion");
  if (nueva || document.activeElement !== $("participantes")) $("participantes").value = h.participantes || "";
  document.title = (h.titulo || t("com.reunion")) + " — Escriba";

  const tokens = sumaTokens(h);
  const coste = costeReunion(h, cfg.precios);
  const sinPrecio = coste.faltan.length ? ` (${t("bib.sin_precio_min", coste.faltan.map(nombreProv).join(", "))})` : "";
  $("meta").innerHTML = [
    escT(fechaVisible(h)),
    h.meta && h.meta.minutos ? `${h.meta.minutos} min` : "",
    escT(h.origen === "archivo" ? t("bib.origen_archivo") : t("bib.origen_grabacion")),
    badge(h),
    tokens ? `<span title="${escT(t("bib.tokens_title"))}">≈ ${tokens.toLocaleString(LOCALE_UI())} tokens</span>` : "",
    coste.euros !== null ? `<span title="${escT(t("bib.estimacion_title") + sinPrecio)}">💶 ≈ ${escT(formatoEuros(coste.euros))}${coste.faltan.length ? " +" : ""}</span>` : "",
  ].filter(Boolean).join(" · ");

  pintaAviso();
  $("btnReintentar").hidden = h.estado !== "pendiente";
  pintaNotas(nueva);
  pintaHablantes();
  pintaTexto();
  pintaActas();
  pintaChat();
}

function sumaTokens(h) {
  let n = 0;
  for (const t of h.tramos || []) if (t.uso) n += (t.uso.entrada || 0) + (t.uso.salida || 0);
  for (const u of h.usoIA || []) n += (u.entrada || 0) + (u.salida || 0);
  return n;
}

function pintaAviso() {
  const h = actual, a = $("aviso");
  a.hidden = true;
  a.className = "aviso";
  if (h.estado === "pendiente") {
    const r = resumenTramos(h.tramos);
    a.className = "aviso pend";
    a.textContent = t("bib.aviso_pendiente", r.pendientes, r.total);
    a.hidden = false;
  } else if (h.estado === "transcribiendo" || h.estado === "grabando") {
    a.textContent = h.estado === "grabando" ? t("bib.aviso_grabando") : t("bib.aviso_transcribiendo", h.progreso || "");
    a.hidden = false;
  } else if (h.errorActa) {
    a.className = "aviso pend";
    a.textContent = t("bib.aviso_error_acta", h.errorActa);
    a.hidden = false;
  }
}

// --- hablantes ---
function textoCrudo(h) {
  return (h.tramos || []).filter((t) => t.estado === "ok").map((t) => t.texto || "").join("\n");
}
function etiquetasOriginales(h) {
  return Array.isArray(h.tramos) && h.tramos.length ? hablantesDe(textoCrudo(h)) : hablantesDe(h.transcript || "");
}
const colorVoz = (orig, lista) => COLORES_VOZ[Math.max(0, lista.indexOf(orig)) % COLORES_VOZ.length];

function pintaHablantes() {
  const h = actual, cont = $("hablantes");
  if (cont.querySelector("input")) return; // renombrando: no se toca
  const etiquetas = Array.isArray(h.tramos) && h.tramos.length ? etiquetasOriginales(h) : [];
  if (!etiquetas.length) { cont.innerHTML = ""; return; }
  const mapa = h.hablantes || {};
  cont.innerHTML = etiquetas.map((o) => {
    const nuevo = (mapa[o] || "").trim();
    return `<span class="chipH" data-h="${escT(o)}" title="${escT(t("bib.renombrar_title"))}"><span class="punto" style="background:${colorVoz(o, etiquetas)}"></span><b>${escT(nuevo || o)}</b>${nuevo ? `<span class="orig">(${escT(o)})</span>` : ""} ✎</span>`;
  }).join("") + `<span class="ayudaH">${escT(t("bib.renombrar_ayuda"))}</span>`;
  cont.querySelectorAll(".chipH").forEach((chip) => { chip.onclick = () => renombrar(chip); });
}

function renombrar(chip) {
  const orig = chip.dataset.h, mapa = { ...(actual.hablantes || {}) };
  const sugeridos = (actual.participantes || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  chip.innerHTML = `<input value="${escT(mapa[orig] || "")}" placeholder="${escT(orig)}" list="listaNombres">` +
    `<datalist id="listaNombres">${sugeridos.map((s) => `<option value="${escT(s)}">`).join("")}</datalist>`;
  chip.onclick = null;
  const input = chip.querySelector("input");
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
  input.onkeydown = (e) => { if (e.key === "Enter") guardar(true); if (e.key === "Escape") guardar(false); };
  input.onblur = () => guardar(true);
}

async function editar(cambios) {
  const r = await aBgMsg("histEditar", { id: actual.id, cambios });
  if (!r || !r.ok) toast("❌ " + ((r && r.error) || t("bib.no_se_pudo_guardar_punto")));
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
  const mapa = h.hablantes || {}, out = [], total = h.tramos.length;
  h.tramos.forEach((tr, i) => {
    const cab = t("bib.tramo_cab", i + 1, total, tr.etiqueta || etiquetaTramo(i));
    if (tr.estado === "ok") {
      for (const l of lineasTranscripcion(tr.texto || "")) {
        out.push({ tipo: "l", ...l, tramo: i, orig: l.hablante, hablante: (mapa[l.hablante] || "").trim() || l.hablante });
      }
      if (tr.truncado) out.push({ tipo: "aviso", texto: t("bib.tramo_truncado", cab) });
    } else if (tr.estado === "mudo") out.push({ tipo: "mudo", texto: t("bib.tramo_mudo", cab) });
    else if (tr.estado === "perdido") out.push({ tipo: "aviso", texto: `⚠️ ${cab}: ${textoError("perdido")}` });
    else out.push({ tipo: "aviso", texto: t("bib.tramo_pendiente", cab, tr.error || "") });
  });
  return out;
}

function pintaTexto() {
  const h = actual, cont = $("texto");
  if (h.estado === "error" || (!Array.isArray(h.tramos) && !h.transcript)) {
    cont.innerHTML = `<div class="md">${mdAHtml(h.transcript || t("bib.sin_texto"))}</div>`;
    $("nCoinc").textContent = "";
    return;
  }
  const re = reBusqueda($("buscarEn").value.trim());
  const etiquetas = etiquetasOriginales(h);
  let n = 0;
  const html = lineasDeVista(h).map((l) => {
    if (l.tipo === "aviso") return `<div class="l aviso-l">${escT(l.texto)}</div>`;
    if (l.tipo === "mudo") return `<div class="l mudo-l">${escT(l.texto)}</div>`;
    let cuerpo = escT(l.texto);
    if (re) cuerpo = cuerpo.replace(re, (m) => { n++; return `<mark>${m}</mark>`; });
    let quien = "";
    if (l.hablante) {
      let nom = escT(l.hablante);
      if (re) nom = nom.replace(re, (m) => { n++; return `<mark>${m}</mark>`; });
      quien = `<span class="h" style="color:${colorVoz(l.orig, etiquetas)}">${nom}</span>`;
    }
    const escuchable = l.t !== null && typeof l.tramo === "number" && conAudio.has(l.tramo);
    return `<div class="l"${l.t !== null ? ` data-t="${l.t}"` : ""}${typeof l.tramo === "number" ? ` data-tramo="${l.tramo}"` : ""}>` +
      `<span class="t${escuchable ? " play" : ""}"${escuchable ? ` title="${escT(t("bib.escuchar_title"))}"` : ""}>${l.t !== null ? formatoTiempo(l.t) : ""}</span><div>${quien}${cuerpo}</div></div>`;
  }).join("");
  cont.innerHTML = html || `<div class="l mudo-l">${escT(t("bib.sin_texto_aun"))}</div>`;
  cont.querySelectorAll(".t.play").forEach((el) => {
    el.onclick = () => { const l = el.closest(".l"); suena(Number(l.dataset.tramo), Number(l.dataset.t)); };
  });
  $("nCoinc").textContent = re ? (n === 1 ? t("bib.n_coincidencia", n) : n ? t("bib.n_coincidencias", n) : t("bib.sin_coincidencias")) : "";
}

$("buscarEn").addEventListener("input", () => { marcaActual = -1; pintaTexto(); });
$("buscarEn").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const marcas = [...$("texto").querySelectorAll("mark")];
  if (!marcas.length) return;
  marcas.forEach((m) => m.classList.remove("actual"));
  marcaActual = (marcaActual + (e.shiftKey ? -1 : 1) + marcas.length) % marcas.length;
  marcas[marcaActual].classList.add("actual");
  marcas[marcaActual].scrollIntoView({ block: "center", behavior: "smooth" });
});

// --- notas y momentos marcados ---
function pintaNotas(nueva) {
  const h = actual, marcas = h.marcas || [];
  if (nueva || document.activeElement !== $("notas")) $("notas").value = h.notas || "";
  const partes = [];
  if ((h.notas || "").trim()) partes.push(t("bib.con_notas"));
  if (marcas.length) partes.push(marcas.length > 1 ? t("bib.n_momentos", marcas.length) : t("bib.n_momento", marcas.length));
  $("notasResumen").textContent = partes.length ? "· " + partes.join(" · ") : "";
  if (nueva) $("notasBox").open = !!partes.length;
  $("marcasLista").innerHTML = marcas.map((m, i) =>
    `<span class="chip marca" data-i="${i}" title="${escT(t("bib.ir_momento_title"))}">⭐ ${formatoTiempo(m.t)}${m.nota ? " · " + escT(m.nota) : ""}<span class="x" data-borra="${i}" title="${escT(t("bib.quitar_title"))}">✕</span></span>`).join("");
  $("marcasLista").querySelectorAll(".chip.marca").forEach((c) => {
    c.onclick = (e) => {
      const i = Number(c.dataset.i);
      if (e.target.dataset.borra !== undefined) {
        const quedan = (actual.marcas || []).filter((_, k) => k !== i);
        editar({ marcas: quedan });
        return;
      }
      irA((actual.marcas || [])[i].t);
    };
  });
}

// Lleva a la primera intervención que empieza en ese minuto o después.
function irA(t) {
  const lineas = [...$("texto").querySelectorAll(".l[data-t]")];
  const destino = lineas.find((l) => Number(l.dataset.t) >= t) || lineas[lineas.length - 1];
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
    document.querySelectorAll(".pestanas button").forEach((x) => x.classList.toggle("activa", x === b));
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
  return aplicarHablantes(h.transcript || "", h.hablantes);
}

function descargar(datos, tipo, nombre) {
  const url = URL.createObjectURL(new Blob([datos], { type: tipo }));
  const fin = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (chrome.downloads) {
    chrome.downloads.download({ url, filename: "reuniones/" + nombre, saveAs: false }, () => { fin(); toast(t("bib.guardado_en", nombre)); });
  } else {
    const a = document.createElement("a");
    a.href = url; a.download = nombre; a.click(); fin();
  }
}

$("btnExportar").onclick = (e) => { e.stopPropagation(); $("menuExportar").hidden = !$("menuExportar").hidden; };
$("menuExportar").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    $("menuExportar").hidden = true;
    const h = actual, md = mdTranscripcion(h), base = "reunion_" + baseFichero(h);
    const cuerpo = md.replace(/^# .*\n+/, "");
    if (b.dataset.fmt === "docx") descargar(docx(h.titulo || t("com.reunion"), cuerpo), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base + ".docx");
    else if (b.dataset.fmt === "md") descargar(md, "text/markdown;charset=utf-8", base + ".md");
    else if (b.dataset.fmt === "txt") descargar(textoPlano(md), "text/plain;charset=utf-8", base + ".txt");
    else if (b.dataset.fmt === "srt") {
      const s = srt(aplicarHablantes(textoCrudo(h), h.hablantes));
      if (!s) { toast(t("bib.srt_sin_tiempos")); return; }
      descargar(s, "application/x-subrip;charset=utf-8", base + ".srt");
    } else if (b.dataset.fmt === "pdf") imprimir("imprimeTexto");
  };
});

function imprimir(clase) {
  document.body.classList.add(clase);
  window.print();
  document.body.classList.remove(clase);
}

$("btnCopiar").onclick = async () => {
  await navigator.clipboard.writeText(textoPlano(mdTranscripcion(actual)));
  toast(t("bib.transcripcion_copiada"));
};

$("btnReintentar").onclick = async () => {
  $("btnReintentar").disabled = true;
  const r = await aBgMsg("reintentar", { id: actual.id });
  $("btnReintentar").disabled = false;
  toast(r && r.ok ? t("bib.reintentando") : "❌ " + ((r && r.error) || t("bib.no_se_pudo_reintentar")));
};

// Borrar es irreversible: se pregunta siempre, y el audio de respaldo aparte.
$("btnBorrar").onclick = () => {
  const caja = $("confirmaBorrar"), h = actual, nAudio = (h.filesAudio || []).length;
  caja.hidden = false;
  const cbTexto = nAudio > 1 ? t("bib.borrar_audio_n", nAudio) : t("bib.borrar_audio_1", nAudio);
  caja.innerHTML = t("bib.borrar_pregunta_html") +
    (nAudio ? `<label style="display:block;margin-top:5px"><input type="checkbox" id="cbAudio" checked> ${escT(cbTexto)}</label>` : "") +
    `<div class="acciones"><button id="siBorrar" class="principal">${escT(t("bib.si_borrar"))}</button><button id="noBorrar">${escT(t("bib.cancelar"))}</button></div>`;
  $("noBorrar").onclick = () => { caja.hidden = true; };
  $("siBorrar").onclick = async () => {
    const cb = $("cbAudio");
    await aBgMsg("borrar", { ids: [h.id], conAudio: !!(cb && cb.checked) });
    caja.hidden = true;
  };
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
    sel.innerHTML = PROVEEDORES.map(([k, n, clave]) =>
      `<option value="${k}"${cfg[clave] ? "" : " disabled"}>${n}${cfg[clave] ? "" : ` (${escT(t("bib.sin_clave"))})`}</option>`).join("");
    const conClave = PROVEEDORES.filter(([, , c]) => cfg[c]).map(([k]) => k);
    sel.value = conClave.includes(prev) ? prev : (conClave.includes(cfg.autoActaProv) ? cfg.autoActaProv : conClave[0] || "gemini");
  }
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
  $("actas").innerHTML = claves.map((k) => `<button class="chip${k === actaSel ? " activa" : ""}" data-k="${escT(k)}">${escT(etiquetaAnalisis(k))}</button>`).join("");
  $("actas").querySelectorAll(".chip").forEach((c) => { c.onclick = () => { actaSel = c.dataset.k; pintaActas(); }; });
  $("actaVista").innerHTML = actaSel ? mdAHtml(h.analisis[actaSel]) : "";
  $("accionesActa").hidden = !actaSel;
  const hayTexto = ["ok", "pendiente"].includes(h.estado) && textoDe(h).trim();
  $("btnGenerar").disabled = !hayTexto;
  if (!hayTexto && !$("estadoActa").textContent) $("estadoActa").textContent = h.estado === "error" ? t("bib.acta_sin_transcripcion") : "";
}

$("btnGenerar").onclick = async () => {
  const h = actual, plantilla = $("plantilla").value, prov = $("provActa").value;
  $("btnGenerar").disabled = true;
  $("estadoActa").textContent = t("bib.generando", nombrePlantilla(plantilla), nombreProv(prov));
  try {
    const r = await analizarReunion(h, plantilla, prov, cfg, { alEstado: (t) => { $("estadoActa").textContent = t; } });
    const g = await aBgMsg("histAnalisis", { id: h.id, clave: r.clave, texto: r.texto, uso: r.uso });
    actaSel = r.clave;
    if (g && g.ok) {
      $("estadoActa").textContent = t("bib.acta_guardada");
    } else {
      // Ya está hecho y pagado: se enseña aunque no se haya podido guardar.
      actual = { ...h, analisis: { ...(h.analisis || {}), [r.clave]: r.texto } };
      $("estadoActa").textContent = t("bib.acta_no_guardada", (g && g.error) || t("bib.no_se_pudo_guardar"));
    }
    pintaActas();
  } catch (e) {
    $("estadoActa").textContent = "❌ " + ((e && e.message) || e);
  } finally {
    $("btnGenerar").disabled = false;
  }
};

const textoActa = () => actual.analisis[actaSel] || "";
const nombreActa = () => `${actaSel.replace("·", "_")}_${baseFichero(actual)}`;
$("actaCopiar").onclick = async () => { await navigator.clipboard.writeText(textoPlano(textoActa())); toast(t("bib.copiado")); };
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
    toast(t("bib.copiado_formato"));
  } catch (_) {
    await navigator.clipboard.writeText(textoPlano(textoActa()));
    toast(t("bib.copiado_texto"));
  }
};

// ---------------------------------------------------------------------------------
// preguntar a la reunión
function pintaChat() {
  const chat = actual.chat || [];
  $("chat").innerHTML = chat.map((m) => {
    const hora = m.fecha ? new Date(m.fecha).toLocaleTimeString(LOCALE_UI(), { hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="burbuja p">${escT(m.p)}</div><div class="burbuja r">${mdAHtml(m.r)}<div class="quien">${escT(nombreProv(m.prov))}${hora ? " · " + hora : ""}</div></div>`;
  }).join("");
  $("sugerencias").hidden = chat.length > 0;
}

$("sugerencias").querySelectorAll("button").forEach((b) => {
  b.onclick = () => { $("pregunta").value = b.textContent; $("formPregunta").requestSubmit(); };
});

$("formPregunta").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("pregunta").value.trim();
  if (!q || !actual) return;
  const h = actual, prov = $("provChat").value, boton = $("formPregunta").querySelector("button");
  boton.disabled = true;
  $("estadoChat").textContent = t("bib.chat_leyendo", nombreProv(prov));
  try {
    const r = await preguntarReunion(h, q, prov, cfg, { alEstado: (t) => { $("estadoChat").textContent = t; } });
    const g = await aBgMsg("histChat", { id: h.id, mensaje: { p: q, r: r.texto, prov, uso: r.uso } });
    if (!g || !g.ok) {
      actual = { ...h, chat: [...(h.chat || []), { p: q, r: r.texto, prov, fecha: Date.now() }] };
      pintaChat();
      $("estadoChat").textContent = "⚠️ " + ((g && g.error) || t("bib.chat_no_guardada"));
    } else {
      $("estadoChat").textContent = "";
    }
    $("pregunta").value = "";
  } catch (err) {
    $("estadoChat").textContent = "❌ " + ((err && err.message) || err);
  } finally {
    boton.disabled = false;
    $("pregunta").focus();
  }
};

// ---------------------------------------------------------------------------------
let toastTimer = null;
function toast(texto) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    t.style.cssText = "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#2b2229;color:#fff;padding:10px 16px;border-radius:10px;font-size:13.5px;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:20;max-width:80vw";
    document.body.appendChild(t);
  }
  t.textContent = texto;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
