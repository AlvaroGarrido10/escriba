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
  const e = $(id);
  e.textContent = texto();
  e.className = "estado" + (ok === true ? " ok" : ok === false ? " err" : "");
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

// --- carga inicial ---
(async () => {
  await cargarIdiomaUI();
  await migrarConfig();
  const d = await leerConfig();
  for (const k of ["geminiKey", "geminiModel", "openaiKey", "openaiModel", "claudeKey", "claudeModel", "glosario", "plantillaPersonalizada"]) $(k).value = d[k] || "";
  $("idiomaUI").value = d.idiomaUI || "auto";
  $("idioma").value = d.idioma || "es";
  $("autoActa").checked = !!d.autoActa;
  $("autoActaPlantilla").value = d.autoActaPlantilla || "acta";
  $("autoActaProv").value = d.autoActaProv || "gemini";
  $("conservarAudio").checked = !!d.conservarAudio;
  for (const el of document.querySelectorAll(".precios input")) el.value = ((d.precios || {})[el.dataset.prov] || {})[el.dataset.tipo] || "";
  // Activado solo si además sigue el permiso: el usuario puede retirarlo desde Chrome.
  $("avisoReunion").checked = !!d.avisoReunion && await chrome.permissions.contains({ origins: ORIGENES_REUNION }).catch(() => false);
  pintaAtajo();
  cargaModelos(d);
  pintaEspacio();
  if (d.geminiKey) validarClave(d.geminiKey, d.geminiModel);
  revisarMicro();
})();

// --- paso 1: clave (se valida y guarda sola al pegar/escribir) ---
let t1 = null;
$("geminiKey").addEventListener("input", () => {
  clearTimeout(t1);
  const k = $("geminiKey").value.trim();
  if (!k) { pinta("e1", "", null); $("p1").classList.remove("listo"); return; }
  pinta("e1", () => t("opc.comprobandoClave"));
  t1 = setTimeout(() => validarClave(k), 500);
});

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

    $("geminiModel").value = elegido;
    await guardarConfig({ geminiKey: key, geminiModel: elegido });
    $("p1").classList.add("listo");
    // Guardar una clave nueva reintenta solo lo que estaba esperando por ella
    // (lo hace el service worker); aquí solo se cuenta, para que se sepa.
    const { historial } = await chrome.storage.local.get({ historial: [] });
    // Al cargar la página se revalida la clave ya guardada: eso no dispara nada.
    const esNueva = modeloGuardado === undefined;
    const pendientes = esNueva ? historial.filter((h) => h.estado === "pendiente").length : 0;
    // El service worker ya reacciona al cambio de clave, pero si se pega la
    // misma que había, Chrome no avisa de ningún cambio: se pide explícitamente.
    if (pendientes) chrome.runtime.sendMessage({ target: "bg", cmd: "claveNueva" }).catch(() => {});
    pinta("e1", () => t("opc.claveValida", elegido) +
      (pendientes ? " · " + (pendientes > 1 ? t("opc.reintentandoN", pendientes) : t("opc.reintentando1", pendientes)) : ""), true);
    listo();
  } catch (e) {
    $("p1").classList.remove("listo");
    pinta("e1", () => "❌ " + (e.texto ? e.texto() : e.message), false);
  }
}

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

function listo() {
  if ($("p1").classList.contains("listo") && $("p2").classList.contains("listo")) {
    pinta("final", () => t("opc.todoListo"), true);
  }
}

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
  const n = Math.max(1, Math.min(200, parseInt($("limite").value, 10) || 10));
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
  repintaEstados();
  pinta("e10", () => t("opc.guardado"), true);
});

// --- idioma y acta automática ---
$("idioma").addEventListener("change", async () => {
  await guardarConfig({ idioma: $("idioma").value });
  pinta("e5", () => t("opc.idiomaGuardado"), true);
});
async function guardaActa() {
  const prov = $("autoActaProv").value;
  const claves = await leerConfig();
  const falta = { gemini: "geminiKey", gpt: "openaiKey", claude: "claudeKey" }[prov];
  await guardarConfig({ autoActa: $("autoActa").checked, autoActaPlantilla: $("autoActaPlantilla").value, autoActaProv: prov });
  const nombreProv = $("autoActaProv").selectedOptions[0].textContent;
  if ($("autoActa").checked && !claves[falta]) pinta("e6", () => t("opc.actaFaltaClave", nombreProv), false);
  else if ($("autoActa").checked && $("autoActaPlantilla").value === "personalizada" && !claves.plantillaPersonalizada) pinta("e6", () => t("opc.actaPlantillaVacia"), false);
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
  pinta("atajo", () => (atajo ? t("opc.atajo", atajo) : t("opc.sinAtajo")));
}

// --- precios para el coste estimado ---
// Temporizador propio: `guarda` comparte uno entre campos y, escribiendo rápido
// en dos, el primero no llegaría a guardarse.
let tPrecios = null;
for (const el of document.querySelectorAll(".precios input")) {
  el.addEventListener("input", () => {
    clearTimeout(tPrecios);
    tPrecios = setTimeout(async () => {
      const precios = {}, malos = [];
      for (const i of document.querySelectorAll(".precios input")) {
        const v = i.value.trim();
        if (v && !/^\d+([.,]\d+)?$/.test(v)) malos.push(v);
        (precios[i.dataset.prov] = precios[i.dataset.prov] || {})[i.dataset.tipo] = v;
      }
      await guardarConfig({ precios });
      if (malos.length) pinta("e8", () => t("opc.precioMalo", malos[0]), false);
      else pinta("e8", () => t("opc.preciosGuardados"), true);
    }, 400);
  });
}

// --- modelos de GPT y Claude, leídos de sus APIs con la clave del usuario ---
// Los nombres cambian cada pocos meses: escribirlos a mano acaba en un 404.
async function cargaModelos(d) {
  const cfg = d || await leerConfig();
  const pon = (id, ids) => { $(id).innerHTML = ids.map((m) => `<option value="${m}">`).join(""); };
  // Funciones que devuelven cada aviso, para repintarlos si cambia el idioma.
  const avisos = [];
  let fallo = false;
  if (cfg.openaiKey) {
    try {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer " + cfg.openaiKey } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const ids = ((await r.json()).data || []).map((m) => m.id).filter((m) => /^(gpt|o\d|chatgpt)/.test(m) && !/(audio|realtime|tts|transcribe|image|search|embedding)/.test(m)).sort().reverse();
      pon("modelosOpenai", ids);
      avisos.push(() => t("opc.modelos", "OpenAI", ids.length));
    } catch (e) { fallo = true; avisos.push(() => t("opc.noResponde", "OpenAI", e.message)); }
  }
  if (cfg.claudeKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { "x-api-key": cfg.claudeKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const ids = ((await r.json()).data || []).map((m) => m.id);
      pon("modelosClaude", ids);
      avisos.push(() => t("opc.modelos", "Anthropic", ids.length));
    } catch (e) { fallo = true; avisos.push(() => t("opc.noResponde", "Anthropic", e.message)); }
  }
  if (avisos.length) pinta("e3", () => avisos.map((a) => a()).join(" · "), !fallo);
}
let tModelos = null;
for (const id of ["openaiKey", "claudeKey"]) {
  $(id).addEventListener("input", () => { clearTimeout(tModelos); tModelos = setTimeout(() => cargaModelos(), 1200); });
}

// --- avanzado: se guarda solo ---
for (const id of ["glosario", "plantillaPersonalizada", "openaiKey", "openaiModel", "claudeKey", "claudeModel"]) {
  $(id).addEventListener("input", () => {
    guarda({ [id]: $(id).value.trim() });
    pinta("e3", () => t("opc.guardado"), true);
  });
}
