// TranscriptorGod — configuración: valida la clave, elige modelo y guarda sola.

const DEFAULTS = {
  geminiKey: "", geminiModel: "",
  openaiKey: "", openaiModel: "gpt-4o",
  claudeKey: "", claudeModel: "claude-sonnet-5",
  glosario: "",
};
const $ = (id) => document.getElementById(id);
const BASE = "https://generativelanguage.googleapis.com";
// Orden de preferencia: calidad/latencia razonables y disponibles para claves nuevas.
const MODELOS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-pro-latest", "gemini-2.0-flash"];

function pinta(id, txt, ok) {
  const e = $(id);
  e.textContent = txt;
  e.className = "estado" + (ok === true ? " ok" : ok === false ? " err" : "");
}

let guardando = null;
async function guarda(campos) {
  clearTimeout(guardando);
  guardando = setTimeout(() => chrome.storage.sync.set(campos), 200);
}

// --- carga inicial ---
(async () => {
  const d = await chrome.storage.sync.get(DEFAULTS);
  for (const k of ["geminiKey", "geminiModel", "openaiKey", "openaiModel", "claudeKey", "claudeModel", "glosario"]) $(k).value = d[k] || "";
  if (d.geminiKey) validarClave(d.geminiKey, d.geminiModel);
  revisarMicro();
})();

// --- paso 1: clave (se valida y guarda sola al pegar/escribir) ---
let t1 = null;
$("geminiKey").addEventListener("input", () => {
  clearTimeout(t1);
  const k = $("geminiKey").value.trim();
  if (!k) { pinta("e1", "", null); $("p1").classList.remove("listo"); return; }
  pinta("e1", "Comprobando la clave…");
  t1 = setTimeout(() => validarClave(k), 500);
});

async function validarClave(key, modeloGuardado) {
  try {
    const r = await fetch(`${BASE}/v1beta/models`, { headers: { "x-goog-api-key": key } });
    if (!r.ok) throw new Error("La clave no es válida (HTTP " + r.status + ")");
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
    if (!elegido) throw new Error("La clave funciona, pero ningún modelo está disponible ahora mismo. Reintenta en unos minutos.");

    $("geminiModel").value = elegido;
    await chrome.storage.sync.set({ geminiKey: key, geminiModel: elegido });
    $("p1").classList.add("listo");
    pinta("e1", `✅ Clave válida · modelo: ${elegido}`, true);
    listo();
  } catch (e) {
    $("p1").classList.remove("listo");
    pinta("e1", "❌ " + e.message, false);
  }
}

// --- paso 2: micrófono ---
async function revisarMicro() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    if (p.state === "granted") { $("p2").classList.add("listo"); pinta("e2", "✅ Micrófono permitido", true); listo(); }
  } catch (_) {}
}
$("btnMic").onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    $("p2").classList.add("listo");
    pinta("e2", "✅ Micrófono permitido", true);
    listo();
  } catch (e) {
    pinta("e2", "❌ Permiso denegado. Pulsa el candado 🔒 de la barra de direcciones y permite el micrófono.", false);
  }
};

function listo() {
  if ($("p1").classList.contains("listo") && $("p2").classList.contains("listo")) {
    $("final").textContent = "🎉 Todo listo. Cierra esta pestaña y pulsa el icono 🎙️ para grabar tu reunión.";
  }
}

// --- avanzado: se guarda solo ---
for (const id of ["glosario", "openaiKey", "openaiModel", "claudeKey", "claudeModel"]) {
  $(id).addEventListener("input", () => {
    guarda({ [id]: $(id).value.trim() });
    pinta("e3", "Guardado ✓", true);
  });
}
