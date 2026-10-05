// Escriba — configuración: valida la clave, elige modelo y guarda sola.

const $ = (id) => document.getElementById(id);
const BASE = "https://generativelanguage.googleapis.com";
// Orden de preferencia: calidad/latencia razonables y disponibles para claves nuevas.
const MODELOS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-pro-latest", "gemini-2.0-flash"];

// `txt` puede ser una función que devuelve el texto: se guarda para volver a
// escribirlo en el idioma nuevo si se cambia el de la interfaz (repintaEstados).
const estados = {};
function pinta(id, txt, ok) {
  const texto = typeof txt === "function" ? txt : () => txt;
  estados[id] = { texto, ok };
  ponEstado($(id), texto(), ok === true ? "ok" : ok === false ? "err" : null);
}
function repintaEstados() {
  for (const [id, { texto, ok }] of Object.entries(estados)) pinta(id, texto, ok);
}
// Un Error cuyo mensaje se puede volver a sacar en el idioma de la interfaz.
// Recibe una función, () => t("clave", …), para que el test vea la clave.
function errorTraducible(texto) {
  const e = new Error(texto());
  e.texto = texto;
  return e;
}

let guardando = null;
async function guarda(campos) {
  clearTimeout(guardando);
  guardando = setTimeout(() => guardarConfig(campos), 200);
}

// --- lo que sale del registro de proveedores (proveedores.js) ---
// Las tarjetas de «Claves de IA», los desplegables y la rejilla de precios se
// pintan aquí, antes de cargar la configuración, y solo con lo ENCENDIDO en el
// registro: una capacidad apagada no existe para el usuario. Encender un
// proveedor es cambiar su interruptor allí; aquí no hay nada que tocar.

// Lo que se escribe desde aquí, y no desde el HTML, se apunta como función: así
// se vuelve a escribir en el idioma nuevo si se cambia el de la interfaz.
const alCambiarIdioma = [];
function escribe(pon) {
  alCambiarIdioma.push(pon);
  pon();
}
function reescribe() {
  for (const pon of alCambiarIdioma) pon();
}
function crea(etiqueta, clase, texto) {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto) el.textContent = texto;
  return el;
}

// Gemini no lleva tarjeta: tiene su paso arriba, en «Empezar».
const CON_TARJETA = provsVisibles().filter((id) => id !== "gemini");
// La clave que hay guardada de cada una, para saber si la del campo está sin guardar.
const claveGuardada = {};
const sinGuardar = (id) => $(provDe(id).campoClave).value.trim() !== (claveGuardada[id] || "");

// La tarjeta de un proveedor: qué hace, cómo se saca la clave, lo que conviene
// saber antes de usarlo, la clave con su botón «Guardar» y, si redacta, el
// modelo para las actas.
function tarjetaDe(id) {
  const p = provDe(id), linea = "e-" + id;
  const tarjeta = crea("div", "tarjeta prov");
  tarjeta.id = "prov-" + id;

  // «OpenAI — GPT»: la empresa que da la clave y cómo se llama su IA en los desplegables.
  const cab = crea("div", "prov-cab");
  cab.append(crea("h3", "", p.nombre === p.etiqueta ? p.nombre : `${p.nombre} — ${p.etiqueta}`));
  const pildora = (clase, saca) => {
    const el = crea("span", "pildora" + (clase ? " " + clase : ""));
    escribe(() => { el.textContent = saca(); });
    return el;
  };
  cab.append(
    transcribe(id) ? pildora("ok", () => t("opc.provTranscribe")) : pildora("", () => t("opc.provNoTranscribe")),
    redacta(id) ? pildora("ok", () => t("opc.provRedacta")) : pildora("", () => t("opc.provNoRedacta")),
  );
  if (p.gratis) cab.append(pildora("proc", () => t("opc.provGratis")));

  // La ayuda es un texto nuestro de i18n.js, con el enlace para sacar la clave.
  const ayuda = crea("p", "prov-txt");
  escribe(() => { ayuda.innerHTML = t(p.ayuda); });
  tarjeta.append(cab, ayuda);

  // Lo de transcribir y lo de redactar, solo con esa capacidad encendida: la
  // tarjeta no cuenta cómo transcribe quien todavía no transcribe.
  const avisos = [p.aviso, transcribe(id) && p.voz.aviso, redacta(id) && p.chat.aviso].filter(Boolean).map((clave) => () => t(clave));
  // Si su host es opcional, Chrome lo pide al guardar: que no pille por sorpresa.
  if (!p.fijo) avisos.push(() => t("opc.provPermiso", new URL(p.base).host));
  for (const saca of avisos) {
    const aviso = crea("p", "prov-aviso");
    aviso.innerHTML = icono("info") + "<span></span>";
    escribe(() => { aviso.lastChild.textContent = saca(); });
    tarjeta.append(aviso);
  }

  const fila = crea("div", "prov-clave"), caja = crea("div", "con-boton");
  const clave = crea("input", "campo");
  clave.type = "password";
  clave.id = p.campoClave;
  clave.autocomplete = "off";
  clave.spellcheck = false;
  const ojo = crea("button", "btn btn-fantasma btn-icono ver-clave");
  ojo.type = "button";
  ojo.dataset.para = p.campoClave;
  ojo.innerHTML = icono("ojo");
  const guardar = crea("button", "btn btn-primario");
  guardar.type = "button";
  guardar.id = "guardar-" + id;
  guardar.innerHTML = icono("check") + "<span></span>";
  escribe(() => {
    clave.placeholder = t("opc.p1Placeholder");
    ojo.title = t("opc.verClave");
    ojo.setAttribute("aria-label", t("opc.verClave"));
    guardar.lastChild.textContent = t("opc.provGuardar");
  });
  caja.append(clave, ojo);
  fila.append(caja, guardar);
  tarjeta.append(fila);
  // La clave no se guarda a cada tecla: hay que pedir permiso y comprobarla, y
  // eso necesita un clic (o un Intro, que para Chrome también es un gesto).
  guardar.addEventListener("click", () => guardaProveedor(id));
  clave.addEventListener("keydown", (e) => { if (e.key === "Enter") guardaProveedor(id); });
  clave.addEventListener("input", () => pinta(linea, sinGuardar(id) ? () => t("opc.provSinGuardar") : "", null));

  if (redacta(id)) {
    const etiqueta = crea("label", "etiqueta");
    etiqueta.htmlFor = p.campoModelo;
    escribe(() => { etiqueta.textContent = t("opc.provModelo"); });
    const modelo = crea("input", "campo mono");
    modelo.type = "text";
    modelo.id = p.campoModelo;
    modelo.placeholder = p.chat.modelo;
    modelo.setAttribute("list", "modelos-" + id);
    const lista = crea("datalist");
    lista.id = "modelos-" + id;
    // El modelo sí se guarda solo, como siempre; el botón es para la clave.
    modelo.addEventListener("input", () => {
      guarda({ [p.campoModelo]: modelo.value.trim() });
      if (sinGuardar(id)) pinta(linea, () => t("opc.provSinGuardar"), null);
      else pinta(linea, () => t("opc.guardado"), true);
      pintaReferencias();
    });
    tarjeta.append(etiqueta, modelo, lista);
  }

  const estado = crea("div", "estado");
  estado.id = linea;
  tarjeta.append(estado);
  return tarjeta;
}
for (const id of CON_TARJETA) $("tarjetas").append(tarjetaDe(id));
// Sin ninguna tarjeta, el apartado sobra, y su entrada del índice también.
if (!CON_TARJETA.length) {
  $("claves").remove();
  document.querySelector('#indice a[href="#claves"]').remove();
}
// En el paso 1, «¿tienes clave de otra IA?» solo si alguna otra transcribe.
$("notaOtraIA").hidden = !provsQueTranscriben().some((id) => id !== "gemini");

// Los modelos que ofrece el campo de una tarjeta. Los ids vienen de la API del
// proveedor, no son nuestros: pasan por escapa() antes de ir a innerHTML.
function ponModelos(id, ids) {
  const lista = $("modelos-" + id);
  if (lista) lista.innerHTML = ids.map((m) => `<option value="${escapa(m)}">`).join("");
}

// Con quién se hace el acta automática: las IA que redactan.
$("autoActaProv").innerHTML = provsQueRedactan().map((id) => `<option value="${escapa(id)}">${escapa(provDe(id).etiqueta)}</option>`).join("");

// El modelo con que transcribe cada IA que tiene varios. Gemini no entra: el
// suyo lo elige validarClave, y se ve en su fila de siempre.
const CON_VOCES = provsQueTranscriben().filter((id) => id !== "gemini" && provDe(id).voz.modelos.length > 1);
function filaVoz(id) {
  const p = provDe(id);
  const fila = crea("div", "fila"), txt = crea("div", "fila-txt"), ctl = crea("div", "fila-ctl");
  const titulo = crea("b"), ayuda = crea("p");
  escribe(() => {
    titulo.textContent = t("opc.modeloVoz", p.nombre);
    ayuda.textContent = t("opc.modeloVozAyuda");
  });
  const sel = crea("select", "campo mono");
  sel.id = p.campoVoz;
  const estado = crea("div", "estado");
  estado.id = "eVoz-" + id;
  txt.append(titulo, ayuda);
  ctl.append(sel);
  fila.append(txt, ctl, estado);
  sel.addEventListener("change", async () => {
    await guardarConfig({ [p.campoVoz]: sel.value });
    pinta("eVoz-" + id, () => t("opc.idiomaGuardado"), true);
    pintaReferencias();
  });
  return fila;
}
// Detrás de «Quién transcribe», en el orden en que elige el modo automático.
$("filaQuien").after(...CON_VOCES.map(filaVoz));
// Solo se ofrecen los modelos del registro, que son los que offscreen.js sabe
// pedir. Si lo guardado es otro (puesto a mano), va delante.
function ponVoces(cfg) {
  for (const id of CON_VOCES) {
    const p = provDe(id), guardado = cfg[p.campoVoz] || p.voz.modelos[0];
    const modelos = p.voz.modelos.includes(guardado) ? p.voz.modelos : [guardado, ...p.voz.modelos];
    $(p.campoVoz).innerHTML = modelos.map((m) => `<option value="${escapa(m)}">${escapa(m)}</option>`).join("");
    $(p.campoVoz).value = guardado;
  }
}

// «Quién transcribe»: solo hay algo que elegir con más de una IA que transcriba
// encendida. Las que no tienen clave salen, pero no se pueden elegir.
function pintaQuien(cfg) {
  const voces = provsQueTranscriben();
  $("filaQuien").hidden = voces.length < 2;
  const sel = $("provTranscribe");
  sel.innerHTML = `<option value="auto">${escapa(t("opc.quienAuto"))}</option>` + voces.map((id) => {
    const falta = tieneClave(cfg, id) ? "" : ` (${t("opc.sinClave")})`;
    return `<option value="${escapa(id)}"${falta ? " disabled" : ""}>${escapa(provDe(id).nombre + falta)}</option>`;
  }).join("");
  sel.value = voces.includes(cfg.provTranscribe) ? cfg.provTranscribe : "auto";
}

// La rejilla de precios, una fila por IA encendida: entrada y salida para la que
// redacta y, para la que transcribe, el audio. El de Gemini va por millón de
// tokens (`audio`) y el de las demás por minuto (`minuto`), que es como se le
// cobra a cada una (comun.js: costeReunion).
const tipoVoz = (p) => (p.voz.dialecto === "gemini" ? "audio" : "minuto");
function pintaPrecios() {
  const rejilla = $("precios");
  const casilla = (id, tipo) => {
    if (!tipo) return crea("span");
    const i = crea("input", "campo");
    i.dataset.prov = id;
    i.dataset.tipo = tipo;
    i.inputMode = "decimal";
    return i;
  };
  for (const id of provsVisibles()) {
    const p = provDe(id);
    const nombre = crea("span", "prov", p.nombre + " ");
    const enlace = crea("a");
    enlace.href = p.urlPrecios;
    enlace.target = "_blank";
    enlace.rel = "noopener";
    escribe(() => { enlace.textContent = t("opc.precios"); });
    // El modelo al que se refieren los precios de la fila (pintaReferencias).
    const modelo = crea("small", "modelo");
    modelo.id = "ref-" + id;
    nombre.append(enlace, modelo);
    rejilla.append(nombre, casilla(id, transcribe(id) && tipoVoz(p)), casilla(id, redacta(id) && "entrada"), casilla(id, redacta(id) && "salida"));
  }
  $("notaMinuto").hidden = !rejilla.querySelector('input[data-tipo="minuto"]');
}
pintaPrecios();

// --- carga inicial ---
(async () => {
  await cargarIdiomaUI();
  // Lo pintado arriba salió en el idioma del navegador: ahora, en el elegido.
  reescribe();
  await migrarConfig();
  const d = await leerConfig();
  for (const k of ["geminiKey", "geminiModel", "glosario", "plantillaPersonalizada"]) $(k).value = d[k] || "";
  // Las tarjetas, con lo guardado: quien ya tenía su clave de OpenAI o de
  // Anthropic la sigue viendo puesta, y le sigue sirviendo sin volver a guardarla.
  for (const id of CON_TARJETA) {
    const p = provDe(id);
    claveGuardada[id] = String(d[p.campoClave] || "").trim();
    $(p.campoClave).value = d[p.campoClave] || "";
    if (redacta(id)) $(p.campoModelo).value = d[p.campoModelo] || "";
  }
  ponVoces(d);
  $("idiomaUI").value = d.idiomaUI || "auto";
  $("idioma").value = d.idioma || "es";
  $("autoActa").checked = !!d.autoActa;
  $("autoActaPlantilla").value = d.autoActaPlantilla || "acta";
  // Si la IA elegida para el acta ya no está entre las que redactan, se enseña
  // Gemini, que es con quien se haría (offscreen.js: actaAutomatica).
  $("autoActaProv").value = redacta(d.autoActaProv) ? d.autoActaProv : "gemini";
  $("conservarAudio").checked = !!d.conservarAudio;
  $("modoAltavoz").value = d.modoAltavoz || "auto";
  for (const el of document.querySelectorAll(".precios input")) el.value = ((d.precios || {})[el.dataset.prov] || {})[el.dataset.tipo] || "";
  // Activado solo si además sigue el permiso: el usuario puede retirarlo desde Chrome.
  $("avisoReunion").checked = !!d.avisoReunion && await chrome.permissions.contains({ origins: ORIGENES_REUNION }).catch(() => false);
  for (const r of document.querySelectorAll("input[name=tema]")) r.checked = r.value === (d.tema || "auto");
  pintaAtajo();
  pintaReferencias();
  pintaEspacio();
  if (d.geminiKey) validarClave(d.geminiKey, d.geminiModel);
  revisaVoz();
  for (const id of CON_TARJETA) cargaModelos(id, d);
  revisarMicro();
})();

// --- paso 1: clave (se valida y guarda sola al pegar/escribir) ---
let t1 = null;
$("geminiKey").addEventListener("input", async () => {
  clearTimeout(t1);
  const k = $("geminiKey").value.trim();
  recienQuitada = false;
  if (!k) {
    // Vaciar el campo no borra la clave guardada (al cambiarla por otra se pasa
    // por vacío): revisaVoz lo dice, y para quitarla está su botón.
    pinta("e1", "", null);
    revisaVoz();
    return;
  }
  pinta("e1", () => t("opc.comprobandoClave"));
  t1 = setTimeout(() => validarClave(k), 500);
});

// Quitar la clave de Gemini: desde la 3.8 se puede grabar sin clave, así que
// tiene que haber forma de volver a no tenerla. Lo que estuviera esperando una
// clave sigue esperando (background.js no relanza nada al quedarse sin ella).
$("quitarGemini").onclick = async () => {
  clearTimeout(t1);
  // El campo se vacía ANTES del primer await: una comprobación que esté en vuelo
  // mira el campo para saber si su clave sigue siendo la que hay que guardar.
  $("geminiKey").value = "";
  $("geminiModel").value = "";
  claveComprobada = "";
  recienQuitada = true;
  await guardarConfig({ geminiKey: "", geminiModel: "" });
  pintaReferencias();
  pinta("e1", () => t("opc.provBorrada"), true);
  await revisaVoz();
};

// Guardar una clave reintenta solo lo que estaba esperando por ella: lo hace el
// service worker al ver el cambio. Pero si se guarda la misma que había, Chrome
// no avisa de ningún cambio: se pide explícitamente. Devuelve cuántas reuniones
// esperaban, para contarlo.
async function relanzaPendientes() {
  const { historial } = await chrome.storage.local.get({ historial: [] });
  const pendientes = historial.filter((h) => h.estado === "pendiente").length;
  if (pendientes) chrome.runtime.sendMessage({ target: "bg", cmd: "claveNueva" }).catch(() => {});
  return pendientes;
}
const textoPendientes = (n) => (n ? " · " + (n > 1 ? t("opc.reintentandoN", n) : t("opc.reintentando1", n)) : "");

async function validarClave(key, modeloGuardado) {
  try {
    const r = await fetch(`${BASE}/v1beta/models`, { headers: { "x-goog-api-key": key } });
    if (!r.ok) throw errorTraducible(() => t("opc.claveNoValida", r.status));
    const disponibles = (await r.json()).models
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace("models/", ""));

    // Elige el primer modelo preferido que además FUNCIONE de verdad con esta clave.
    let elegido = "";
    const candidatos = MODELOS.filter((m) => disponibles.includes(m));
    if (modeloGuardado && disponibles.includes(modeloGuardado)) candidatos.unshift(modeloGuardado);
    for (const m of candidatos) {
      const p = await fetch(`${BASE}/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 5 } }),
      });
      if (p.ok) { elegido = m; break; }
    }
    if (!elegido) throw errorTraducible(() => t("opc.sinModelo"));

    // Google la acepta: si es la guardada, el paso 1 está hecho diga lo que diga
    // ahora el campo.
    claveComprobada = key;
    // Mientras se comprobaba, el campo ha cambiado (otra clave, o se ha quitado
    // la guardada): esta ya no es la que hay que guardar.
    if ($("geminiKey").value.trim() !== key) { revisaVoz(); return; }
    $("geminiModel").value = elegido;
    pintaReferencias();
    await guardarConfig({ geminiKey: key, geminiModel: elegido });
    // Al cargar la página se revalida la clave ya guardada: eso no dispara nada.
    const esNueva = modeloGuardado === undefined;
    const pendientes = esNueva ? await relanzaPendientes() : 0;
    pinta("e1", () => t("opc.claveValida", elegido) + textoPendientes(pendientes), true);
  } catch (e) {
    // Solo deja de valer la clave que ha fallado: una mala recién tecleada no
    // quita la marca a la guardada, que sigue siendo buena.
    if (claveComprobada === key) claveComprobada = "";
    pinta("e1", () => (e.texto ? e.texto() : e.message), false);
  }
  revisaVoz();
}

// --- con quién se transcribe ---
// El paso 1 está hecho cuando hay con quién transcribir, sea quien sea
// (proveedores.js: proveedorVoz). Si es Gemini, además su clave tiene que haber
// pasado la comprobación de arriba, como siempre.
// `claveComprobada`: la última clave de Gemini que Google ha aceptado. El paso
// cuenta si esa es la GUARDADA, no según lo último que se haya tecleado.
// `recienQuitada`: se acaba de quitar la clave y su línea lo está diciendo.
let claveComprobada = "", recienQuitada = false, quienTranscribe = "";
async function revisaVoz() {
  const cfg = await leerConfig();
  const quien = proveedorVoz(cfg);
  quienTranscribe = quien === "gemini" && cfg.geminiKey !== claveComprobada ? "" : quien;
  $("p1").classList.toggle("listo", !!quienTranscribe);
  // Con el campo de Gemini vacío, su línea dice lo que hay: quién transcribe en
  // su lugar, o que la clave sigue guardada aunque no se vea, o que se ha quitado.
  if (!$("geminiKey").value.trim()) {
    const otra = quienTranscribe && quienTranscribe !== "gemini" ? provDe(quienTranscribe).nombre : "";
    if (otra) pinta("e1", () => t("opc.transcribeCon", otra), true);
    else if (cfg.geminiKey) pinta("e1", () => t("opc.claveSigue"), null);
    else if (!recienQuitada) pinta("e1", "", null);
  }
  $("notaQuitar").hidden = !cfg.geminiKey;
  pintaQuien(cfg);
  pintaResumen();
}
$("provTranscribe").addEventListener("change", async () => {
  await guardarConfig({ provTranscribe: $("provTranscribe").value });
  await revisaVoz();
  if (quienTranscribe) pinta("eQuien", () => t("opc.quienGuardado", provDe(quienTranscribe).nombre), true);
  else pinta("eQuien", () => t("opc.quienNadie"), false);
});

// --- paso 2: micrófono ---
async function revisarMicro() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    if (p.state === "granted") { $("p2").classList.add("listo"); pinta("e2", () => t("opc.microPermitido"), true); listo(); }
  } catch (_) {}
}
$("btnMic").onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((pista) => pista.stop());
    $("p2").classList.add("listo");
    pinta("e2", () => t("opc.microPermitido"), true);
    listo();
  } catch (e) {
    pinta("e2", () => t("opc.microDenegado"), false);
  }
};

function listo() { pintaResumen(); }

// Arriba del todo: si Escriba ya puede grabar o qué le falta, de un vistazo.
function pintaResumen() {
  const clave = $("p1").classList.contains("listo"), micro = $("p2").classList.contains("listo");
  const r = $("resumen");
  // Con Gemini el paso se llama como siempre; si transcribe otra IA, se dice cuál.
  const otra = clave && quienTranscribe !== "gemini" ? t("opc.transcribeCon", provDe(quienTranscribe).nombre) : "";
  if (clave && micro) {
    ponAviso(r, "ok", escapa(t("opc.todoListo") + (otra ? " " + otra + "." : "")));
    r.classList.add("resumen");
    return;
  }
  // Lo que falta, sin pedir la clave de Gemini a quien puede transcribir con otra.
  const pasoClave = otra || (!clave && provsQueTranscriben().length > 1 ? t("opc.faltaClaveVoz") : t("opc.p1Titulo"));
  const paso = (hecho, txt) => `<span class="paso-mini${hecho ? " hecho" : ""}">${icono(hecho ? "ok" : "reloj")}${escapa(txt)}</span>`;
  ponAviso(r, "", `<b>${escapa(t("opc.faltan"))}</b><div class="lista-pasos">${paso(clave, pasoClave)}${paso(micro, t("opc.p2Titulo"))}</div>`);
  r.classList.add("resumen");
}

// Mostrar u ocultar una clave mientras se pega.
for (const b of document.querySelectorAll(".ver-clave")) {
  b.onclick = () => {
    const input = $(b.dataset.para), ver = input.type === "password";
    input.type = ver ? "text" : "password";
    b.innerHTML = icono(ver ? "ojo-no" : "ojo");
  };
}

// El índice de la izquierda marca el apartado que se está viendo: el último
// cuyo título ya ha pasado del primer tercio de la pantalla. Los del final nunca
// llegan tan arriba (no queda página por debajo), así que al tocar fondo se marca
// el último; y al pulsar uno, se marca ese mientras dura el desplazamiento.
const enlaces = [...document.querySelectorAll("#indice a")];
const secciones = enlaces.map((a) => document.querySelector(a.getAttribute("href")));
let pulsado = null, pulsadoHasta = 0;
function marcaIndice() {
  let actual = secciones[0];
  if (pulsado && Date.now() < pulsadoHasta) actual = pulsado;
  else {
    pulsado = null;
    for (const sec of secciones) if (sec && sec.getBoundingClientRect().top <= innerHeight / 3) actual = sec;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) actual = secciones[secciones.length - 1];
  }
  enlaces.forEach((a, i) => a.classList.toggle("activo", secciones[i] === actual));
}
enlaces.forEach((a, i) => a.addEventListener("click", () => { pulsado = secciones[i]; pulsadoHasta = Date.now() + 1200; marcaIndice(); }));
addEventListener("scroll", marcaIndice, { passive: true });
addEventListener("resize", marcaIndice);
marcaIndice();

// --- tema: claro, oscuro o el del sistema (ui.js lo aplica en todas las páginas) ---
for (const r of document.querySelectorAll("input[name=tema]")) {
  r.addEventListener("change", async () => { await guardarConfig({ tema: r.value }); ponTema(r.value); });
}
$("btnAtajos").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

// --- retención: cuántas transcripciones conservar ---
// limite = 0 significa "guardarlas todas".
(async () => {
  const { limite } = await leerConfig();
  $("retenTodo").checked = limite === 0;
  $("retenN").checked = limite !== 0;
  $("limite").value = limite || 10;
})();

function guardaRetencion() {
  const todo = $("retenTodo").checked;
  const n = Math.max(1, Math.min(100, parseInt($("limite").value, 10) || 10)); // el historial no pasa de 100 terminadas (background.js: TOPE_HISTORIAL)
  $("limite").value = n;
  guardarConfig({ limite: todo ? 0 : n });
  pinta("e4", () => (todo ? t("opc.retenTodoGuardado") : t("opc.retenNGuardado", n)), true);
}
$("retenTodo").addEventListener("change", guardaRetencion);
$("retenN").addEventListener("change", guardaRetencion);
$("limite").addEventListener("input", () => { $("retenN").checked = true; guardaRetencion(); });

// --- idioma de la interfaz (no el de las reuniones: ese es «idioma», abajo) ---
$("idiomaUI").addEventListener("change", async () => {
  await guardarConfig({ idiomaUI: $("idiomaUI").value });
  await cargarIdiomaUI();
  reescribe();
  repintaEstados();
  pintaAtajo();
  pintaReferencias();
  pinta("e10", () => t("opc.guardado"), true);
  // El resumen y «Quién transcribe» también llevan texto.
  revisaVoz();
});

// --- idioma y acta automática ---
$("idioma").addEventListener("change", async () => {
  await guardarConfig({ idioma: $("idioma").value });
  pinta("e5", () => t("opc.idiomaGuardado"), true);
});
async function guardaActa() {
  const prov = $("autoActaProv").value;
  const claves = await leerConfig();
  await guardarConfig({ autoActa: $("autoActa").checked, autoActaPlantilla: $("autoActaPlantilla").value, autoActaProv: prov });
  const nombreProv = $("autoActaProv").selectedOptions[0].textContent;
  // Sin la clave de la elegida, el acta la hace la primera IA que tenga la suya
  // (offscreen.js: actaAutomatica); si no la tiene ninguna, no hay acta.
  const otra = proveedorTexto(claves, prov);
  if ($("autoActa").checked && !tieneClave(claves, prov)) {
    if (otra) pinta("e6", () => t("opc.actaConOtro", nombreProv, provDe(otra).etiqueta), false);
    else pinta("e6", () => t("opc.actaFaltaClave", nombreProv), false);
  } else if ($("autoActa").checked && $("autoActaPlantilla").value === "personalizada" && !claves.plantillaPersonalizada) pinta("e6", () => t("opc.actaPlantillaVacia"), false);
  else if ($("autoActa").checked) pinta("e6", () => t("opc.actaAuto"), true);
  else pinta("e6", () => t("opc.actaManual"), true);
}
for (const id of ["autoActa", "autoActaPlantilla", "autoActaProv"]) $(id).addEventListener("change", guardaActa);

// --- conservar el audio ---
$("conservarAudio").addEventListener("change", async () => {
  await guardarConfig({ conservarAudio: $("conservarAudio").checked });
  pintaEspacio($("conservarAudio").checked ? () => t("opc.audioSi") : () => t("opc.audioNo"));
});
// `prefijo`: función que devuelve el texto que va delante (para repintarlo en otro idioma).
async function pintaEspacio(prefijo) {
  let mb = null;
  try {
    const e = await navigator.storage.estimate();
    if (e && typeof e.usage === "number") mb = (e.usage / 1048576).toFixed(0);
  } catch (_) {}
  pinta("e7", () => (prefijo ? prefijo() : "") + (mb !== null ? " " + t("opc.espacio", mb) : ""), prefijo ? true : null);
}

// --- aviso al entrar en una reunión ---
// El permiso de esas webs se pide aquí, con el clic del usuario (Chrome no deja
// pedirlo sin un gesto), y se retira al apagarlo.
$("avisoReunion").addEventListener("change", async () => {
  if ($("avisoReunion").checked) {
    const ok = await chrome.permissions.request({ origins: ORIGENES_REUNION }).catch(() => false);
    if (!ok) {
      $("avisoReunion").checked = false;
      pinta("e9", () => t("opc.avisoSinPermiso"), false);
      return;
    }
    await guardarConfig({ avisoReunion: true });
    pinta("e9", () => t("opc.avisoSi"), true);
  } else {
    await guardarConfig({ avisoReunion: false });
    chrome.permissions.remove({ origins: ORIGENES_REUNION }).catch(() => {});
    pinta("e9", () => t("opc.avisoNo"), true);
  }
});

async function pintaAtajo() {
  let atajo = "";
  try { atajo = ((await chrome.commands.getAll()).find((c) => c.name === "grabar") || {}).shortcut || ""; } catch (_) {}
  $("atajo").textContent = atajo ? t("opc.atajo", atajo) : t("opc.sinAtajo");
}

// --- precios para el coste estimado ---
// Temporizador propio: `guarda` comparte uno entre campos y, escribiendo rápido
// en dos, el primero no llegaría a guardarse.
let tPrecios = null;
async function guardaPrecios(mensajeOk) {
  const precios = {}, malos = [];
  for (const i of document.querySelectorAll(".precios input")) {
    const v = i.value.trim();
    if (v && !/^\d+([.,]\d+)?$/.test(v)) malos.push(v);
    (precios[i.dataset.prov] = precios[i.dataset.prov] || {})[i.dataset.tipo] = v;
  }
  await guardarConfig({ precios });
  if (malos.length) pinta("e8", () => t("opc.precioMalo", malos[0]), false);
  else pinta("e8", mensajeOk || (() => t("opc.preciosGuardados")), true);
}
for (const el of document.querySelectorAll(".precios input")) {
  el.addEventListener("input", () => {
    clearTimeout(tPrecios);
    tPrecios = setTimeout(() => guardaPrecios(), 400);
  });
}

// --- precios de referencia (config.js: PRECIOS_REFERENCIA) ---
// Para el modelo que usa cada proveedor (o el de por defecto, si aún no hay
// clave), el precio de lista pasado a euros. Se enseña como pista en cada
// casilla vacía y el botón lo escribe; nunca se pone solo.
// El precio por minuto son milésimas de euro: lleva cinco decimales.
const numeroUI = (n, decimales = 3) => n.toLocaleString(LOCALE_UI(), { maximumFractionDigits: decimales, useGrouping: false });
// Los modelos de un proveedor a los que se les busca precio: los que hay puestos
// en la página o, si no hay ninguno, los de por defecto del registro.
function modelosDePrecio(id) {
  const p = provDe(id), puesto = (campo) => ($(campo) ? $(campo).value.trim() : "");
  return { chat: puesto(p.campoModelo) || p.chat.modelo, voz: p.voz ? puesto(p.campoVoz) || p.voz.modelos[0] : "" };
}
// De una casilla: su precio de referencia (null si no lo hay) y el modelo del
// que sale. El audio va con el modelo que transcribe; el texto, con el que redacta.
function referenciaDe(casilla) {
  const { prov, tipo } = casilla.dataset, m = modelosDePrecio(prov);
  const modelo = tipo === "audio" || tipo === "minuto" ? m.voz : m.chat;
  const ref = precioReferencia(prov, modelo);
  return { modelo, precio: ref && typeof ref[tipo] === "number" ? ref[tipo] : null };
}
function pintaReferencias() {
  for (const id of provsVisibles()) {
    const m = modelosDePrecio(id);
    $("ref-" + id).textContent = [...new Set([transcribe(id) && m.voz, redacta(id) && m.chat].filter(Boolean))].join(" · ");
  }
  for (const i of document.querySelectorAll(".precios input")) {
    const { prov, tipo } = i.dataset, porMinuto = tipo === "minuto";
    const { precio } = referenciaDe(i);
    if (precio !== null) i.placeholder = "≈ " + numeroUI(precio, porMinuto ? 5 : 3);
    else i.placeholder = porMinuto ? t("opc.porMinuto") : t("opc.porMillon");
    if (tipo === "entrada") i.title = t("opc.tituloTexto");
    else if (tipo !== "salida") i.title = t("opc.tituloAudio", provDe(prov).nombre);
  }
  const f = new Date(PRECIOS_REFERENCIA.fecha + "T12:00:00").toLocaleDateString(LOCALE_UI(), { day: "numeric", month: "long", year: "numeric" });
  $("notaPreciosRef").textContent = t("opc.preciosRefNota", f, numeroUI(PRECIOS_REFERENCIA.dolaresPorEuro));
}
$("btnPreciosRef").onclick = async () => {
  const sinRef = new Set();
  for (const i of document.querySelectorAll(".precios input")) {
    const { modelo, precio } = referenciaDe(i);
    if (precio === null) sinRef.add(modelo);
    else i.value = numeroUI(precio, i.dataset.tipo === "minuto" ? 5 : 3);
  }
  clearTimeout(tPrecios);
  await guardaPrecios(() => t("opc.preciosCargados") + (sinRef.size ? " " + t("opc.preciosSinRef", [...sinRef].join(", ")) : ""));
};

// --- las claves de las demás IA: cada una en su tarjeta ---
// Al abrir, con la clave ya guardada: la lista de modelos de su tarjeta. Los
// nombres cambian cada pocos meses, y escribirlos a mano acaba en un 404. De
// paso se ve si la clave sigue valiendo.
async function cargaModelos(id, cfg) {
  const p = provDe(id), linea = "e-" + id;
  if (!tieneClave(cfg, id)) return;
  // Tener la clave no es tener el permiso: se puede retirar desde Chrome.
  if (!p.fijo && !(await chrome.permissions.contains({ origins: [p.host] }).catch(() => false))) {
    pinta(linea, () => t("opc.provFaltaPermiso", p.nombre), false);
    return;
  }
  try {
    const ids = await listarModelos(id, cfg[p.campoClave].trim());
    ponModelos(id, ids);
    if (redacta(id)) pinta(linea, () => t("opc.modelos", p.nombre, ids.length), true);
  } catch (e) {
    // La misma clave que al guardarla se dio por buena «sin lista» no puede salir
    // aquí como rechazada.
    if (claveSinLista(e)) pinta(linea, () => t("opc.provGuardadaSinLista", p.nombre, e.status), true);
    else pinta(linea, () => t("opc.noResponde", p.nombre, e.message), false);
  }
}

// El botón «Guardar» de una tarjeta. guardarClaveProveedor (config.js) empieza
// por pedir el permiso de Chrome, que solo se concede dentro del gesto del clic:
// por eso aquí no puede haber ningún `await` antes de llamarla.
async function guardaProveedor(id) {
  const p = provDe(id), linea = "e-" + id, boton = $("guardar-" + id);
  if (boton.disabled) return;
  const clave = $(p.campoClave).value.trim();
  const otros = redacta(id) ? { [p.campoModelo]: $(p.campoModelo).value.trim() } : {};
  boton.disabled = true;
  const respuesta = guardarClaveProveedor(id, clave, otros);
  if (clave) pinta(linea, () => t("opc.comprobandoClave"));
  let r;
  try {
    r = await respuesta;
  } catch (e) {
    r = { estado: "no_comprobada", status: 0, detalle: (e && e.message) || String(e) };
  } finally {
    boton.disabled = false;
  }
  if (r.estado === "sin_permiso") {
    pinta(linea, () => t("opc.provSinPermiso", p.nombre), false);
  } else if (r.estado === "clave_mala") {
    pinta(linea, () => t("opc.provClaveMala", p.nombre, r.status), false);
  } else if (r.estado === "no_comprobada") {
    if (r.status) pinta(linea, () => t("opc.provNoComprobada", p.nombre, r.status), false);
    else pinta(linea, () => t("opc.provSinRespuesta", p.nombre, r.detalle), false);
  } else {
    claveGuardada[id] = clave;
    ponModelos(id, r.modelos || []);
    if (r.estado === "borrada") {
      if (p.fijo) pinta(linea, () => t("opc.provBorrada"), true);
      else pinta(linea, () => t("opc.provBorradaPermiso", p.nombre), true);
    } else {
      // Como con la de Gemini: lo que esperaba una clave para transcribirse, se relanza.
      const pendientes = transcribe(id) ? await relanzaPendientes() : 0;
      const modelos = redacta(id) ? " · " + t("opc.modelos", p.nombre, r.modelos.length) : "";
      if (r.status) pinta(linea, () => t("opc.provGuardadaSinLista", p.nombre, r.status) + textoPendientes(pendientes), true);
      else pinta(linea, () => t("opc.provGuardada") + modelos + textoPendientes(pendientes), true);
    }
    pintaReferencias();
    // Con una clave más, o una menos, puede cambiar quién transcribe.
    revisaVoz();
  }
}

// --- avanzado: se guarda solo ---
// Cómo vuelve la pestaña a los altavoces mientras se graba (offscreen.js: abreAltavoz).
$("modoAltavoz").addEventListener("change", async () => {
  await guardarConfig({ modoAltavoz: $("modoAltavoz").value });
  pinta("e14", () => t("opc.altavozGuardado"), true);
});

// El glosario y la plantilla cuentan su «Guardado» debajo de sí mismos.
const LINEA_ESTADO = { glosario: "e12", plantillaPersonalizada: "e13" };
for (const id of ["glosario", "plantillaPersonalizada"]) {
  $(id).addEventListener("input", () => {
    guarda({ [id]: $(id).value.trim() });
    pinta(LINEA_ESTADO[id], () => t("opc.guardado"), true);
  });
}
