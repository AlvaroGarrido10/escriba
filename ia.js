// Escriba — la IA que trabaja SOBRE la transcripción: actas con plantillas y
// preguntas a la reunión, con Gemini, GPT o Claude. La comparten el popup, la
// biblioteca y el documento offscreen (acta automática). Depende de comun.js.
//
// Hasta la 3.1 esto vivía en el popup, así que el acta solo podía pedirse con
// el popup abierto. Aquí no toca ni el DOM ni chrome.*: recibe la configuración
// y devuelve texto y tokens gastados; quien llama decide dónde guardarlo.

const ESPERAS_IA = [3000, 8000, 20000];

// --- plantillas -----------------------------------------------------------------------
const PLANTILLAS = {
  acta: {
    nombre: "Acta completa",
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
    nombre: "Resumen breve",
    pide: `Devuelve un resumen en markdown de como máximo 8 viñetas, lo más importante primero. Una última línea «**En una frase:** …».`,
  },
  tareas: {
    nombre: "Tareas y responsables",
    pide: `Devuelve SOLO las tareas y compromisos, en una tabla markdown con columnas: Responsable | Tarea | Plazo | Contexto.
- El responsable es quien se compromete o a quien se le encarga; si no está claro, escribe «Sin asignar».
- El plazo, tal como se dijo; si no se dijo, «—».
- Debajo de la tabla, una lista «Pendiente de confirmar» con lo que sonó a tarea pero no quedó claro.`,
  },
  correo: {
    nombre: "Correo de seguimiento",
    pide: `Redacta el correo de seguimiento que se enviaría a los asistentes después de la reunión, listo para copiar y pegar:
- Una primera línea «Asunto: …».
- Saludo breve, resumen en 2-3 frases, decisiones, próximos pasos con responsable y fecha, y despedida.
- Tono profesional y cercano, en frases cortas. Sin inventar nada que no se haya dicho.`,
  },
  personalizada: {
    nombre: "Mi plantilla",
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

// Las tres APIs devuelven 429/503 de vez en cuando. Sin reintentos, un pico de
// carga de un segundo se lleva por delante el acta de una reunión de una hora.
async function fetchIA(nombre, url, opts, alEstado) {
  let ultimo = null;
  for (let intento = 0; ; intento++) {
    let r;
    try {
      r = await fetch(url, opts);
    } catch (e) {
      ultimo = new Error(`${nombre}: sin conexión (${(e && e.message) || e})`);
      if (intento < ESPERAS_IA.length) { await esperaIA(ESPERAS_IA[intento]); continue; }
      throw ultimo;
    }
    if (r.ok) return r;
    const txt = (await r.text()).slice(0, 200);
    ultimo = new Error(`${nombre} HTTP ${r.status}: ${txt}`);
    if ([408, 429, 500, 502, 503, 504].includes(r.status) && intento < ESPERAS_IA.length) {
      if (alEstado) alEstado(`⏳ ${nombre} saturado, reintentando (${intento + 1}/${ESPERAS_IA.length})…`);
      await esperaIA(ESPERAS_IA[intento]);
      continue;
    }
    throw ultimo;
  }
}

// Añade el motivo que dé la API, si lo da: sin esto un texto vacío no se
// distingue de un fallo de red.
function motivo(razon, cuerpo) {
  if (razon) return ` (motivo: ${razon})`;
  const err = cuerpo && cuerpo.error && (cuerpo.error.message || cuerpo.error.type);
  return err ? ` (${String(err).slice(0, 120)})` : "";
}

// mensajes: [{ role: "user" | "assistant", content }] (el último, del usuario).
// Devuelve { texto, uso: { entrada, salida } }.
async function llamarIA(prov, cfg, sistema, mensajes, opciones) {
  const o = opciones || {};
  const msgs = typeof mensajes === "string" ? [{ role: "user", content: mensajes }] : mensajes;
  const nombre = NOMBRE_PROV[prov];
  if (!nombre) throw new Error("Proveedor desconocido: " + prov);

  if (prov === "gemini") {
    if (!cfg.geminiKey) throw new Error("Falta la clave de Gemini en Opciones.");
    const modelo = cfg.geminiModel || "gemini-flash-latest";
    // Gemini no tiene «system» en generateContent de todos los modelos: va delante del primer turno.
    const contents = msgs.map((m, i) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: i === 0 ? sistema + "\n\n---\n" + m.content : m.content }],
    }));
    const r = await fetchIA(nombre, `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.geminiKey },
      // Margen amplio: en los modelos con razonamiento también gasta de aquí.
      body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 32768 } }),
    }, o.alEstado);
    const d = await r.json();
    const cand = (d.candidates || [])[0];
    const texto = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").trim();
    if (!texto) throw new Error("Gemini devolvió una respuesta vacía" + motivo(cand && cand.finishReason, d));
    const u = d.usageMetadata || {};
    return { texto, uso: { entrada: u.promptTokenCount || 0, salida: u.candidatesTokenCount || 0 } };
  }

  if (prov === "gpt") {
    if (!cfg.openaiKey) throw new Error("Falta la clave de OpenAI en Opciones.");
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
    if (!texto) throw new Error("OpenAI devolvió una respuesta vacía" + motivo(ch && ch.finish_reason, d));
    const u = d.usage || {};
    return { texto, uso: { entrada: u.prompt_tokens || 0, salida: u.completion_tokens || 0 } };
  }

  // claude
  if (!cfg.claudeKey) throw new Error("Falta la clave de Anthropic en Opciones.");
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
  if (!texto) throw new Error("Anthropic devolvió una respuesta vacía" + motivo(d.stop_reason, d));
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
