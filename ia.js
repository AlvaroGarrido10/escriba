// Escriba — la IA que trabaja SOBRE la transcripción: actas con plantillas y
// preguntas a la reunión, con el proveedor que se elija de los que redactan
// (proveedores.js). La comparten el popup, la biblioteca y el documento
// offscreen (acta automática). Depende de proveedores.js y de comun.js, que se
// cargan antes.
//
// Hasta la 3.1 esto vivía en el popup, así que el acta solo podía pedirse con
// el popup abierto. Aquí no toca ni el DOM ni chrome.*: recibe la configuración
// y devuelve texto y tokens gastados; quien llama decide dónde guardarlo.

// t() la define i18n.js, que se carga antes. En Node (tests) se trae con require.
if (typeof t !== "function" && typeof require === "function") var t = require("./i18n.js").t;

const ESPERAS_IA = [3000, 8000, 20000];
// Cuando la API dice cuánto esperar (Retry-After) se le hace caso, pero hasta
// aquí: más allá, quien ha pedido el acta ya la da por perdida.
const TOPE_ESPERA_IA = 30000;
// Lo que se arregla esperando. El 529 es el «saturado» de Anthropic.
const REINTENTABLES_IA = [408, 429, 500, 502, 503, 504, 529];
// Si el modelo de Gemini sigue saturado tras los reintentos, se prueban por orden
// los de reserva del registro: sin ellos, un 503 de «high demand» dejaba la
// reunión sin acta (01/10). Estos son los errores que otro modelo puede no
// tener. Una clave rechazada (400/401/403) no: ahí se para enseguida.
const PASA_DE_MODELO = [404, 408, 429, 500, 502, 503, 504];
// En los demás proveedores solo se cambia de modelo cuando el pedido ya no
// existe (los retiran cada pocos meses): si lo saturado o lo agotado es la
// cuenta, el modelo de reserva tampoco iba a responder.
const PASA_SI_NO_EXISTE = [404];

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
const esperaIA = (ms) => new Promise((r) => setTimeout(r, ms));

// Error que se enseña tal cual en la biblioteca y en el aviso del acta: en el
// idioma de la interfaz, con qué hacer y el código HTTP al final, nunca el JSON
// de la API. `cuerpo` es el texto de la respuesta.
function errorIA(nombre, status, cuerpo) {
  const detalle = detalleErrorApi(cuerpo);
  let txt;
  if (sinSaldo(status, cuerpo)) {
    // Antes que el 429 de «vas muy deprisa»: OpenAI y Anthropic usan ese mismo
    // código para decir que no queda saldo, y ahí esperar no sirve de nada.
    txt = t("ia.errSaldo", nombre);
  } else if (status === 400 && /anthropic-workspace-id/i.test(cuerpo)) {
    // Clave de Anthropic ligada a una persona y no a un workspace: exige una
    // cabecera que Escriba no manda. Antes que el caso de la clave rechazada,
    // porque su mensaje también dice «API key» y lo que hay que hacer es otra cosa.
    txt = t("ia.errWorkspace", nombre);
  } else if (status === 401 || status === 403 || (status === 400 && /api[_ ]?key/i.test(detalle + " " + cuerpo))) {
    txt = t("ia.errClave", nombre);
  } else if (status === 413) {
    // Así rechaza Groq, en su plan gratuito, una reunión que no le cabe en el minuto.
    txt = t("ia.errNoCabe", nombre);
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

// Las APIs devuelven 429/503 de vez en cuando. Sin reintentos, un pico de carga
// de un segundo se lleva por delante el acta de una reunión de una hora.
// Devuelve el cuerpo de la respuesta buena, ya leído.
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
    let status = r.status, cuerpo;
    if (r.ok) {
      const d = (await r.json()) || {};
      if (!d.error) return d;
      // Un 200 con `error` dentro también es un fallo: OpenRouter contesta así
      // cuando el modelo se cae después de haber empezado, y pone en
      // `error.code` el HTTP que le habría tocado. Se trata como si hubiera
      // llegado con él.
      const codigo = Number(d.error.code);
      if (codigo >= 400 && codigo < 600) status = codigo;
      cuerpo = JSON.stringify(d).slice(0, 4000);
    } else {
      cuerpo = (await r.text()).slice(0, 4000);
    }
    ultimo = errorIA(nombre, status, cuerpo);
    // Ni la falta de saldo (aunque llegue como 429) ni un «no cabe» se arreglan esperando.
    if (REINTENTABLES_IA.includes(status) && !sinSaldo(status, cuerpo) && intento < ESPERAS_IA.length) {
      if (alEstado) alEstado("⏳ " + t("ia.reintentando", nombre, intento + 1, ESPERAS_IA.length));
      await esperaIA(Math.max(ESPERAS_IA[intento], esperaPedida(r, TOPE_ESPERA_IA)));
      continue;
    }
    throw ultimo;
  }
}

// Pide con cada modelo, por orden, hasta que uno responda. Solo se pasa al
// siguiente si el fallo es de los de `pasan`; cualquier otro corta.
async function conReserva(modelos, pasan, pedir, alCambiar) {
  for (let i = 0; ; i++) {
    try {
      return await pedir(modelos[i]);
    } catch (e) {
      if (!pasan.includes(e.status) || i === modelos.length - 1) throw e;
      alCambiar(modelos[i], modelos[i + 1]);
    }
  }
}

// Añade el motivo de parada que dé la API, si lo da: sin esto un texto vacío no
// se distingue de un fallo de red.
const motivo = (razon) => (razon ? ` (${t("ia.motivo", razon)})` : "");

// `message.content` en el dialecto de OpenAI: casi siempre un texto, pero Mistral
// lo manda como lista de trozos cuando el modelo razona. El acta son solo los
// de texto, no el razonamiento.
function textoDeContenido(contenido) {
  if (typeof contenido === "string") return contenido;
  if (!Array.isArray(contenido)) return "";
  return contenido.map((c) => {
    if (typeof c === "string") return c;
    return c && (!c.type || c.type === "text") && typeof c.text === "string" ? c.text : "";
  }).join("");
}

// mensajes: [{ role: "user" | "assistant", content }] (el último, del usuario).
// Devuelve { texto, uso: { entrada, salida }, truncado }. `truncado` es cierto
// cuando el modelo se quedó sin longitud a mitad: hay texto, pero incompleto.
async function llamarIA(prov, cfg, sistema, mensajes, opciones) {
  const o = opciones || {};
  const msgs = typeof mensajes === "string" ? [{ role: "user", content: mensajes }] : mensajes;
  // Ni un id desconocido ni una capacidad apagada en el registro llegan a la red.
  // (Hasta la 3.7, lo que no era Gemini ni GPT se mandaba a Anthropic.)
  if (!redacta(prov)) throw new Error(t("ia.provDesconocido", prov));
  const p = provDe(prov), nombre = p.nombre, clave = cfg[p.campoClave];
  if (!tieneClave(cfg, prov)) throw new Error(t("ia.faltaClave", nombre));
  // El elegido en Opciones primero; después, el de por defecto y los de reserva que no sean él.
  const elegido = cfg[p.campoModelo] || p.chat.modelo;
  const modelos = [elegido, ...[p.chat.modelo, ...p.chat.reserva].filter((m) => m !== elegido)];
  const avisaCambio = (txt) => { if (o.alEstado) o.alEstado("⏳ " + txt); };
  const sinModelo = (de, a) => avisaCambio(t("ia.cambioModeloProv", nombre, de, a));

  if (p.chat.dialecto === "gemini") {
    // Gemini no tiene «system» en generateContent de todos los modelos: va delante del primer turno.
    const contents = msgs.map((m, i) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: i === 0 ? sistema + "\n\n---\n" + m.content : m.content }],
    }));
    const d = await conReserva(modelos, PASA_DE_MODELO, (modelo) => fetchIA(nombre, `${p.base}/models/${modelo}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": clave },
      // Margen amplio: en los modelos con razonamiento también gasta de aquí.
      body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 32768 } }),
    }, o.alEstado), (de, a) => avisaCambio(t("ia.cambioModelo", de, a)));
    const cand = (d.candidates || [])[0];
    const texto = ((cand && cand.content && cand.content.parts) || []).map((x) => x.text || "").join("").trim();
    if (!texto) throw new Error(t("ia.vacia", nombre) + motivo(cand && cand.finishReason));
    const u = d.usageMetadata || {};
    return { texto, uso: { entrada: u.promptTokenCount || 0, salida: u.candidatesTokenCount || 0 }, truncado: cand.finishReason === "MAX_TOKENS" };
  }

  if (p.chat.dialecto === "anthropic") {
    const d = await conReserva(modelos, PASA_SI_NO_EXISTE, (modelo) => fetchIA(nombre, `${p.base}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": clave,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: modelo, max_tokens: 16384, system: sistema, messages: msgs }),
    }, o.alEstado), sinModelo);
    // Con razonamiento llegan además bloques «thinking»: el acta son solo los de texto.
    const texto = (Array.isArray(d.content) ? d.content : []).map((c) => (c && c.type === "text" && c.text) || "").join("").trim();
    if (!texto) throw new Error(t("ia.vacia", nombre) + motivo(d.stop_reason));
    const u = d.usage || {};
    return { texto, uso: { entrada: u.input_tokens || 0, salida: u.output_tokens || 0 }, truncado: d.stop_reason === "max_tokens" };
  }

  // Dialecto de OpenAI: lo hablan todos los demás, cada uno en su dirección.
  const d = await conReserva(modelos, PASA_SI_NO_EXISTE, (modelo) => fetchIA(nombre, `${p.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + clave, ...(p.chat.cabeceras || {}) },
    // Solo el modelo y los mensajes, sin `temperature` ni topes de longitud: cada
    // proveedor rechaza opciones distintas, y lo que no se manda no se rechaza.
    body: JSON.stringify({ model: modelo, messages: [{ role: "system", content: sistema }, ...msgs] }),
  }, o.alEstado), sinModelo);
  // Un 200 no garantiza que venga texto: un filtro de contenido devuelve un
  // cuerpo sin `choices`, o con el contenido vacío.
  const ch = (d.choices || [])[0];
  const texto = textoDeContenido(ch && ch.message && ch.message.content).trim();
  if (!texto) throw new Error(t("ia.vacia", nombre) + motivo(ch && ch.finish_reason));
  const u = d.usage || {};
  return { texto, uso: { entrada: u.prompt_tokens || 0, salida: u.completion_tokens || 0 }, truncado: ch.finish_reason === "length" };
}

const claveAnalisis = (plantilla, prov) => `${plantilla}·${prov}`;

// Acta, resumen, tareas… de una reunión. Devuelve { clave, texto, uso, truncado }.
async function analizarReunion(h, plantilla, prov, cfg, opciones) {
  const sistema = promptPlantilla(plantilla, {
    glosario: cfg.glosario, participantes: h.participantes, personalizada: cfg.plantillaPersonalizada,
    notas: h.notas, marcas: h.marcas,
  });
  const r = await llamarIA(prov, cfg, sistema, "---TRANSCRIPCIÓN---\n" + textoParaIA(h), opciones);
  return { clave: claveAnalisis(PLANTILLAS[plantilla] ? plantilla : "acta", prov), ...r };
}

// Pregunta sobre la reunión, con la conversación anterior. Devuelve { texto, uso, truncado }.
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
