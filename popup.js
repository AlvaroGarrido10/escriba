// TranscripcionesAG v2 — popup: control de grabación + historial + análisis IA.

const $ = (id) => document.getElementById(id);
let timerInt = null, itemAbierto = null, verAnalisis = null, ultimoIdVisto = null;

$("lnkOpc").onclick = () => chrome.runtime.openOptionsPage();
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
    // Si la última grabación acaba de terminar, ábrela automáticamente.
    if (ultimo && ultimo.estado !== "transcribiendo" && ultimo.id !== ultimoIdVisto && $("detalle").style.display !== "block") {
      ultimoIdVisto = ultimo.id;
      abrirDetalle(ultimo, false);
      $("detEstado").textContent = ultimo.estado === "ok"
        ? "✅ Transcripción lista (guardada en el historial y en Descargas/reuniones)."
        : "❌ La transcripción falló. Detalle arriba.";
    }
  }
});

init();
async function init() {
  // Primer uso: sin clave no se puede transcribir → llevar a la configuración.
  const { geminiKey } = await chrome.storage.sync.get({ geminiKey: "" });
  if (!geminiKey) {
    $("estado").innerHTML = '⚠️ Falta configurar la clave (1 min).';
    $("btnRec").textContent = "⚙️ Configurar ahora";
    $("btnRec").onclick = () => chrome.runtime.openOptionsPage();
    return;
  }
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  if (s && s.grabando) modoGrabando(s.t0);
  else pintaObjetivo(s && s.objetivo);
  const { historial } = await chrome.storage.local.get({ historial: [] });
  if (historial[0]) ultimoIdVisto = historial[0].estado !== "transcribiendo" ? historial[0].id : null;
  pintaHistorial();
}

// Muestra qué pestaña se va a grabar y avisa si no está sonando.
function pintaObjetivo(obj) {
  const modo = document.querySelector(".modo input:checked").value;
  if (modo !== "tab_mic") { $("estado").textContent = "🎙️ Se grabará solo tu micrófono."; return; }
  if (!obj) { $("estado").innerHTML = "⚠️ No hay ninguna pestaña con audio. Abre la reunión o usa «Solo micro»."; return; }
  const t = obj.titulo.length > 34 ? obj.titulo.slice(0, 34) + "…" : obj.titulo;
  $("estado").innerHTML = obj.suena
    ? `🔊 Se grabará: <b>${esc(t)}</b>`
    : `⚠️ <b>${esc(t)}</b> no está sonando. Dale al play en la reunión (o usa «Solo micro»).`;
}
document.querySelectorAll(".modo input").forEach(r => r.addEventListener("change", async () => {
  const s = await chrome.runtime.sendMessage({ target: "bg", cmd: "estado" });
  if (!s.grabando) pintaObjetivo(s.objetivo);
}));

$("btnRec").onclick = async () => {
  const grabando = $("btnRec").classList.contains("grabando");
  if (!grabando) {
    const modo = document.querySelector(".modo input:checked").value;
    $("estado").textContent = "Arrancando…";
    const r = await chrome.runtime.sendMessage({ target: "bg", cmd: "start", modo });
    if (r && r.ok) modoGrabando(Date.now());
    else $("estado").textContent = "❌ " + ((r && r.error) || "No se pudo iniciar");
  } else {
    await chrome.runtime.sendMessage({ target: "bg", cmd: "stop" });
    clearInterval(timerInt);
    $("btnRec").textContent = "⏺ Empezar a grabar";
    $("btnRec").classList.remove("grabando");
    $("estado").textContent = "⏳ Transcribiendo… (aparecerá aquí en cuanto esté)";
    pintaHistorial();
  }
};

function modoGrabando(t0) {
  $("btnRec").textContent = "⏹ Parar y transcribir";
  $("btnRec").classList.add("grabando");
  $("estado").textContent = "🔴 Grabando…";
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
  escribe("🩺 Diagnóstico TranscripcionesAG\n");

  // 1. Configuración
  const cfg = await chrome.storage.sync.get({ geminiKey: "", geminiModel: "gemini-flash-lite-latest" });
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
    if (!r.bytes) escribe("   ⚠️ 0 KB: no entra sonido. En modo pestaña, la pestaña debe estar sonando.");
    escribe("5. Transcripción de prueba .. " + (r.transcripcion ? "OK" : "FALLA"));
    if (r.transcripcion) escribe("   Texto: " + r.transcripcion.slice(0, 90));
    if (r.errorTranscripcion) escribe("   → " + r.errorTranscripcion.slice(0, 160));
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
      : '<span class="badge-estado proc">transcribiendo…</span>';
    div.innerHTML = `<div class="tit">${esc(h.titulo)} ${badge}</div><div class="fec">${h.fecha}</div><div class="acc"></div>`;
    const acc = div.querySelector(".acc");
    if (h.estado !== "transcribiendo") {
      boton(acc, h.estado === "ok" ? "📄 Ver transcripción" : "⚠️ Ver error", () => abrirDetalle(h, false));
      for (const prov of Object.keys(h.analisis || {})) boton(acc, "🔎 Análisis " + prov, () => abrirDetalle(h, prov));
      boton(acc, "🗑", async () => {
        const { historial } = await chrome.storage.local.get({ historial: [] });
        await chrome.storage.local.set({ historial: historial.filter(x => x.id !== h.id) });
        pintaHistorial();
      });
    }
    cont.appendChild(div);
  }
}
function boton(parent, txt, fn) { const b = document.createElement("button"); b.textContent = txt; b.onclick = fn; parent.appendChild(b); }
function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }

// ---------- Detalle + análisis ----------
function abrirDetalle(h, prov) {
  itemAbierto = h; verAnalisis = prov || null;
  $("panelGrabar").style.display = "none";
  $("detalle").style.display = "block";
  $("detTitulo").textContent = (prov ? `Análisis (${prov}) — ` : (h.estado === "error" ? "Error — " : "Transcripción — ")) + h.fecha;
  $("detTexto").value = prov ? h.analisis[prov] : h.transcript;
  $("detEstado").textContent = "";
}
document.querySelector("#detalle .volver").onclick = () => {
  $("detalle").style.display = "none";
  $("panelGrabar").style.display = "block";
  pintaHistorial();
};
$("detCopiar").onclick = async () => { await navigator.clipboard.writeText($("detTexto").value); $("detEstado").textContent = "📋 Copiado."; };
$("detDescargar").onclick = () => {
  const nombre = (verAnalisis ? "analisis_" + verAnalisis + "_" : "reunion_") + itemAbierto.id + ".md";
  const url = "data:text/markdown;charset=utf-8," + encodeURIComponent($("detTexto").value);
  chrome.runtime.sendMessage({ target: "bg", cmd: "descargar", url, filename: "reuniones/" + nombre });
  $("detEstado").textContent = "💾 Descargado en Descargas/reuniones.";
};

document.querySelectorAll("button.ia").forEach(b => b.onclick = async () => {
  const prov = b.dataset.prov;
  $("detEstado").textContent = `⏳ Analizando con ${prov}…`;
  try {
    const analisis = await analizar(prov, itemAbierto.transcript);
    const { historial } = await chrome.storage.local.get({ historial: [] });
    const i = historial.findIndex(x => x.id === itemAbierto.id);
    historial[i].analisis = historial[i].analisis || {};
    historial[i].analisis[prov] = analisis;
    await chrome.storage.local.set({ historial });
    itemAbierto = historial[i];
    abrirDetalle(itemAbierto, prov);
    $("detEstado").textContent = "✅ Análisis listo (guardado en el historial).";
  } catch (e) {
    $("detEstado").textContent = "❌ " + (e.message || e);
  }
});

// ---------- Análisis con las 3 IAs ----------
function promptAnalisis(glosario) {
  return `Eres un asistente experto en actas de reunión. Te paso la TRANSCRIPCIÓN AUTOMÁTICA de una reunión de trabajo en español.

Ten en cuenta que es una transcripción automática:
- Puede haber varias personas hablando (a veces etiquetadas como "Hablante 1/2...", a veces sin separar).
- Habrá palabras mal transcritas, sobre todo nombres propios y términos técnicos. Glosario correcto del dominio: ${glosario}. Si una palabra suena parecida a una del glosario, asume que es esa.
- Puede haber marcas [inaudible], frases cortadas y muletillas: interprétalas por contexto sin inventar contenido.

Devuelve en markdown, en español:
## Resumen ejecutivo
(5-10 líneas: de qué fue la reunión y qué se decidió)
## Decisiones tomadas
(lista concreta)
## Tareas y acciones
(quién, qué, y plazo si se menciona — tabla)
## Temas abiertos / dudas
(lo que quedó sin cerrar, y las partes de la transcripción que no se entienden bien y conviene confirmar)
## Datos citados
(cifras, fechas, referencias, nombres de sistemas mencionados)`;
}

async function analizar(prov, transcript) {
  const cfgd = await chrome.storage.sync.get({
    geminiKey: "", geminiModel: "gemini-flash-lite-latest",
    openaiKey: "", openaiModel: "gpt-4o",
    claudeKey: "", claudeModel: "claude-sonnet-5",
    glosario: "",
  });
  const sys = promptAnalisis(cfgd.glosario);

  if (prov === "gemini") {
    if (!cfgd.geminiKey) throw new Error("Falta la clave de Gemini en Opciones.");
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfgd.geminiModel}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfgd.geminiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: sys + "\n\n---TRANSCRIPCIÓN---\n" + transcript }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } }),
    });
    if (!r.ok) throw new Error("Gemini HTTP " + r.status + ": " + (await r.text()).slice(0, 150));
    const d = await r.json();
    return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();

  } else if (prov === "gpt") {
    if (!cfgd.openaiKey) throw new Error("Falta la clave de OpenAI en Opciones.");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfgd.openaiKey },
      body: JSON.stringify({ model: cfgd.openaiModel, messages: [{ role: "system", content: sys }, { role: "user", content: transcript }], temperature: 0.3 }),
    });
    if (!r.ok) throw new Error("OpenAI HTTP " + r.status + ": " + (await r.text()).slice(0, 150));
    return (await r.json()).choices[0].message.content.trim();

  } else if (prov === "claude") {
    if (!cfgd.claudeKey) throw new Error("Falta la clave de Anthropic en Opciones.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfgd.claudeKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: cfgd.claudeModel, max_tokens: 8192, system: sys, messages: [{ role: "user", content: transcript }] }),
    });
    if (!r.ok) throw new Error("Anthropic HTTP " + r.status + ": " + (await r.text()).slice(0, 150));
    const d = await r.json();
    return d.content.map(c => c.text || "").join("").trim();
  }
  throw new Error("Proveedor desconocido");
}
