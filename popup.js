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
  $("avisoMicTxt").textContent = modo === "mic"
    ? "En modo «Solo micro» no se grabará nada."
    : "Solo se grabará la pestaña: tu voz no saldrá en la transcripción.";
  $("avisoMic").style.display = micOk ? "none" : "block";
}
document.querySelectorAll(".modo input").forEach(r => r.addEventListener("change", pintaModo));
function pintaModo() {
  document.querySelectorAll(".modo label").forEach(l => l.classList.remove("sel"));
  document.querySelector(".modo input:checked").closest("label").classList.add("sel");
}
pintaModo();

// Repintar en cuanto la transcripción termine (aunque el popup esté abierto).
chrome.storage.onChanged.addListener((cambios, area) => {
  if (area === "local" && cambios.historial) {
    const nuevos = cambios.historial.newValue || [];
    pintaHistorial();
    const ultimo = nuevos[0];
    // Mientras trocea y transcribe, ir cantando por dónde va.
    if (ultimo && ultimo.estado === "transcribiendo" && ultimo.progreso) {
      $("estado").textContent = `⏳ Transcribiendo… ${ultimo.progreso}`;
    }
    // Si la última grabación acaba de terminar, se avisa con un botón para abrirla.
    if (ultimo && ESTADOS_FINALES.includes(ultimo.estado) && ultimo.id !== ultimoIdVisto) {
      ultimoIdVisto = ultimo.id;
      avisaLista(ultimo);
    }
  }
});

const ESTADOS_FINALES = ["ok", "pendiente", "error"];

function avisaLista(h) {
  const caja = $("listo");
  const txt = h.estado === "ok" ? "✅ Transcripción lista"
    : h.estado === "pendiente" ? "⏳ Falta algún tramo; su audio está a salvo y se reintentará sola"
      : "❌ La transcripción falló";
  caja.innerHTML = `${txt}: <b>${esc(h.titulo)}</b>. `;
  const b = document.createElement("button");
  b.textContent = "📖 Abrir";
  b.style.cssText = "font-size:11px;padding:3px 8px;border:1px solid #2e7d32;background:#fff;color:#1f5b22;border-radius:5px;cursor:pointer;margin-left:4px";
  b.onclick = () => abrirBiblioteca(h.id);
  caja.appendChild(b);
  caja.style.display = "block";
  $("estado").textContent = "";
}

$("btnImportar").onclick = () => chrome.tabs.create({ url: "importar.html" });

init();
async function init() {
  // Lo que quedó pendiente se reintenta al abrir el popup, sin esperar a la
  // alarma (el service worker decide si ya toca). No se espera la respuesta.
  chrome.runtime.sendMessage({ target: "bg", cmd: "revisarPendientes" }).catch(() => {});
  // Primer uso: sin clave no se puede transcribir → llevar a la configuración.
  const { geminiKey } = await leerConfig();
  if (!geminiKey) {
    $("estado").innerHTML = '⚠️ Falta configurar la clave (1 min).';
    $("btnRec").textContent = "⚙️ Configurar ahora";
    $("btnRec").onclick = () => chrome.runtime.openOptionsPage();
    pintaHistorial(); // el historial se ve igual: puede haber reuniones esperando la clave
    return;
  }
  await revisaMicro();
  const { participantesBorrador } = await chrome.storage.session.get({ participantesBorrador: "" });
  $("participantes").value = participantesBorrador;
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  if (s && s.grabando) modoGrabando(s.t0);
  else pintaObjetivo(s && s.objetivo);
  const { historial } = await chrome.storage.local.get({ historial: [] });
  if (historial[0]) ultimoIdVisto = ESTADOS_FINALES.includes(historial[0].estado) ? historial[0].id : null;
  pintaHistorial();
}

// Muestra qué pestaña se va a grabar y avisa si no está sonando.
function pintaObjetivo(obj) {
  const modo = document.querySelector(".modo input:checked").value;
  if (modo === "mic") { $("estado").textContent = "🎙️ Se grabará solo tu micrófono."; return; }
  if (!obj) { $("estado").innerHTML = "⚠️ No hay ninguna pestaña con audio. Abre la reunión o usa «Solo micro»."; return; }
  const t = obj.titulo.length > 34 ? obj.titulo.slice(0, 34) + "…" : obj.titulo;
  $("estado").innerHTML = obj.suena
    ? `🔊 Se grabará: <b>${esc(t)}</b>`
    : `⚠️ <b>${esc(t)}</b> no está sonando. Dale al play en la reunión (o usa «Solo micro»).`;
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
    $("estado").textContent = "Arrancando…";
    const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "start", modo, participantes: $("participantes").value.trim() });
    if (r && r.ok) modoGrabando(Date.now());
    else $("estado").textContent = "❌ " + ((r && r.error) || "No se pudo iniciar");
  } else {
    await chrome.runtime.sendMessage({ target: "bg", cmd: "stop" });
    clearInterval(timerInt);
    $("btnRec").textContent = "⏺ Empezar a grabar";
    $("btnRec").classList.remove("grabando");
    $("estado").textContent = "⏳ Transcribiendo… (aparecerá aquí en cuanto esté)";
    $("participantes").value = "";
    $("participantes").disabled = false;
    chrome.storage.session.set({ participantesBorrador: "" });
    pintaHistorial();
  }
};

function modoGrabando(t0) {
  $("btnRec").textContent = "⏹ Parar y transcribir";
  $("btnRec").classList.add("grabando");
  $("estado").textContent = "🔴 Grabando…";
  $("participantes").disabled = true;
  clearInterval(timerInt);
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $("timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 500);
}

// ---------- Diagnóstico ----------
$("btnDiag").onclick = async () => {
  const out = $("diag");
  out.style.display = "block";
  const log = [];
  const escribe = (l) => { log.push(l); out.textContent = log.join("\n"); };
  escribe("🩺 Diagnóstico de Escriba\n");

  // 1. Configuración
  const cfg = await leerConfig();
  escribe(cfg.geminiKey ? `1. Clave guardada .......... OK (${cfg.geminiKey.slice(0, 6)}…)` : "1. Clave guardada .......... FALTA → ve a Opciones");
  escribe(`   Modelo: ${cfg.geminiModel}`);

  // 2. La clave habla con Gemini
  if (cfg.geminiKey) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": cfg.geminiKey } });
      escribe(r.ok ? "2. Conexión con Gemini ..... OK" : `2. Conexión con Gemini ..... FALLA (HTTP ${r.status})`);
    } catch (e) { escribe("2. Conexión con Gemini ..... FALLA (" + e.message + ")"); }
  }

  // 3. Permiso de micrófono (origen de la extensión)
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    escribe(`3. Permiso micrófono ....... ${p.state === "granted" ? "OK" : p.state.toUpperCase() + " → Opciones ▸ Permitir micrófono"}`);
  } catch (e) { escribe("3. Permiso micrófono ....... ? (" + e.message + ")"); }

  // 4. Motor de grabación (offscreen) + captura real de 3 s
  escribe("4. Grabador (3 s de prueba). …");
  const modo = document.querySelector(".modo input:checked").value;
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "selftest", modo });
  if (!r || !r.ok) {
    escribe("   → FALLA: " + ((r && r.error) || "sin respuesta del grabador"));
  } else {
    escribe(`   → Audio capturado: ${(r.bytes / 1024).toFixed(0)} KB  (${r.fuentes})`);
    if (r.niveles) escribe(`   → Niveles: ${r.niveles}`);
    if (!r.bytes) escribe("   ⚠️ 0 KB: no entra sonido. En modo pestaña, la pestaña debe estar sonando.");
    if (r.silencio) {
      escribe("   ⚠️ SILENCIO: se graba, pero no entra voz por ninguna fuente.");
      escribe("      Habla al micro mientras dura la prueba, o pon la reunión a sonar.");
      escribe("5. Transcripción de prueba .. NO PROBADA (no se manda silencio a Gemini:");
      escribe("      con audio mudo se inventa una reunión entera).");
    } else {
      escribe("5. Transcripción de prueba .. " + (r.transcripcion ? "OK" : "FALLA"));
      if (r.transcripcion) escribe("   Texto: " + r.transcripcion.slice(0, 90));
      if (r.errorTranscripcion) escribe("   → " + r.errorTranscripcion.slice(0, 160));
    }
  }
  escribe("\nCopia esto y pásaselo a quien te ayude.");
};

// ---------- Historial ----------
async function pintaHistorial() {
  const { historial } = await chrome.storage.local.get({ historial: [] });
  const cont = $("historial");
  cont.innerHTML = "";
  if (!historial.length) { cont.innerHTML = '<div style="font-size:11px;color:#999">Aún no hay grabaciones.</div>'; return; }
  for (const h of historial) {
    const div = document.createElement("div");
    div.className = "item";
    const badge = h.estado === "ok" ? '<span class="badge-estado ok">lista</span>'
      : h.estado === "error" ? '<span class="badge-estado err">error</span>'
      : h.estado === "pendiente" ? '<span class="badge-estado pend">incompleta</span>'
      : h.estado === "grabando" ? '<span class="badge-estado rec">● grabando</span>'
      : `<span class="badge-estado proc">transcribiendo… ${esc(h.progreso || "")}</span>`;
    const icono = h.origen === "archivo" ? "📂 " : "";
    div.innerHTML = `<div class="tit">${icono}${esc(h.titulo)} ${badge}</div><div class="fec">${esc(h.fecha)}</div>` +
      (h.estado === "pendiente" ? `<div class="nota">${esc(notaPendiente(h))}</div>` : "") + '<div class="acc"></div>';
    const acc = div.querySelector(".acc");
    if (ESTADOS_FINALES.includes(h.estado)) {
      if (h.estado === "pendiente") boton(acc, "🔄 Reintentar ahora", (ev) => reintentar(ev.target, h));
      const nActas = Object.keys(h.analisis || {}).length;
      boton(acc, h.estado === "error" ? "⚠️ Ver error" : "📖 Abrir" + (nActas ? ` · ${nActas} acta${nActas > 1 ? "s" : ""}` : ""), () => abrirBiblioteca(h.id));
      boton(acc, "🗑", () => pideBorrar(acc, h));
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
  let luego = "se reintentará sola";
  if (re.esperaClave) {
    luego = codigo === "sin_clave" ? "falta la clave: ponla en Opciones y se reintentará sola"
      : "Google rechaza la clave: pon una nueva en Opciones y se reintentará sola";
  } else if (re.agotado) {
    luego = "ya no se reintenta sola: pulsa «Reintentar ahora»";
  } else if (re.proximo) {
    const d = new Date(re.proximo);
    luego = `se reintentará sola a las ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const cuantos = r.total === 1 ? "El tramo está" : `${r.pendientes} de ${r.total} tramos están`;
  return `${cuantos} sin transcribir · ${luego}`;
}

async function reintentar(btn, h) {
  btn.disabled = true;
  btn.textContent = "⏳ Reintentando…";
  const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "reintentar", id: h.id });
  if (!r || !r.ok) {
    btn.disabled = false;
    btn.textContent = "🔄 Reintentar ahora";
    $("estado").textContent = "❌ " + ((r && r.error) || "No se pudo reintentar.");
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
  caja.innerHTML = "<b>¿Borrar esta transcripción?</b><br>Se borrará también su <code>.md</code> de Descargas/reuniones."
    + (nAudio ? `<label style="display:block;margin-top:5px"><input type="checkbox" class="cbAudio" checked> Borrar también su audio de respaldo (${nAudio} fichero${nAudio > 1 ? "s" : ""})</label>` : "");
  const fila = document.createElement("div");
  fila.style.cssText = "display:flex;gap:4px;margin-top:6px";
  boton(fila, "Sí, borrar", async () => {
    const cb = caja.querySelector(".cbAudio");
    await chrome.runtime.sendMessage({ target: "bg", cmd: "borrar", ids: [h.id], conAudio: !!(cb && cb.checked) });
    pintaHistorial();
  });
  boton(fila, "Cancelar", () => pintaHistorial());
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
  caja.innerHTML = `<b>¿Borrar las ${historial.length} transcripciones?</b><br>`
    + "Se borrarán del historial y sus <code>.md</code> de Descargas/reuniones. No hay vuelta atrás."
    + (nAudio ? `<label style="display:block;margin-top:5px"><input type="checkbox" id="cbAudioTodo" checked> Borrar también el audio de respaldo (${nAudio} fichero${nAudio > 1 ? "s" : ""})</label>` : "");
  const fila = document.createElement("div");
  fila.style.cssText = "display:flex;gap:4px;margin-top:6px";
  boton(fila, "Sí, borrar todo", async () => {
    const cb = $("cbAudioTodo");
    const r = await chrome.runtime.sendMessage({
      target: "bg", cmd: "borrar", ids: historial.map((h) => h.id), conAudio: !!(cb && cb.checked),
    });
    caja.style.display = "none";
    pintaHistorial();
    $("estado").textContent = `🗑 Borradas ${r.entradas} transcripciones y ${r.ficheros} ficheros.`;
  });
  boton(fila, "Cancelar", () => { caja.style.display = "none"; });
  caja.appendChild(fila);
};
function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
