// Escriba — la IA que trabaja SOBRE la transcripción: actas con plantillas y
// preguntas a la reunión, con Gemini, GPT o Claude. La comparten el popup, la
// biblioteca y el documento offscreen (acta automática). Depende de comun.js.
//
// Hasta la 3.1 esto vivía en el popup, así que el acta solo podía pedirse con
// el popup abierto. Aquí no toca ni el DOM ni chrome.*: recibe la configuración
// y devuelve texto y tokens gastados; quien llama decide dónde guardarlo.

// t() la define i18n.js, que se carga antes. En Node (tests) se trae con require.
if (typeof t !== "function" && typeof require === "function") var t = require("./i18n.js").t;

const ESPERAS_IA = [3000, 8000, 20000];
// Si el modelo de Gemini sigue saturado tras los reintentos, se prueban estos por
// orden. Es la misma lista que usa la transcripción (offscreen.js): sin ella, un
// 503 de «high demand» dejaba la reunión sin acta (01/10).
const RESERVA_GEMINI_IA = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
// Errores que otro modelo puede no tener. Una clave rechazada (400/401/403) no:
// ahí se para enseguida.
const PASA_DE_MODELO = [404, 408, 429, 500, 502, 503, 504];

// --- plantillas -----------------------------------------------------------------------
// `nombre` es lo que ve el usuario (getter: sale en el idioma vigente al leerlo).
// `pide` va al modelo y se queda en español a propósito: el prompt pide responder
// en el idioma de la reunión.
const PLANTILLAS = {
  acta: {
    get nombre() { return t("ia.plantillaActa"); },
    pide: `Devuelve en markdown:
## Resumen ejecutivo
(5-10 líneas: de qué fue la reunión y qué se decidió)
## Decisiones tomadas
(lista concreta)
## Tareas y acciones
(tabla: responsable | tarea | plazo, si se menciona)
## Temas abiertos / dudas
(lo que quedó sin cerrar, y las partes que no se entienden bien y conviene confirmar)
## Datos citados
(cifras, fechas, referencias, nombres de sistemas mencionados)`,
  },
  resumen: {
    get nombre() { return t("ia.plantillaResumen"); },
    pide: `Devuelve un resumen en markdown de como máximo 8 viñetas, lo más importante primero. Una última línea «**En una frase:** …».`,
  },
  tareas: {
    get nombre() { return t("ia.plantillaTareas"); },
    pide: `Devuelve SOLO las tareas y compromisos, en una tabla markdown con columnas: Responsable | Tarea | Plazo | Contexto.
- El responsable es quien se compromete o a quien se le encarga; si no está claro, escribe «Sin asignar».
- El plazo, tal como se dijo; si no se dijo, «—».
- Debajo de la tabla, una lista «Pendiente de confirmar» con lo que sonó a tarea pero no quedó claro.`,
  },
  correo: {
    get nombre() { return t("ia.plantillaCorreo"); },
    pide: `Redacta el correo de seguimiento que se enviaría a los asistentes después de la reunión, listo para copiar y pegar:
- Una primera línea «Asunto: …».
- Saludo breve, resumen en 2-3 frases, decisiones, próximos pasos con responsable y fecha, y despedida.
- Tono profesional y cercano, en frases cortas. Sin inventar nada que no se haya dicho.`,
  },
  personalizada: {
    get nombre() { return t("ia.plantillaPersonalizada"); },
    pide: "", // la escribe el usuario en Opciones
  },
};

// contexto: { glosario, participantes, personalizada, notas, marcas }
function promptPlantilla(plantilla, contexto) {
  const c = contexto || {};
  const p = PLANTILLAS[plantilla] ? plantilla : "acta";
  let pide = PLANTILLAS[p].pide;
  if (p === "personalizada") pide = (c.personalizada || "").trim() || PLANTILLAS.acta.pide;
  return `Eres un asistente experto en reuniones de trabajo. Te paso la TRANSCRIPCIÓN AUTOMÁTICA de una reunión.
${contextoReunion(c)}
${pide}

Responde en el idioma de la reunión (en español si se mezclan). No inventes nada que no esté en la transcripción.`;
}

// Lo que el modelo tiene que saber de cualquier transcripción automática.
function contextoReunion(c) {
  let t = `Ten en cuenta que es automática:
- Las intervenciones pueden ir etiquetadas «Hablante 1/2…» o con el nombre, y llevar [MM:SS] con el minuto de la reunión.
- Habrá palabras mal transcritas, sobre todo nombres propios y términos técnicos.${c.glosario ? ` Glosario correcto del dominio: ${c.glosario}. Si una palabra suena parecida a una del glosario, asume que es esa.` : ""}
- Puede haber marcas [inaudible], frases cortadas y muletillas: interprétalas por contexto sin inventar contenido.`;
  if (c.participantes) t += `\n- Asistentes: ${c.participantes}.`;
  if (c.notas) t += `\n\nNotas que tomó el usuario durante la reunión (tenlas muy en cuenta):\n${c.notas}`;
  if (c.marcas && c.marcas.length) {
    t += "\n\nMomentos que el usuario marcó como importantes:\n" +
      c.marcas.map((m) => `- [${formatoTiempo(m.t)}] ${m.nota || "(sin nota)"}`).join("\n");
  }
  return t;
}

// El texto de la reunión tal como lo verá el modelo: con los nombres que haya
// puesto el usuario, no con «Hablante 1».
function textoParaIA(h) {
  return aplicarHablantes(h.transcript || "", h.hablantes);
}

// --- llamadas -------------------------------------------------------------------------
const NOMBRE_PROV = { gemini: "Gemini", gpt: "OpenAI", claude: "Anthropic" };
const esperaIA = (ms) => new Promise((r) => setTimeout(r, ms));

// Error que se enseña tal cual en la biblioteca y en el aviso del acta: en el
// idioma de la interfaz, con qué hacer y el código HTTP al final, nunca el JSON
// de la API.
function errorIA(nombre, status, cuerpo) {
  let detalle = "";
  try {
    const j = JSON.parse(cuerpo);
    detalle = (j && j.error && (j.error.message || j.error.type)) || "";
  } catch (_) { /* cuerpo que no es JSON: sin detalle */ }
  detalle = String(detalle).replace(/\s+/g, " ").trim().slice(0, 140);
  let txt;
  if (status === 401 || status === 403 || (status === 400 && /api[_ ]?key/i.test(detalle + " " + cuerpo))) {
    txt = t("ia.errClave", nombre);
  } else if (status === 429) {
    txt = t("ia.errLimite", nombre);
  } else if (status === 404) {
    txt = t("ia.errModelo", nombre);
  } else if (status === 408 || status >= 500) {
    txt = t("ia.errSaturado", nombre);
  } else {
    txt = detalle ? t("ia.errPeticionDetalle", nombre, detalle) : t("ia.errPeticion", nombre);
  }
  const e = new Error(`${txt} (HTTP ${status}).`);
  e.status = status;
  return e;
}

// Las tres APIs devuelven 429/503 de vez en cuando. Sin reintentos, un pico de
// carga de un segundo se lleva por delante el acta de una reunión de una hora.
async function fetchIA(nombre, url, opts, alEstado) {
  let ultimo = null;
  for (let intento = 0; ; intento++) {
    let r;
    try {
      r = await fetch(url, opts);
    } catch (e) {
      ultimo = new Error(t("ia.sinConexion", nombre, (e && e.message) || e));
      ultimo.status = 0;
      if (intento < ESPERAS_IA.length) { await esperaIA(ESPERAS_IA[intento]); continue; }
      throw ultimo;
    }
    if (r.ok) return r;
    ultimo = errorIA(nombre, r.status, (await r.text()).slice(0, 500));
    if ([408, 429, 500, 502, 503, 504].includes(r.status) && intento < ESPERAS_IA.length) {
      if (alEstado) alEstado("⏳ " + t("ia.reintentando", nombre, intento + 1, ESPERAS_IA.length));
      await esperaIA(ESPERAS_IA[intento]);
      continue;
    }
    throw ultimo;
  }
}

// Añade el motivo que dé la API, si lo da: sin esto un texto vacío no se
// distingue de un fallo de red.
function motivo(razon, cuerpo) {
  if (razon) return ` (${t("ia.motivo", razon)})`;
  const err = cuerpo && cuerpo.error && (cuerpo.error.message || cuerpo.error.type);
  return err ? ` (${String(err).slice(0, 120)})` : "";
}

// mensajes: [{ role: "user" | "assistant", content }] (el último, del usuario).
// Devuelve { texto, uso: { entrada, salida } }.
async function llamarIA(prov, cfg, sistema, mensajes, opciones) {
  const o = opciones || {};
  const msgs = typeof mensajes === "string" ? [{ role: "user", content: mensajes }] : mensajes;
  const nombre = NOMBRE_PROV[prov];
  if (!nombre) throw new Error(t("ia.provDesconocido", prov));

  if (prov === "gemini") {
    if (!cfg.geminiKey) throw new Error(t("ia.faltaClave", "Gemini"));
    // El elegido en Opciones primero; después, los de reserva que no sean él.
    const elegido = cfg.geminiModel || RESERVA_GEMINI_IA[0];
    const modelos = [elegido, ...RESERVA_GEMINI_IA.filter((m) => m !== elegido)];
    // Gemini no tiene «system» en generateContent de todos los modelos: va delante del primer turno.
    const contents = msgs.map((m, i) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: i === 0 ? sistema + "\n\n---\n" + m.content : m.content }],
    }));
    let r = null;
    for (let i = 0; i < modelos.length && !r; i++) {
      try {
        r = await fetchIA(nombre, `https://generativelanguage.googleapis.com/v1beta/models/${modelos[i]}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.geminiKey },
          // Margen amplio: en los modelos con razonamiento también gasta de aquí.
          body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 32768 } }),
        }, o.alEstado);
      } catch (e) {
        if (!PASA_DE_MODELO.includes(e.status) || i === modelos.length - 1) throw e;
        if (o.alEstado) o.alEstado("⏳ " + t("ia.cambioModelo", modelos[i], modelos[i + 1]));
      }
    }
    const d = await r.json();
    const cand = (d.candidates || [])[0];
    const texto = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").trim();
    if (!texto) throw new Error(t("ia.vacia", "Gemini") + motivo(cand && cand.finishReason, d));
    const u = d.usageMetadata || {};
    return { texto, uso: { entrada: u.promptTokenCount || 0, salida: u.candidatesTokenCount || 0 } };
  }

  if (prov === "gpt") {
    if (!cfg.openaiKey) throw new Error(t("ia.faltaClave", "OpenAI"));
    const r = await fetchIA(nombre, "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.openaiKey },
      body: JSON.stringify({ model: cfg.openaiModel || "gpt-4o", messages: [{ role: "system", content: sistema }, ...msgs] }),
    }, o.alEstado);
    // Un 200 no garantiza que venga texto: un filtro de contenido o un modelo
    // inexistente devuelven un cuerpo sin `choices`.
    const d = await r.json();
    const ch = (d.choices || [])[0];
    const texto = ((ch && ch.message && ch.message.content) || "").trim();
    if (!texto) throw new Error(t("ia.vacia", "OpenAI") + motivo(ch && ch.finish_reason, d));
    const u = d.usage || {};
    return { texto, uso: { entrada: u.prompt_tokens || 0, salida: u.completion_tokens || 0 } };
  }

  // claude
  if (!cfg.claudeKey) throw new Error(t("ia.faltaClave", "Anthropic"));
  const r = await fetchIA(nombre, "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.claudeKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: cfg.claudeModel || "claude-sonnet-5", max_tokens: 16384, system: sistema, messages: msgs }),
  }, o.alEstado);
  const d = await r.json();
  const texto = (Array.isArray(d.content) ? d.content : []).map((c) => c.text || "").join("").trim();
  if (!texto) throw new Error(t("ia.vacia", "Anthropic") + motivo(d.stop_reason, d));
  const u = d.usage || {};
  return { texto, uso: { entrada: u.input_tokens || 0, salida: u.output_tokens || 0 } };
}

const claveAnalisis = (plantilla, prov) => `${plantilla}·${prov}`;

// Acta, resumen, tareas… de una reunión. Devuelve { clave, texto, uso }.
async function analizarReunion(h, plantilla, prov, cfg, opciones) {
  const sistema = promptPlantilla(plantilla, {
    glosario: cfg.glosario, participantes: h.participantes, personalizada: cfg.plantillaPersonalizada,
    notas: h.notas, marcas: h.marcas,
  });
  const r = await llamarIA(prov, cfg, sistema, "---TRANSCRIPCIÓN---\n" + textoParaIA(h), opciones);
  return { clave: claveAnalisis(PLANTILLAS[plantilla] ? plantilla : "acta", prov), ...r };
}

// Pregunta sobre la reunión, con la conversación anterior. Devuelve { texto, uso }.
async function preguntarReunion(h, pregunta, prov, cfg, opciones) {
  const sistema = `Eres un asistente que responde preguntas sobre UNA reunión de trabajo a partir de su transcripción automática.
${contextoReunion({ glosario: cfg.glosario, participantes: h.participantes, notas: h.notas, marcas: h.marcas })}

Reglas:
- Responde solo con lo que diga la transcripción. Si no está, dilo claramente («No se habló de eso»).
- Cita el minuto [MM:SS] cuando lo haya, para que se pueda comprobar.
- Respuestas breves y directas, en el idioma de la pregunta.

---TRANSCRIPCIÓN---
${textoParaIA(h)}`;
  const mensajes = [];
  for (const m of h.chat || []) {
    mensajes.push({ role: "user", content: m.p }, { role: "assistant", content: m.r });
  }
  mensajes.push({ role: "user", content: pregunta });
  return llamarIA(prov, cfg, sistema, mensajes, opciones);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PLANTILLAS, promptPlantilla, llamarIA, analizarReunion, preguntarReunion, claveAnalisis, textoParaIA };
}
