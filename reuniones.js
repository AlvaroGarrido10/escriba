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
    cfg = await leerConfig();
    pintaSelectores();
  }
});

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
    ok: ["ok", "lista"], error: ["err", "error"], pendiente: ["pend", "incompleta"], grabando: ["rec", "● grabando"],
  }[h.estado] || ["proc", "transcribiendo… " + (h.progreso || "")];
  return `<span class="badge ${b[0]}">${escT(b[1])}</span>`;
}

function pintaLista() {
  const cont = $("lista");
  const re = reBusqueda(filtro.trim());
  const q = normaliza(filtro.trim());
  const visibles = historial.filter((h) => !q || normaliza([h.titulo, h.participantes, h.fecha, textoDe(h)].join("\n")).includes(q));
  if (!historial.length) {
    cont.innerHTML = '<div class="sinResultados">Aún no hay reuniones. Graba una desde el icono de Escriba o transcribe un archivo.</div>';
    return;
  }
  if (!visibles.length) { cont.innerHTML = `<div class="sinResultados">Nada coincide con «${escT(filtro)}».</div>`; return; }
  cont.innerHTML = visibles.map((h) => {
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
      <div class="tit">${h.origen === "archivo" ? "📂 " : ""}${escT(h.titulo || "Reunión")}</div>
      <div class="sub">${escT(h.fecha)}${min} ${badge(h)}</div>${extracto}</div>`;
  }).join("");
  cont.querySelectorAll(".item").forEach((el) => { el.onclick = () => abrir(Number(el.dataset.id), true); });
}

function abrir(id, empujar) {
  actual = historial.find((h) => h.id === id) || null;
  actaSel = null;
  marcaActual = -1;
  if (actual) {
    if (empujar) history.pushState(null, "", "#" + id); else history.replaceState(null, "", "#" + id);
  }
  $("buscarEn").value = "";
  pintaLista();
  pintaVista(true);
}

// ---------------------------------------------------------------------------------
// una reunión
function pintaVista(nueva) {
  $("vacio").hidden = !!actual;
  $("reunion").hidden = !actual;
  if (!actual) return;
  const h = actual;
  // Un campo que el usuario está escribiendo no se repinta: se le borraría lo tecleado.
  if (nueva || document.activeElement !== $("titulo")) $("titulo").value = h.titulo || "Reunión";
  if (nueva || document.activeElement !== $("participantes")) $("participantes").value = h.participantes || "";
  document.title = (h.titulo || "Reunión") + " — Escriba";

  const tokens = sumaTokens(h);
  $("meta").innerHTML = [
    escT(h.fecha),
    h.meta && h.meta.minutos ? `${h.meta.minutos} min` : "",
    h.origen === "archivo" ? "📂 archivo importado" : "🎙️ grabación",
    badge(h),
    tokens ? `<span title="Tokens gastados en la transcripción y en las actas">≈ ${tokens.toLocaleString("es-ES")} tokens</span>` : "",
  ].filter(Boolean).join(" · ");

  pintaAviso();
  $("btnReintentar").hidden = h.estado !== "pendiente";
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
    a.textContent = `⏳ ${r.pendientes} de ${r.total} tramos siguen sin transcribir. El audio está a salvo y Escriba lo reintentará sola; también puedes pulsar «Reintentar ahora».`;
    a.hidden = false;
  } else if (h.estado === "transcribiendo" || h.estado === "grabando") {
    a.textContent = h.estado === "grabando" ? "🔴 Esta reunión se está grabando ahora mismo." : `✍️ Transcribiendo… ${h.progreso || ""}`;
    a.hidden = false;
  } else if (h.errorActa) {
    a.className = "aviso pend";
    a.textContent = "⚠️ El acta automática no se pudo generar: " + h.errorActa + " Puedes pedirla a mano en «Acta y resúmenes».";
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
    return `<span class="chipH" data-h="${escT(o)}" title="Pulsa para ponerle nombre"><span class="punto" style="background:${colorVoz(o, etiquetas)}"></span><b>${escT(nuevo || o)}</b>${nuevo ? `<span class="orig">(${escT(o)})</span>` : ""} ✎</span>`;
  }).join("") + '<span class="ayudaH">Pulsa una voz para ponerle nombre en toda la reunión.</span>';
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
  if (!r || !r.ok) toast("❌ " + ((r && r.error) || "No se pudo guardar."));
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
  h.tramos.forEach((t, i) => {
    const cab = `Tramo ${i + 1} de ${total} (${t.etiqueta || etiquetaTramo(i)})`;
    if (t.estado === "ok") {
      for (const l of lineasTranscripcion(t.texto || "")) {
        out.push({ tipo: "l", ...l, orig: l.hablante, hablante: (mapa[l.hablante] || "").trim() || l.hablante });
      }
      if (t.truncado) out.push({ tipo: "aviso", texto: `⚠️ ${cab}: se cortó por el límite de longitud del modelo.` });
    } else if (t.estado === "mudo") out.push({ tipo: "mudo", texto: `${cab}: sin voz — no se transcribe para no inventar texto.` });
    else if (t.estado === "perdido") out.push({ tipo: "aviso", texto: `⚠️ ${cab}: ${textoError("perdido")}` });
    else out.push({ tipo: "aviso", texto: `⏳ ${cab}: pendiente de transcribir. ${t.error || ""}` });
  });
  return out;
}

function pintaTexto() {
  const h = actual, cont = $("texto");
  if (h.estado === "error" || (!Array.isArray(h.tramos) && !h.transcript)) {
    cont.innerHTML = `<div class="md">${mdAHtml(h.transcript || "Sin texto.")}</div>`;
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
    return `<div class="l"><span class="t">${l.t !== null ? formatoTiempo(l.t) : ""}</span><div>${quien}${cuerpo}</div></div>`;
  }).join("");
  cont.innerHTML = html || '<div class="l mudo-l">Todavía no hay texto.</div>';
  $("nCoinc").textContent = re ? (n ? `${n} coincidencia${n === 1 ? "" : "s"} · Intro para ir a la siguiente` : "sin coincidencias") : "";
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
    chrome.downloads.download({ url, filename: "reuniones/" + nombre, saveAs: false }, () => { fin(); toast("💾 Guardado en Descargas/reuniones/" + nombre); });
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
    if (b.dataset.fmt === "docx") descargar(docx(h.titulo || "Reunión", cuerpo), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base + ".docx");
    else if (b.dataset.fmt === "md") descargar(md, "text/markdown;charset=utf-8", base + ".md");
    else if (b.dataset.fmt === "txt") descargar(textoPlano(md), "text/plain;charset=utf-8", base + ".txt");
    else if (b.dataset.fmt === "srt") {
      const s = srt(aplicarHablantes(textoCrudo(h), h.hablantes));
      if (!s) { toast("Esta reunión no tiene marcas de tiempo (se transcribió con una versión anterior de Escriba)."); return; }
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
  toast("📋 Transcripción copiada.");
};

$("btnReintentar").onclick = async () => {
  $("btnReintentar").disabled = true;
  const r = await aBgMsg("reintentar", { id: actual.id });
  $("btnReintentar").disabled = false;
  toast(r && r.ok ? "🔄 Reintentando…" : "❌ " + ((r && r.error) || "No se pudo reintentar."));
};

// Borrar es irreversible: se pregunta siempre, y el audio de respaldo aparte.
$("btnBorrar").onclick = () => {
  const caja = $("confirmaBorrar"), h = actual, nAudio = (h.filesAudio || []).length;
  caja.hidden = false;
  caja.innerHTML = "<b>¿Borrar esta reunión?</b> Se borrará también su <code>.md</code> de Descargas/reuniones. No hay vuelta atrás." +
    (nAudio ? `<label style="display:block;margin-top:5px"><input type="checkbox" id="cbAudio" checked> Borrar también su audio de respaldo (${nAudio} fichero${nAudio > 1 ? "s" : ""})</label>` : "") +
    '<div class="acciones"><button id="siBorrar" class="principal">Sí, borrar</button><button id="noBorrar">Cancelar</button></div>';
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
  plant.innerHTML = Object.entries(PLANTILLAS).map(([k, p]) => {
    const sinTexto = k === "personalizada" && !(cfg.plantillaPersonalizada || "").trim();
    return `<option value="${k}"${sinTexto ? " disabled" : ""}>${escT(p.nombre)}${sinTexto ? " (créala en Opciones)" : ""}</option>`;
  }).join("");
  plant.value = previa || cfg.autoActaPlantilla || "acta";
  for (const id of ["provActa", "provChat"]) {
    const sel = $(id), prev = sel.value;
    sel.innerHTML = PROVEEDORES.map(([k, n, clave]) =>
      `<option value="${k}"${cfg[clave] ? "" : " disabled"}>${n}${cfg[clave] ? "" : " (sin clave)"}</option>`).join("");
    const conClave = PROVEEDORES.filter(([, , c]) => cfg[c]).map(([k]) => k);
    sel.value = conClave.includes(prev) ? prev : (conClave.includes(cfg.autoActaProv) ? cfg.autoActaProv : conClave[0] || "gemini");
  }
}

function etiquetaAnalisis(clave) {
  const [plantilla, prov] = clave.includes("·") ? clave.split("·") : ["acta", clave];
  const nom = (PLANTILLAS[plantilla] || PLANTILLAS.acta).nombre;
  return `${nom} · ${nombreProv(prov)}${clave.includes("·") ? "" : " (versión anterior)"}`;
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
  if (!hayTexto && !$("estadoActa").textContent) $("estadoActa").textContent = h.estado === "error" ? "No hay transcripción de la que sacar un acta." : "";
}

$("btnGenerar").onclick = async () => {
  const h = actual, plantilla = $("plantilla").value, prov = $("provActa").value;
  $("btnGenerar").disabled = true;
  $("estadoActa").textContent = `⏳ Generando «${PLANTILLAS[plantilla].nombre}» con ${nombreProv(prov)}…`;
  try {
    const r = await analizarReunion(h, plantilla, prov, cfg, { alEstado: (t) => { $("estadoActa").textContent = t; } });
    const g = await aBgMsg("histAnalisis", { id: h.id, clave: r.clave, texto: r.texto, uso: r.uso });
    actaSel = r.clave;
    if (g && g.ok) {
      $("estadoActa").textContent = "✅ Listo y guardado en la reunión.";
    } else {
      // Ya está hecho y pagado: se enseña aunque no se haya podido guardar.
      actual = { ...h, analisis: { ...(h.analisis || {}), [r.clave]: r.texto } };
      $("estadoActa").textContent = "⚠️ " + ((g && g.error) || "No se pudo guardar") + " — cópialo o descárgalo ahora.";
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
$("actaCopiar").onclick = async () => { await navigator.clipboard.writeText(textoPlano(textoActa())); toast("📋 Copiado."); };
$("actaMd").onclick = () => descargar(textoActa(), "text/markdown;charset=utf-8", nombreActa() + ".md");
$("actaWord").onclick = () => descargar(docx(`${etiquetaAnalisis(actaSel)} — ${actual.titulo || "Reunión"}`, textoActa()),
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
    toast("✉️ Copiado con formato: pégalo en el correo.");
  } catch (_) {
    await navigator.clipboard.writeText(textoPlano(textoActa()));
    toast("📋 Copiado como texto (este navegador no deja copiar con formato).");
  }
};

// ---------------------------------------------------------------------------------
// preguntar a la reunión
function pintaChat() {
  const chat = actual.chat || [];
  $("chat").innerHTML = chat.map((m) => {
    const hora = m.fecha ? new Date(m.fecha).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) : "";
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
  $("estadoChat").textContent = `⏳ ${nombreProv(prov)} está leyendo la reunión…`;
  try {
    const r = await preguntarReunion(h, q, prov, cfg, { alEstado: (t) => { $("estadoChat").textContent = t; } });
    const g = await aBgMsg("histChat", { id: h.id, mensaje: { p: q, r: r.texto, prov, uso: r.uso } });
    if (!g || !g.ok) {
      actual = { ...h, chat: [...(h.chat || []), { p: q, r: r.texto, prov, fecha: Date.now() }] };
      pintaChat();
      $("estadoChat").textContent = "⚠️ " + ((g && g.error) || "No se pudo guardar la respuesta.");
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
