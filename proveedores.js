// Escriba — registro de proveedores de IA (3.8): quién transcribe, quién redacta
// actas y contesta preguntas, con qué clave, en qué dirección y con qué modelos.
// Hasta la 3.7 eran tres nombres escritos a mano en cada fichero.
//
// Se carga después de i18n.js y antes de config.js, comun.js e ia.js: en las
// páginas, en el documento offscreen y en el service worker (importScripts); en
// Node (tests) se exporta. No toca el DOM ni chrome.*.
//
// REGLA DE PUBLICACIÓN: solo se enseña lo probado con una clave real. Sin ella
// no se puede garantizar que un proveedor acepte el audio que manda Chrome, ni
// medir cómo transcribe. Por eso cada capacidad lleva su interruptor
// (`voz.activo`, `chat.activo`), y una capacidad apagada no existe para el
// usuario: no sale en Opciones ni en ningún desplegable, proveedorVoz y
// proveedorTexto la saltan, llamarIA la rechaza y su permiso de host ni se
// declara en el manifest ni se pide (config.js: guardarClaveProveedor).
// Se enciende cambiando ese valor AQUÍ (y añadiendo su host a
// optional_host_permissions del manifest), cuando se haya probado de punta a
// punta con una clave de verdad. Los tests ejercitan también lo apagado,
// encendiéndolo en su propio contexto.
//
// Los ids no se cambian ni llevan «·»: viven en el historial (`analisis`,
// `usoIA`, `chat`), en `precios` y en `autoActaProv`, y van en nombres de fichero.
//
// De cada proveedor:
//   nombre       el de los mensajes de error («OpenAI ha rechazado la clave»)
//   etiqueta     el de los desplegables («GPT»)
//   base, host   raíz de su API y el patrón de permiso de esa dirección
//   fijo         su host ya está en host_permissions; los demás son opcionales:
//                se declaran en el manifest al encender el proveedor y se piden
//                al guardar la clave (origenesProveedores)
//   campoClave, campoModelo, campoVoz   dónde vive cada cosa en CFG_LOCAL (config.js)
//   chat         acta y preguntas: `dialecto` («gemini», «openai» o «anthropic»),
//                `modelo` por defecto y los de `reserva` si ese ya no existe;
//                `cabeceras`, las propias que pida además de la clave
//   voz          transcripción, o null si su API no admite audio: `dialecto`
//                («gemini», «openai», «whisper» o «mistral»), `modelos` (el
//                primero es el de por defecto) y si da `hablantes` y `tiempos`
//   gratis       se puede usar sin pagar
//   urlClave     dónde se saca la clave
//   urlPrecios   dónde publica sus precios (el enlace de «Coste», en Opciones)
//   rutaModelos  de dónde sale su lista de modelos, si no es de «/models»
//                (peticionModelos)
//   ayuda, aviso claves de i18n.js: la línea de ayuda (HTML, con el enlace de
//                urlClave) y lo que conviene saber antes de usarlo (o null).
//                Lo que solo importa si transcribe va en `voz.aviso`, y lo que
//                solo importa si redacta, en `chat.aviso`: Opciones enseña cada
//                uno únicamente con esa capacidad encendida, para que la tarjeta
//                no diga «transcribe…» de quien todavía no transcribe.
const PROVEEDORES = {
  gemini: {
    id: "gemini", nombre: "Gemini", etiqueta: "Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta", host: "https://generativelanguage.googleapis.com/*", fijo: true,
    campoClave: "geminiKey", campoModelo: "geminiModel", campoVoz: "geminiModel",
    chat: { activo: true, dialecto: "gemini", modelo: "gemini-flash-latest", reserva: ["gemini-2.5-flash", "gemini-flash-lite-latest"] },
    voz: { activo: true, dialecto: "gemini", modelos: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"], hablantes: true, tiempos: true },
    gratis: true, urlClave: "https://aistudio.google.com/apikey", urlPrecios: "https://ai.google.dev/gemini-api/docs/pricing",
    ayuda: "opc.p1Texto", aviso: null,
  },
  gpt: {
    id: "gpt", nombre: "OpenAI", etiqueta: "GPT",
    base: "https://api.openai.com/v1", host: "https://api.openai.com/*", fijo: true,
    campoClave: "openaiKey", campoModelo: "openaiModel", campoVoz: "openaiVoz",
    chat: { activo: true, dialecto: "openai", modelo: "gpt-4o", reserva: ["gpt-6.1-sol", "gpt-6-luna"] },
    // gpt-transcribe da solo el texto; los otros dos (hablantes, o marcas de
    // tiempo) se apagan el 26/02/2027.
    voz: {
      activo: false, dialecto: "openai", modelos: ["gpt-transcribe", "gpt-4o-transcribe-diarize", "whisper-1"], hablantes: false, tiempos: false,
      aviso: "opc.provAvisoVozGpt",
    },
    gratis: false, urlClave: "https://platform.openai.com/api-keys", urlPrecios: "https://openai.com/api/pricing/",
    ayuda: "opc.provAyudaGpt", aviso: null,
  },
  claude: {
    id: "claude", nombre: "Anthropic", etiqueta: "Claude",
    base: "https://api.anthropic.com/v1", host: "https://api.anthropic.com/*", fijo: true,
    campoClave: "claudeKey", campoModelo: "claudeModel",
    chat: { activo: true, dialecto: "anthropic", modelo: "claude-sonnet-5", reserva: ["claude-sonnet-5-5", "claude-haiku-4-5"] },
    voz: null,
    gratis: false, urlClave: "https://console.anthropic.com/settings/keys", urlPrecios: "https://claude.com/pricing#api",
    // Sin `limit` solo devuelve los 20 más recientes.
    rutaModelos: "/models?limit=100",
    ayuda: "opc.provAyudaClaude", aviso: "opc.provAvisoClaude",
  },
  mistral: {
    id: "mistral", nombre: "Mistral", etiqueta: "Mistral",
    base: "https://api.mistral.ai/v1", host: "https://api.mistral.ai/*", fijo: false,
    campoClave: "mistralKey", campoModelo: "mistralModel", campoVoz: "mistralVoz",
    chat: { activo: false, dialecto: "openai", modelo: "mistral-small-latest", reserva: ["mistral-medium-latest"] },
    voz: { activo: false, dialecto: "mistral", modelos: ["voxtral-mini-latest"], hablantes: true, tiempos: true, aviso: "opc.provAvisoVozMistral" },
    gratis: true, urlClave: "https://console.mistral.ai/api-keys", urlPrecios: "https://mistral.ai/pricing",
    ayuda: "opc.provAyudaMistral", aviso: "opc.provAvisoMistral",
  },
  groq: {
    id: "groq", nombre: "Groq", etiqueta: "Groq",
    base: "https://api.groq.com/openai/v1", host: "https://api.groq.com/*", fijo: false,
    campoClave: "groqKey", campoModelo: "groqModel", campoVoz: "groqVoz",
    chat: { activo: false, dialecto: "openai", modelo: "openai/gpt-oss-120b", reserva: ["openai/gpt-oss-20b"], aviso: "opc.provAvisoChatGroq" },
    voz: {
      activo: false, dialecto: "whisper", modelos: ["whisper-large-v3", "whisper-large-v3-turbo"], hablantes: false, tiempos: true,
      aviso: "opc.provAvisoVozGroq",
    },
    // No tiene página de precios aparte: van en la de sus modelos.
    gratis: true, urlClave: "https://console.groq.com/keys", urlPrecios: "https://console.groq.com/docs/models",
    ayuda: "opc.provAyudaGroq", aviso: null,
  },
  deepseek: {
    id: "deepseek", nombre: "DeepSeek", etiqueta: "DeepSeek",
    base: "https://api.deepseek.com", host: "https://api.deepseek.com/*", fijo: false,
    campoClave: "deepseekKey", campoModelo: "deepseekModel",
    chat: { activo: false, dialecto: "openai", modelo: "deepseek-flash", reserva: ["deepseek-v4-pro"] },
    voz: null,
    gratis: false, urlClave: "https://platform.deepseek.com/api_keys", urlPrecios: "https://api-docs.deepseek.com/quick_start/pricing",
    ayuda: "opc.provAyudaDeepseek", aviso: "opc.provAvisoDeepseek",
  },
  openrouter: {
    id: "openrouter", nombre: "OpenRouter", etiqueta: "OpenRouter",
    base: "https://openrouter.ai/api/v1", host: "https://openrouter.ai/*", fijo: false,
    campoClave: "openrouterKey", campoModelo: "openrouterModel",
    // Sus dos cabeceras solo dicen qué aplicación llama; «openrouter/free» elige
    // por su cuenta un modelo gratuito, así que no hay otro al que pasar.
    chat: {
      activo: false, dialecto: "openai", modelo: "openrouter/free", reserva: [],
      cabeceras: { "HTTP-Referer": "https://alvarogarrido10.github.io/escriba/", "X-OpenRouter-Title": "Escriba" },
    },
    // Tiene transcripción, pero ignora el glosario y cada modelo pide opciones
    // propias: en esta versión no se usa.
    voz: null,
    // Cada modelo tiene su precio: está en la ficha de cada uno.
    gratis: true, urlClave: "https://openrouter.ai/keys", urlPrecios: "https://openrouter.ai/models",
    // Su «/models» es público: responde igual con una clave inventada, así que no
    // sirve para comprobarla. Este pide la clave, y devuelve solo los modelos que
    // esa cuenta puede usar con sus ajustes de privacidad.
    rutaModelos: "/models/user",
    ayuda: "opc.provAyudaOpenrouter", aviso: "opc.provAvisoOpenrouter",
  },
};

// Por dónde se empieza cuando el usuario no ha elegido: el primero con clave.
const ORDEN_VOZ = ["gemini", "mistral", "groq", "gpt"];
const ORDEN_TEXTO = ["gemini", "gpt", "claude", "mistral", "groq", "deepseek", "openrouter"];

// La ficha de un id, o null. Con hasOwnProperty: un id que venga del historial o
// de la configuración («constructor») no puede acabar leyendo otra cosa.
function provDe(id) {
  return Object.prototype.hasOwnProperty.call(PROVEEDORES, id) ? PROVEEDORES[id] : null;
}

// La capacidad existe Y está encendida. Todo lo demás (listas, desplegables,
// tarjetas, elección de proveedor) pregunta aquí, nunca al registro a pelo.
function transcribe(id) {
  const p = provDe(id);
  return !!(p && p.voz && p.voz.activo);
}
function redacta(id) {
  const p = provDe(id);
  return !!(p && p.chat && p.chat.activo);
}

function tieneClave(cfg, id) {
  const p = provDe(id);
  return !!(p && cfg && String(cfg[p.campoClave] || "").trim());
}

// Son `function` y no `const` a propósito, como todo lo de este fichero que se
// llama desde fuera: los tests las llaman en el contexto donde encienden algo.
function provsQueTranscriben() { return ORDEN_VOZ.filter(transcribe); }
function provsQueRedactan() { return ORDEN_TEXTO.filter(redacta); }
// Los que tienen algo encendido: son los que se enseñan en Opciones.
function provsVisibles() { return Object.keys(PROVEEDORES).filter((id) => transcribe(id) || redacta(id)); }
// Los hosts opcionales que el manifest tiene que declarar: los de los proveedores
// con algo ENCENDIDO. La tienda no admite pedir permisos para funciones que el
// usuario todavía no puede usar, así que el host de un proveedor apagado no se
// declara: se añade a optional_host_permissions al encenderlo (un test lo exige)
// y se pide al guardar su clave.
function origenesProveedores() { return provsVisibles().map(provDe).filter((p) => !p.fijo).map((p) => p.host); }

// Con quién se transcribe, o "" si con nadie. El elegido en Opciones
// (`provTranscribe`) si transcribe y tiene clave; con «auto», o si al elegido le
// falta la clave, el primero de ORDEN_VOZ que la tenga.
function proveedorVoz(cfg) {
  const elegido = cfg && cfg.provTranscribe;
  if (elegido && elegido !== "auto" && transcribe(elegido) && tieneClave(cfg, elegido)) return elegido;
  return ORDEN_VOZ.find((id) => transcribe(id) && tieneClave(cfg, id)) || "";
}

// Con quién se redacta: el `preferido` si tiene clave; si no, el primero de
// ORDEN_TEXTO que la tenga; si nadie, "".
function proveedorTexto(cfg, preferido) {
  if (preferido && redacta(preferido) && tieneClave(cfg, preferido)) return preferido;
  return ORDEN_TEXTO.find((id) => redacta(id) && tieneClave(cfg, id)) || "";
}

// La puerta del popup: ¿se enseña el panel de grabar, o la bienvenida que manda
// a configurar? Hasta la 3.7 la abría solo la clave de Gemini. Ahora la abre
// cualquiera de estas tres cosas:
//  - que haya con quién transcribir;
//  - que el usuario haya pedido grabar sin clave (`grabarSinClave`, config.js):
//    se guarda el audio y se transcribe solo el día que ponga una;
//  - que ya se esté grabando. Una grabación arrancada con el atajo de teclado no
//    mira la clave, y sin esto no había botón con que pararla.
function puedeGrabar(cfg, grabando) {
  return !!(proveedorVoz(cfg) || (cfg && cfg.grabarSinClave) || grabando);
}

// --- leer los errores de las API -------------------------------------------------
// El mensaje de un cuerpo de error, en una línea. Cada API lo trae a su manera:
//   { error: { message } }             OpenAI, Anthropic, Groq, DeepSeek, OpenRouter y Gemini
//   { error: "texto" }
//   { message }                        Mistral (404 y 429)
//   { detail: "Invalid API Key" }      Mistral (401)
//   { detail: [{ loc, msg, type }] }   Mistral (422)
// Se le pasa el cuerpo como TEXTO: el 401 de OpenAI llega como text/plain. Si no
// es JSON, o no trae ninguno de esos campos, no hay detalle: nunca se enseña el
// cuerpo en crudo.
function detalleErrorApi(cuerpoTexto) {
  let j = null;
  try { j = JSON.parse(cuerpoTexto); } catch (_) { return ""; }
  if (!j || typeof j !== "object") return "";
  const txt = (v) => (typeof v === "string" ? v : "");
  const e = j.error;
  let d = txt(e) || (e && typeof e === "object" ? txt(e.message) || txt(e.type) : "") || txt(j.message) || txt(j.detail);
  if (!d && Array.isArray(j.detail)) {
    d = j.detail.map((x) => {
      const msg = txt(x && x.msg);
      return msg && Array.isArray(x.loc) ? `${x.loc.join(".")}: ${msg}` : msg;
    }).filter(Boolean).join("; ");
  }
  return d.replace(/\s+/g, " ").trim().slice(0, 200);
}

// Sin saldo no es lo mismo que «vas muy deprisa», aunque OpenAI y Anthropic usen
// el mismo 429 para las dos cosas: esperar no lo arregla, así que no se
// reintenta. OpenAI lo dice en `error.code` (o `error.type`); Anthropic, en
// `error.details.error_code`. El 402 es de DeepSeek, OpenRouter y Anthropic.
const CODIGOS_SALDO = [
  "insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "enforced_spend_limit_reached",
];
function sinSaldo(status, cuerpoTexto) {
  if (status === 402) return true;
  if (status !== 429) return false;
  let e = null;
  try { e = JSON.parse(cuerpoTexto).error; } catch (_) { return false; }
  if (!e || typeof e !== "object") return false;
  return [e.code, e.type, e.details && e.details.error_code].some((c) => CODIGOS_SALDO.includes(c));
}

// Lo que la API pide esperar antes de volver a intentarlo (cabecera Retry-After,
// en segundos o como fecha), en milisegundos y con tope. 0 si no lo dice.
function esperaPedida(respuesta, topeMs) {
  let v = null;
  try { v = respuesta.headers.get("retry-after"); } catch (_) { /* respuesta sin cabeceras */ }
  if (v === null || v === undefined || String(v).trim() === "") return 0;
  const ms = /^\s*\d+(\.\d+)?\s*$/.test(v) ? parseFloat(v) * 1000 : Date.parse(v) - Date.now();
  return ms > 0 ? Math.min(ms, topeMs) : 0;
}

// --- la lista de modelos de cada proveedor ---------------------------------------
// Sirve para dos cosas: rellenar el campo del modelo en Opciones (los nombres
// cambian cada pocos meses, y escribirlos a mano acaba en un 404) y comprobar una
// clave antes de guardarla, porque solo responde bien a una clave que vale.
// Aquí solo se dice QUÉ pedir, { url, headers }: la red la toca config.js
// (listarModelos). null si el id no es de ningún proveedor.
function peticionModelos(id, clave) {
  const p = provDe(id);
  if (!p) return null;
  const url = p.base + (p.rutaModelos || "/models");
  if (p.chat.dialecto === "gemini") return { url, headers: { "x-goog-api-key": clave } };
  if (p.chat.dialecto === "anthropic") {
    // La tercera cabecera es la que deja a Anthropic contestar a un navegador.
    return { url, headers: { "x-api-key": clave, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } };
  }
  return { url, headers: { Authorization: "Bearer " + clave } };
}

// Lo que no redacta, por su nombre: transcripción, voz, imagen, filtros de
// seguridad… Casi ninguna de estas listas dice para qué sirve cada modelo, así
// que se quitan los que se sabe que no valen para un acta.
const RE_NO_REDACTA = /whisper|transcri|voxtral|tts|speech|audio|realtime|embed|moderation|guard|image|ocr/i;

// De la respuesta de esa petición (el JSON ya leído), los ids que valen para
// actas y preguntas, sin repetir. Si no trae lista, ninguno.
function modelosDeChat(id, cuerpo) {
  const p = provDe(id);
  if (!p || !cuerpo || typeof cuerpo !== "object") return [];
  if (p.chat.dialecto === "gemini") {
    return (Array.isArray(cuerpo.models) ? cuerpo.models : [])
      .filter((m) => m && typeof m.name === "string" && (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace("models/", ""));
  }
  const lista = (Array.isArray(cuerpo.data) ? cuerpo.data : []).filter((m) => m && typeof m.id === "string" && m.id);
  let ids = lista.map((m) => m.id);
  if (id === "gpt") {
    // Como hasta la 3.7: solo los de conversación, y los más nuevos arriba.
    ids = ids.filter((m) => /^(gpt|o\d|chatgpt)/.test(m) && !/(audio|realtime|tts|transcribe|image|search|embedding)/.test(m)).sort().reverse();
  } else if (p.chat.dialecto === "openai") {
    ids = lista.filter((m) => {
      // Mistral sí dice qué sabe hacer cada uno, y Groq cuáles ha retirado.
      if (m.capabilities && m.capabilities.completion_chat === false) return false;
      if (m.active === false) return false;
      // Los «-contributor» (se ven en OpenRouter) entrenan con lo que se les
      // envía y prohíben datos personales: una reunión no puede ir ahí.
      return !/-contributor(:|$)/.test(m.id) && !RE_NO_REDACTA.test(m.id);
    }).map((m) => m.id);
    // Delante, los que Escriba usa por defecto y de reserva, si siguen vivos:
    // son los únicos de los que se sabe que redactan bien un acta.
    const propios = [p.chat.modelo, ...p.chat.reserva].filter((m) => ids.includes(m));
    ids = [...propios, ...ids];
  }
  return [...new Set(ids)];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PROVEEDORES, ORDEN_VOZ, ORDEN_TEXTO, CODIGOS_SALDO, provDe, transcribe, redacta, tieneClave,
    provsQueTranscriben, provsQueRedactan, provsVisibles, origenesProveedores, proveedorVoz, proveedorTexto, puedeGrabar,
    detalleErrorApi, sinSaldo, esperaPedida, peticionModelos, modelosDeChat,
  };
}
