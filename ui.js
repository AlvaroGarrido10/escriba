// Escriba — piezas de interfaz que comparten las páginas (3.6): el tema claro u
// oscuro, los iconos, los avisos y los menús desplegables.
//
// Va en el <head>, justo después de i18n.js: el tema elegido se aplica antes de
// pintar nada, leyendo la copia de localStorage (chrome.storage es asíncrono y
// daría un fogonazo blanco a quien lo tenga en oscuro).
//
// Solo declara funciones: cada página tiene su propio `const $`, y una
// constante global repetida entre scripts sería un SyntaxError.

function ponTema(tema) {
  const v = tema === "claro" || tema === "oscuro" ? tema : "auto";
  if (v === "auto") delete document.documentElement.dataset.tema;
  else document.documentElement.dataset.tema = v;
  try { localStorage.setItem("escriba.tema", v); } catch (_) { /* sin localStorage: se queda el del sistema */ }
  return v;
}

(function arrancaTema() {
  if (typeof document === "undefined") return;
  try { ponTema(localStorage.getItem("escriba.tema")); } catch (_) { /* idem */ }
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) return;
  chrome.storage.sync.get({ tema: "auto" }).then(({ tema }) => ponTema(tema)).catch(() => {});
  chrome.storage.onChanged.addListener((cambios, area) => {
    if (area === "sync" && cambios.tema) ponTema(cambios.tema.newValue);
  });
})();

// Un icono del sprite (iconos.svg). `clase` añade clases: "g" (grande), "lleno"…
function icono(nombre, clase) {
  return `<svg class="i${clase ? " " + clase : ""}" aria-hidden="true"><use href="iconos.svg#${nombre}"></use></svg>`;
}

function escapa(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Tipo de aviso → icono. Los textos ya no llevan emoji delante: lo pone esto.
function iconoDeTipo(tipo) {
  return { ok: "ok", error: "error", err: "error", atencion: "alerta", pend: "alerta", proc: "reloj", info: "info" }[tipo] || "info";
}

// Caja de aviso: <div class="aviso tipo"><icono><div class="cuerpo">…</div></div>.
// `html` debe venir ya escapado (o ser un texto nuestro de i18n con <b>).
function avisoHtml(tipo, html, nombreIcono) {
  return `<div class="aviso ${tipo || ""}">${icono(nombreIcono || iconoDeTipo(tipo))}<div class="cuerpo">${html}</div></div>`;
}
function ponAviso(el, tipo, html, nombreIcono) {
  el.className = "aviso " + (tipo || "");
  el.innerHTML = icono(nombreIcono || iconoDeTipo(tipo)) + `<div class="cuerpo">${html}</div>`;
  el.hidden = false;
}

// Línea de estado bajo un control: icono + texto (escapado aquí).
// tipo: "ok", "err", "atencion" o nada (neutro, sin icono).
function ponEstado(el, texto, tipo) {
  el.className = "estado" + (tipo ? " " + tipo : "");
  el.innerHTML = texto ? (tipo ? icono(iconoDeTipo(tipo)) : "") + `<span>${escapa(texto)}</span>` : "";
}

let _toastTimer = null;
function toast(texto, tipo) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.className = "toast" + (tipo ? " " + tipo : "");
  el.innerHTML = icono(tipo ? iconoDeTipo(tipo) : "check") + `<span>${escapa(texto)}</span>`;
  el.hidden = false;
  // Reinicia la animación aunque ya estuviera a la vista.
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// Menú desplegable: el botón abre/cierra la lista; un clic fuera o Escape la cierra.
const _menusAbiertos = new Set();
function conMenu(boton, lista) {
  boton.setAttribute("aria-haspopup", "true");
  boton.setAttribute("aria-expanded", "false");
  const cerrar = () => { lista.hidden = true; boton.setAttribute("aria-expanded", "false"); _menusAbiertos.delete(cerrar); };
  boton.addEventListener("click", (e) => {
    e.stopPropagation();
    const abrir = lista.hidden;
    for (const c of [..._menusAbiertos]) c();
    if (abrir) { lista.hidden = false; boton.setAttribute("aria-expanded", "true"); _menusAbiertos.add(cerrar); }
  });
  lista.addEventListener("click", (e) => { if (e.target.closest("button, a")) cerrar(); });
  return cerrar;
}
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    for (const c of [..._menusAbiertos]) c(e);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") for (const c of [..._menusAbiertos]) c();
  });
}

// Botón con icono y texto, para las listas que se pintan desde JS.
function botonUI({ texto, icono: ic, clase, titulo, alPulsar }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn " + (clase || "");
  b.innerHTML = (ic ? icono(ic) : "") + (texto ? `<span>${escapa(texto)}</span>` : "");
  if (titulo) { b.title = titulo; if (!texto) b.setAttribute("aria-label", titulo); }
  if (alPulsar) b.addEventListener("click", alPulsar);
  return b;
}

// Opción de un menú desplegable (.menu-lista).
function itemMenu({ texto, icono: ic, peligro, alPulsar }) {
  const b = document.createElement("button");
  b.type = "button";
  if (peligro) b.className = "peligro";
  b.innerHTML = (ic ? icono(ic) : "") + `<span>${escapa(texto)}</span>`;
  if (alPulsar) b.addEventListener("click", alPulsar);
  return b;
}

// Fecha corta de una reunión: «Hoy, 10:30», «Ayer, 17:05», «30 sept, 12:00».
// El id de cada reunión es su marca de tiempo; si no lo es, la fecha guardada.
function fechaCorta(h) {
  const ts = typeof h.id === "number" && h.id > 1e12 ? h.id : null;
  if (!ts) return h.fecha || "";
  const d = new Date(ts), hoy = new Date();
  const hora = d.toLocaleTimeString(LOCALE_UI(), { hour: "2-digit", minute: "2-digit" });
  const mismoDia = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (mismoDia(d, hoy)) return t("ui.hoyA", hora);
  if (mismoDia(d, new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1))) return t("ui.ayerA", hora);
  const opc = { day: "numeric", month: "short" };
  if (d.getFullYear() !== hoy.getFullYear()) opc.year = "numeric";
  return t("ui.diaA", d.toLocaleDateString(LOCALE_UI(), opc), hora);
}

// Grupo de la lista de reuniones: hoy, ayer, esta semana, y luego por mes.
function grupoDeFecha(h) {
  const ts = typeof h.id === "number" && h.id > 1e12 ? h.id : null;
  if (!ts) return { clave: "?", nombre: t("ui.sinFecha") };
  const d = new Date(ts), hoy = new Date();
  const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime();
  const inicioAyer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1).getTime();
  // La semana empieza el lunes.
  const inicioSemana = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - ((hoy.getDay() + 6) % 7)).getTime();
  if (ts >= inicioHoy) return { clave: "hoy", nombre: t("ui.hoy") };
  if (ts >= inicioAyer) return { clave: "ayer", nombre: t("ui.ayer") };
  if (ts >= inicioSemana) return { clave: "semana", nombre: t("ui.estaSemana") };
  const opc = { month: "long" };
  if (d.getFullYear() !== hoy.getFullYear()) opc.year = "numeric";
  const nombre = d.toLocaleDateString(LOCALE_UI(), opc);
  return { clave: d.getFullYear() + "-" + d.getMonth(), nombre: nombre.charAt(0).toUpperCase() + nombre.slice(1) };
}

// Pregunta antes de algo irreversible (borrar). Pinta la caja en `donde` y
// devuelve una promesa: { si: true, casilla: bool } o { si: false }.
function confirmar(donde, { html, casilla, si, no }) {
  return new Promise((resolver) => {
    donde.innerHTML = "";
    const caja = document.createElement("div");
    caja.className = "confirma";
    caja.innerHTML = `<div>${html}</div>` +
      (casilla ? `<label class="casilla"><input type="checkbox" checked> <span>${escapa(casilla)}</span></label>` : "");
    const fila = document.createElement("div");
    fila.className = "botones";
    const fin = (r) => { donde.innerHTML = ""; donde.hidden = true; resolver(r); };
    fila.append(
      botonUI({ texto: si, icono: "borrar", clase: "btn-peq btn-peligro lleno", alPulsar: () => {
        const cb = caja.querySelector("input[type=checkbox]");
        fin({ si: true, casilla: !!(cb && cb.checked) });
      } }),
      botonUI({ texto: no, clase: "btn-peq", alPulsar: () => fin({ si: false }) }),
    );
    caja.appendChild(fila);
    donde.appendChild(caja);
    donde.hidden = false;
    fila.querySelector("button").focus();
  });
}

// Barra de nivel de una fuente de audio, como un vúmetro: -60 dB (silencio) = 0 %,
// -10 dB = llena. La usan el popup y el panel en vivo con la orden «niveles».
function medidaNivel(rms) {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  const pct = Math.max(0, Math.min(100, Math.round(((db + 60) / 50) * 100)));
  return { pct, clase: pct < 4 ? "mudo" : pct < 25 ? "bajo" : "" };
}
function htmlNivel(f) {
  const { pct, clase } = medidaNivel(f.rms);
  const esPestana = f.nombre === "pestaña";
  return `<div class="nivel"><span class="nombre">${icono(esPestana ? "pestana" : "micro")}${escapa(t(esPestana ? "viv.fuentePestana" : "viv.fuenteMicro"))}</span>` +
    `<div class="barra-nivel ${clase}"><div style="width:${pct}%"></div></div></div>`;
}
// Pinta las barras en `cont`. Si son las mismas fuentes que ya había, solo
// cambia el ancho: rehacer el HTML cada vez se come la animación y la barra salta.
function actualizaNiveles(cont, fuentes) {
  const clave = fuentes.map((f) => f.nombre).join("|");
  if (cont.dataset.fuentes !== clave) {
    cont.innerHTML = fuentes.map(htmlNivel).join("");
    cont.dataset.fuentes = clave;
    return;
  }
  const barras = cont.querySelectorAll(".barra-nivel");
  fuentes.forEach((f, i) => {
    const { pct, clase } = medidaNivel(f.rms);
    barras[i].className = "barra-nivel" + (clase ? " " + clase : "");
    barras[i].firstElementChild.style.width = pct + "%";
  });
}

// Inicial de un nombre para el círculo de cada voz («Hablante 2» → «2»).
function inicialDe(nombre) {
  const s = String(nombre || "").trim();
  const n = s.match(/^(?:Hablante|Speaker)\s+(\d+)$/i);
  if (n) return n[1];
  return (s[0] || "?").toUpperCase();
}
