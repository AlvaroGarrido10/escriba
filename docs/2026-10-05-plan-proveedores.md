# Plan 3.8.0 — otros proveedores de IA y grabar sin clave

Fecha: 05/10/2026. Parte de la 3.7.0 (`be14a15`).

## Qué se pidió

1. Que Escriba admita claves de API de otras empresas: OpenAI, Claude, Meta y alguna gratuita.
2. Que quien no quiera poner ninguna clave pueda grabar igualmente: se guarda el audio y no se transcribe.

Hoy solo transcribe Gemini (clave obligatoria: sin ella el popup ni enseña el botón de grabar); OpenAI y Anthropic sirven para el acta y las preguntas.

## Regla de publicación: solo se enseña lo probado con una clave real

Criterio del proyecto: solo sale lo que va al cien por cien. Sin una clave real de un proveedor no se puede garantizar que acepte el audio que manda Chrome ni medir la calidad, así que:

- Cada capacidad de cada proveedor lleva en el registro un interruptor: `voz.activo` y `chat.activo`.
- **Una capacidad apagada no existe para el usuario**: no sale en Opciones ni en ningún desplegable, `proveedorVoz` y `proveedorTexto` la saltan, y su permiso de host ni se declara en el manifest ni se pide (la tienda no admite permisos para funciones que el usuario todavía no puede usar).
- Se enciende cambiando ese valor (y añadiendo su host a `optional_host_permissions`), cuando se haya probado de punta a punta con una clave real. Los tests ejercitan también lo apagado (encendiéndolo en el test).
- **Lo que ya funciona no se toca sin poder probarlo**: las peticiones de Gemini, y las de OpenAI y Anthropic para el acta, salen byte a byte como hoy (mismos cuerpos, mismos modelos por defecto). Solo cambia lo que ocurre en el lado de Escriba: lectura de errores, reintentos y avisos.

Estado de salida en el código: encendidos `gemini` (voz y texto), `gpt` (texto) y `claude` (texto). Apagados: `gpt` (voz), `mistral`, `groq`, `deepseek` y `openrouter`.

## Qué queda al terminar

Lo que el código sabe hacer (lo visible para el usuario lo decide la regla de arriba):

| Proveedor | id | Transcribe | Acta y preguntas | Gratis | Permiso de host |
|---|---|---|---|---|---|
| Google Gemini | `gemini` | sí (hablantes y tiempos) | sí | sí | ya concedido |
| OpenAI | `gpt` | sí (texto; opción con hablantes) | sí | no | ya concedido |
| Anthropic (Claude) | `claude` | **no** (su API no admite audio) | sí | no | ya concedido |
| Mistral | `mistral` | sí (hablantes y tiempos; se le manda WAV) | sí | sí (saldo gratuito mensual, sin tarjeta) | opcional, nuevo |
| Groq | `groq` | sí (tiempos, sin hablantes) | sí (reuniones cortas en el plan gratuito) | sí (8 h de audio al día) | opcional, nuevo |
| DeepSeek | `deepseek` | **no** | sí | no (muy barato) | opcional, nuevo |
| OpenRouter | `openrouter` | no en esta versión | sí (tiene modelos `:free`) | sí | opcional, nuevo |

Los ids `gemini`, `gpt` y `claude` no cambian: viven en el historial (`analisis`, `usoIA`, `chat`), en `precios` y en `autoActaProv`. Ningún id lleva «·» y todos valen en un nombre de fichero.

**Meta no entra en esta versión.** Su API actual (Meta Model API, modelos Muse; la de Llama cerró en julio de 2026) transcribe y redacta, pero pide método de pago, no publica en qué países admite altas y nada se puede comprobar sin una clave. Lo estudiado queda en este documento para cuando haya clave.

Fuera de alcance, a propósito: transcribir por OpenRouter (ignora el glosario y cada modelo pide opciones propias), Deepgram, AssemblyAI y ElevenLabs (otro dialecto cada uno), URL a medida (exigiría `https://*/*` y alarga la revisión de la tienda), y hacer opcional `tabCapture`.

## Hechos de las API (documentación oficial leída el 05/10/2026)

Nada de esto está probado con una clave real salvo Gemini. Los nombres de modelo cambian cada pocos meses: por eso cada proveedor lleva una lista de reserva y el modelo se puede cambiar en Opciones.

### Transcripción

**OpenAI** — `POST https://api.openai.com/v1/audio/transcriptions`, `multipart/form-data`, `Authorization: Bearer`. Admite `webm` (el fichero necesita nombre con extensión). Máximo 25 MB.

- `gpt-transcribe` (por defecto): campos `file`, `model`, `prompt` (contexto, no instrucciones), `keywords[]` (un término por campo; sin `<`, `>`, retorno de carro ni salto de línea: si aparecen se rechaza la petición entera) y `languages[]` (ISO 639-1; **no** se manda `language`). Respuesta: `{ "text": "...", "languages": [{ "code": "es" }] }`. **No da marcas de tiempo ni hablantes.**
- `gpt-4o-transcribe-diarize` (opción «con hablantes»; se apaga el 26/02/2027): campos `file`, `model`, `response_format=diarized_json`, `chunking_strategy=auto`, `language`. No admite `prompt`. Respuesta: `{ text, duration, segments: [{ start, end, text, speaker }], usage }`, con hablantes `A`, `B`… Tiene 2.000 tokens de salida como máximo: si `usage.output_tokens` ≥ 1.990, el tramo se marca `truncado`.
- `whisper-1` (opción «con marcas de tiempo»; se apaga el 26/02/2027): igual que Groq (ver abajo).
- `usage` llega como `{ type: "duration", seconds }` o como `{ type: "tokens", input_tokens, output_tokens }`.
- Errores: `{ "error": { "message", "type", "param", "code" } }`. 401 clave mala (llega como `text/plain`: leer el cuerpo como texto y probar `JSON.parse`). 429 con `error.code` `insufficient_quota`, `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` u `organization_usage_limit_exceeded` (o `error.type` `insufficient_quota`) = sin saldo: no se reintenta. El resto de 429 = ritmo. 503 = saturado.

**Groq** — `POST https://api.groq.com/openai/v1/audio/transcriptions`, multipart, `Authorization: Bearer`. Modelos `whisper-large-v3` (por defecto) y `whisper-large-v3-turbo`. Máximo 25 MB.

- Campos: `file` (**el nombre con `.webm` es obligatorio**: elige el decodificador por el nombre), `model`, `response_format=verbose_json`, `timestamp_granularities[]=segment`, `temperature=0`, `language` (ISO 639-1; se omite con detección automática, nunca vacío) y `prompt` (máximo 224 tokens; recortar a 600 caracteres y redactarlo como frase, no como lista).
- Respuesta: `{ text, language, duration, segments: [{ id, start, end, text, avg_logprob?, compression_ratio?, no_speech_prob? }] }`. `duration` puede venir como texto. Los campos de calidad son opcionales y `segments` puede faltar.
- Sin hablantes.
- Plan gratuito: 20 peticiones/minuto, 7.200 s de audio por hora y 28.800 s al día. Al pasarse, 429 con `retry-after`.
- Errores: `{ "error": { "message", "type", "code" } }`; 401 `invalid_api_key`.

**Mistral** — `POST https://api.mistral.ai/v1/audio/transcriptions`, multipart, `Authorization: Bearer` (no `x-api-key`). Modelo `voxtral-mini-latest`.

- **El audio se manda siempre en WAV** (mono, 16 kHz, PCM de 16 bits): la documentación lista `webm`, pero dos terceros cuentan que el `webm`/Opus del navegador vuelve con un 400 «Audio input could not be decoded».
- Campos: `model`, `file`, `diarize=true`, `timestamp_granularities=segment` y `context_bias` repetido (hasta 100 términos; cada uno sin espacios ni comas: «Juan Pérez» se manda como `Juan` y `Pérez`). **No se manda `language`**: la guía lo da por incompatible con las marcas de tiempo. No hay `prompt`.
- Respuesta: `{ model, text, language, segments: [{ text, start, end, speaker_id }], usage: { prompt_audio_seconds, … } }`, con hablantes `speaker_1`, `speaker_2`… `start` y `end` pueden venir a `null`: la línea sale entonces sin marca de tiempo.
- Errores con tres formas: `{"detail":"Invalid API Key"}` (401 real), `{"detail":[{"loc","msg","type"}]}` (422) y `{"object":"error","message",…}`.
- El 429 real trae `type: "rate_limited"`, no el del glosario: los reintentos se deciden por el código HTTP, nunca por `type`.
- El plan gratuito son 10 $ al mes de uso de API (unas 55 horas de audio como mucho). En ese plan Mistral puede entrenar con lo enviado salvo que el usuario lo desactive en admin.mistral.ai › Privacy. La clave se saca en console.mistral.ai/api-keys (las de «Vibe Code» no valen).

**Meta (no se implementa en esta versión; referencia)** — `POST https://api.meta.ai/v1/asr/transcribe`, multipart con dos partes, `Authorization: Bearer`. Modelo `muse-voice-transcribe-1.0`.

- Parte `request` (JSON, `type: application/json`): `{ "model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "DIARIZATION", "languageBias": ["Spanish"], "keywords": ["…"] }`.
- Parte `audio`: **solo WAV mono PCM de 16 bits a 16 kHz**. Máximo 10 minutos y 32 MB. El tramo `webm` se convierte antes (ver `aWav16k`).
- `mode: "DIARIZATION"` va siempre (el modo por defecto devuelve `turns` vacío) y `audioEncoding` es obligatorio. Un turno puede traer el texto vacío.
- Respuesta: `{ transcript, audioDurationMs, turns: [{ turnId, startMs, endMs, transcript, speaker }] }`, con hablantes `A`, `B`…
- La clave tiene la forma `LLM|<id>|<secreto>` (lleva barras verticales). Errores al estilo de OpenAI, con un `sessionId` delante en este endpoint (`{"sessionId":"…","error":{…}}`); 402 `billing_error`.
- Los modelos `-contributor` entrenan con los datos y prohíben datos personales: se excluyen de cualquier lista de modelos (también en OpenRouter).

**Anthropic y DeepSeek no admiten audio.**

Los párrafos de Meta de este documento son solo referencia para el futuro: nada de Meta se implementa ahora.

### Acta y preguntas

| id | URL | Modelo por defecto | Reserva | Particularidades |
|---|---|---|---|---|
| `gpt` | `https://api.openai.com/v1/chat/completions` | `gpt-4o` (como hoy) | `gpt-6.1-sol`, `gpt-6-luna` | **cuerpo como hoy** (`model` y `messages`, nada más) |
| `claude` | `https://api.anthropic.com/v1/messages` | `claude-sonnet-5` (como hoy) | `claude-sonnet-5-5`, `claude-haiku-4-5` | **cuerpo como hoy** (`max_tokens: 16384`); 529 = saturado (se reintenta); quedarse con los bloques `type: "text"`; un 400 que hable de `anthropic-workspace-id` tiene mensaje propio («crea la clave para un solo workspace») |
| `mistral` | `https://api.mistral.ai/v1/chat/completions` | `mistral-small-latest` | `mistral-medium-latest` | `message.content` puede ser texto o lista de trozos |
| `groq` | `https://api.groq.com/openai/v1/chat/completions` | `openai/gpt-oss-120b` | `openai/gpt-oss-20b` | plan gratuito: 8.000 tokens/minuto; 413 = no cabe (no se reintenta) |
| `deepseek` | `https://api.deepseek.com/chat/completions` | `deepseek-flash` | `deepseek-v4-pro` | 402 = sin saldo; los datos se procesan en China |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `openrouter/free` | — | cabeceras `HTTP-Referer` y `X-OpenRouter-Title: Escriba`; un 200 puede traer `error` dentro; de las listas de modelos se quitan los que acaban en `-contributor` (entrenan con los datos) |

Pendiente para cuando haya clave de OpenAI o de Anthropic con que probarlo (hoy no se hace): modelos por defecto nuevos, `store: false` y `reasoning_effort` en OpenAI, `max_tokens` mayor en Claude.

Todos menos `claude` y `gemini` hablan el dialecto de OpenAI: cuerpo `{ model, messages }`, respuesta en `choices[0].message.content`, uso en `usage.prompt_tokens` y `usage.completion_tokens`, clave en `Authorization: Bearer`.

Listar modelos (sirve también para comprobar la clave): `GET {base}/models` con la misma cabecera; devuelve `{ data: [{ id }] }` en todos. Anthropic: `GET https://api.anthropic.com/v1/models?limit=100`.

### Chrome

- Un host nuevo en `host_permissions` puede dejar la extensión desactivada al actualizar hasta que el usuario acepte. En `optional_host_permissions` Chrome garantiza que no: se piden con `chrome.permissions.request` y **exige un gesto del usuario** (el clic de un botón, con el `request` como primer `await`).
- `chrome.permissions` no existe en el documento offscreen. El permiso concedido sí vale para sus `fetch`.
- No se pide desde el popup: el diálogo de Chrome lo cierra.

## Diseño

### 1. Registro de proveedores: `proveedores.js` (nuevo)

Se carga después de `i18n.js` y antes de `config.js`, `comun.js` e `ia.js`: en las cinco páginas, en `offscreen.html`, en el `importScripts` del service worker y en los tests. No depende de `chrome.*`.

Contiene:

- `PROVEEDORES`: un objeto por id con `id`, `nombre` (el de los mensajes de error: «OpenAI»), `etiqueta` (el de los desplegables: «GPT»), `base`, `host` (patrón para permisos), `fijo` (cierto para los tres que ya están en `host_permissions`), `campoClave`, `campoModelo`, `campoVoz` (si transcribe), `chat: { activo, dialecto, modelo, reserva }`, `voz: null | { activo, dialecto, modelos: [id…], hablantes, tiempos }`, `gratis`, `urlClave`, y las claves de i18n de su ayuda y de su aviso.
- `ORDEN_VOZ = ["gemini", "mistral", "groq", "gpt"]` y `ORDEN_TEXTO = ["gemini", "gpt", "claude", "mistral", "groq", "deepseek", "openrouter"]`.
- `transcribe(id)` y `redacta(id)`: ciertos solo si la capacidad existe **y está encendida**. Todo lo demás (listas, desplegables, tarjetas, elección de proveedor) pasa por ellas.
- `proveedorVoz(cfg)`: el id con el que se transcribe, o `""`. Si `cfg.provTranscribe` nombra un proveedor que transcribe y tiene clave, ese; si vale `"auto"` o el elegido no tiene clave, el primero de `ORDEN_VOZ` con clave.
- `proveedorTexto(cfg, preferido)`: `preferido` si tiene clave; si no, el primero de `ORDEN_TEXTO` con clave; si no, `""`.
- `tieneClave(cfg, id)`, `provsQueTranscriben()`, `provsQueRedactan()` (solo lo encendido), `provsVisibles()` (los que tienen alguna capacidad encendida) y `origenesProveedores()` (los hosts opcionales de los proveedores con algo encendido: los que el manifest tiene que declarar; su test lo comprueba).
- `detalleErrorApi(cuerpoTexto)`: saca el mensaje de un cuerpo de error en cualquiera de las formas de arriba (`error.message`, `error` como texto, `message`, `detail` como texto o como lista de `{ msg }`), en una línea de 200 caracteres como máximo.
- `sinSaldo(status, cuerpoTexto)`: cierto si es 402, o 429 con alguno de los códigos de saldo de arriba, o 429 de Anthropic con `enforced_spend_limit_reached`.

Las tablas de nombres que hoy están repetidas (`NOMBRE_PROV` en `ia.js`, `PROVEEDORES` en `reuniones.js`, los `<option>` y literales de Opciones) salen de aquí.

### 2. Configuración (`config.js`)

`CFG_LOCAL` gana, escritos uno a uno (un test comprueba que el registro y `CFG_LOCAL` coinciden):

```
openaiVoz: "gpt-transcribe",
mistralKey: "", mistralModel: "mistral-small-latest", mistralVoz: "voxtral-mini-latest",
groqKey: "", groqModel: "openai/gpt-oss-120b", groqVoz: "whisper-large-v3",
deepseekKey: "", deepseekModel: "deepseek-flash",
openrouterKey: "", openrouterModel: "openrouter/free",
provTranscribe: "auto",
```

Los valores por defecto de `openaiModel` (`gpt-4o`) y `claudeModel` (`claude-sonnet-5`) **no cambian**.

`CFG_SYNC` gana `grabarSinClave: false`.

`PRECIOS_REFERENCIA` (fecha `2026-10-05`): filas nuevas para `gpt` (`gpt-6-luna` 0,10/0,50; `gpt-6.1-sol` 2/10; `gpt-6-astra` 10/50, delante de las `gpt-5`), `mistral` (`small` 0,15/0,60; `medium` 1,5/7,5; `large` 0,5/1,5), `groq` (`gpt-oss-120b` 0,15/0,60; `gpt-oss-20b` 0,075/0,30), `deepseek` (`flash` 0,30/1,20; `v4-pro` 1,32/3,96), y un tipo nuevo `minuto` (dólares por minuto de audio) para la voz: `gpt` `gpt-transcribe` 0,0045, `diarize` y `whisper-1` 0,006; `mistral` `voxtral` 0,003; `groq` `whisper-large-v3-turbo` 0,00067 y `whisper-large-v3` 0,00185. `precioReferencia` devuelve también `minuto` (5 decimales).

### 3. Transcripción (`offscreen.js`)

`transcribirGemini` no se toca (doce tests la llaman tal cual).

Función nueva `transcribirAudio(blob, idx, total, opciones)`, que sustituye a `transcribirGemini` en `transcribirTramo` y en el diagnóstico:

1. Lee la configuración y calcula `proveedorVoz(cfg)`. Sin proveedor: error con código `sin_clave`.
2. `gemini`: delega en `transcribirGemini`.
3. El resto: `transcribirConProveedor(prov, cfg, blob, idx, total, opciones)`.
4. Devuelve lo mismo que hoy más `prov` y `modelo`, que `transcribirTramo` guarda en el tramo.

`transcribirConProveedor` reutiliza la mecánica de Gemini: modelo elegido y después los de reserva; por cada modelo, un intento más los reintentos de `ESPERAS` si el error es `reintentable`; `fatal` corta. Cada dialecto aporta cómo se arma el formulario y cómo se lee la respuesta, y entrega **segmentos** `{ inicio (s), texto, hablante }`; el paso a texto es común.

De segmentos a texto (`segmentosATexto`):

- Se descartan los segmentos vacíos. En el dialecto Whisper se descartan además los que Whisper mismo daría por no hablados (`no_speech_prob > 0.6` **y** `avg_logprob < -1`, solo si los dos campos vienen) y las frases inventadas conocidas («Subtítulos realizados por la comunidad de Amara.org», «Gracias por ver el vídeo», «Thanks for watching»…) cuando son el segmento entero.
- Segmentos seguidos del mismo hablante con menos de 2 s de hueco se unen en una línea, hasta unos 350 caracteres.
- Con hablantes: `[MM:SS] Hablante N: texto`, numerando por orden de aparición dentro del tramo con `etiquetaGenerica(n)`.
- Sin hablantes: `[MM:SS] texto`. **Trampa**: `RE_LINEA` (`comun.js`) toma por hablante cualquier línea que empiece por mayúscula y tenga «:» en sus primeros 40 caracteres («Primer punto: …»). Si la línea sin etiqueta casaría con `RE_LINEA`, se le antepone el carácter invisible U+2060 justo después de la marca; `lineasTranscripcion` lo quita al leer. Va con su test.
- Sin tiempos (`gpt-transcribe`): el texto se parte en frases agrupadas en líneas de unos 300 caracteres; la primera lleva `[00:00]` y las demás van sin marca.
- Si no queda ningún texto: `{ texto: "", sinVoz: true }`.

Glosario y participantes: `terminosDe(cfg.glosario, participantes)` devuelve la lista limpia de términos (separados por comas o saltos de línea, sin vacíos ni repetidos). OpenAI: `keywords[]` (máximo 80, sin `<>` ni saltos). Groq y `whisper-1`: `prompt` = «Reunión de trabajo. Nombres y términos: a, b, c.» recortado a 600 caracteres. Mistral: `context_bias`, cada término partido en palabras, máximo 100.

Idioma (`cfg.idioma`, `"auto"` o un código): OpenAI `languages[]` (o `language` en sus modelos antiguos); Groq `language`; Mistral nada. Con `"auto"` no se manda nada.

Mistral recibe WAV siempre: `aWav16k(blob)` devuelve el blob tal cual si ya es `audio/wav`; si no, lo decodifica a 16 kHz (igual que hace ya `medirExacto`), mezcla a mono y usa `codificarWav` (`comun.js`). Cada tramo es un `webm` completo, así que se decodifica por sí solo.

OpenAI y Groq reciben el `webm` tal cual. Como no se ha podido probar con una clave real que acepten el de `MediaRecorder`, llevan red: si responden 400 o 415 y el detalle habla del audio (`/decod|format|audio|file/i`) y el blob no era WAV, se repite **una vez** la misma petición con el tramo convertido a WAV.

`uso`: `{ segundos }` cuando la API da la duración (`usage.seconds`, `usage.prompt_audio_seconds`, `duration`); `{ entrada, salida }` cuando da tokens; nada si no da ninguna de las dos.

Errores (`errorVoz`), siempre un `Error` marcado con `codigo` y, según el caso, `fatal`, `reintentable` y `esperaMs`:

| Situación | Código | |
|---|---|---|
| `fetch` lanza | `red` | reintentable |
| 401, 403 | `clave_invalida` | fatal |
| 402, o 429 de saldo (`sinSaldo`) | `sin_saldo` (nuevo) | fatal |
| 429 restante, 408, 500, 502, 503, 504, 529 | `saturado` | reintentable; `esperaMs` = cabecera `Retry-After` en segundos, con tope de 60 s |
| 404 y demás | `otro` | deja probar el modelo siguiente |

El mensaje del error lleva el nombre del proveedor, el HTTP y `detalleErrorApi`.

`sin_saldo` se añade a `MENSAJES_ERROR` y a `CODIGOS_CLAVE` (`comun.js`): no se arregla esperando.

### 4. Reintentos y service worker (`background.js`)

- `importScripts` carga `proveedores.js`.
- El oyente de `storage.onChanged` relanza lo pendiente cuando cambia **cualquier** campo de clave de un proveedor que transcribe, o `provTranscribe`, y después del cambio `proveedorVoz(cfg)` no está vacío. Debe seguir cumpliéndose el test actual (`storage.local.set({ geminiKey })` relanza).
- `revisarPendientes` usa `proveedorVoz(cfg)` donde hoy mira `geminiKey`.
- El acta automática usa `proveedorTexto(cfg, cfg.autoActaProv)`: si el elegido no tiene clave, el primero que la tenga.

### 5. Grabar sin clave

- `popup.js`: la puerta deja de ser `geminiKey`. Se enseña el panel de grabar si `proveedorVoz(cfg)` no está vacío, **o** `cfg.grabarSinClave`, **o** hay una grabación en curso (hoy una grabación arrancada con el atajo no se puede parar desde el popup si falta la clave).
- El panel de bienvenida gana un segundo botón, «Grabar sin transcribir», que guarda `grabarSinClave: true` y enseña el panel de grabar.
- Con el panel de grabar a la vista y sin proveedor, una línea fija: «Sin clave de IA: Escriba graba y guarda el audio, pero no lo transcribe» con un enlace «Poner una clave».
- Al parar sin clave no cambia el motor: los tramos quedan `pendiente` con `sin_clave`, el audio sigue en IndexedDB y en `Descargas\reuniones\audio_<fecha>\`, y se transcribe solo cuando se guarde una clave. Cambian los textos, que dejan de sonar a fallo: `com.errSinClave`, `pop.luegoSinClave`, la notificación del final.
- Biblioteca (`reuniones.js`): el reproductor también reproduce el audio de los tramos pendientes (almacén `audios`), no solo el conservado (`escucha`). Como una reunión sin texto no tiene frases que pulsar, el reproductor gana un botón «Escuchar» que empieza por el primer tramo con audio.
- `importar.js`: el aviso de clave ausente pasa a ser neutro.

### 6. Acta y preguntas (`ia.js`)

`llamarIA` deja de tener tres ramas a mano:

- `gemini`: como está.
- `claude` (dialecto `anthropic`), comprobado de forma explícita: mismo cuerpo que hoy; modelo por defecto y reserva del registro.
- Dialecto `openai` (el resto): URL `{base}/chat/completions`, `Authorization: Bearer`, cuerpo `{ model, messages }`, sin extras (OpenRouter añade solo sus dos cabeceras). Para `gpt` la petición debe salir idéntica a la de hoy: hay un test que lo fija. `message.content` puede ser texto o lista de trozos. Si un 200 trae `error`, es un error.
- Cascada de modelos en todos: con 404 se prueba el siguiente de la reserva.
- `fetchIA` reintenta también el 529, respeta `Retry-After` (tope 30 s) y **no** reintenta los errores de saldo ni el 413.
- `errorIA` usa `detalleErrorApi` y gana el caso de saldo (`ia.errSaldo`) y el de «no cabe» (`ia.errNoCabe`, 413).
- Si el modelo corta por longitud (`finish_reason: "length"`, `stop_reason: "max_tokens"`, `MAX_TOKENS`), el resultado lleva `truncado: true` y la biblioteca lo avisa.

Un id desconocido, o uno cuya capacidad de texto está apagada, da `ia.provDesconocido`; ya no cae en la rama de Claude.

### 7. Opciones

- **Empezar, paso 1**: se queda con Gemini como opción destacada («gratis»), tal como está, y añade debajo dos líneas: «¿Tienes clave de otra IA? Ponla en *Claves de IA*» (enlace al apartado nuevo) y «¿Sin clave? Puedes grabar igualmente: Escriba guarda el audio». El paso se da por hecho cuando `proveedorVoz(cfg)` no está vacío, sea cual sea el proveedor, y dice con cuál se transcribe.
- **Apartado nuevo «Claves de IA»** (entrada en el índice), pintado desde el registro, con una tarjeta por proveedor **visible** (alguna capacidad encendida) distinto de Gemini: nombre, etiquetas («Transcribe» o «No transcribe», «Actas», «Gratis»), una línea de ayuda con el enlace para sacar la clave, el aviso propio si lo tiene (Mistral: saldo gratuito mensual y entrenamiento en ese plan; DeepSeek: datos en China; Claude y DeepSeek: no transcriben; Groq: sin hablantes y actas cortas en el plan gratuito), campo de clave con el botón de ver, botón **«Guardar»**, línea de estado, modelo para actas (campo con lista) y, si transcribe y tiene más de un modelo de voz, su desplegable.
  - El clic en «Guardar» es el gesto: si el host no es fijo, lo primero es `chrome.permissions.request({ origins: [host] })`. Denegado: no se guarda y se dice. Concedido: se comprueba la clave con `GET {base}/models`; si responde, se guardan clave y modelo y se cargan los modelos en la lista.
  - Vaciar el campo y guardar borra la clave (y retira el permiso opcional).
  - Las claves de OpenAI y Anthropic se mudan a estas tarjetas (dejan de guardarse a cada tecla); quien ya las tenía guardadas las sigue viendo puestas. Con el estado de salida, este apartado enseña solo esas dos tarjetas.
  - La etiqueta «Transcribe» / «No transcribe» y el desplegable de voz reflejan lo encendido: OpenAI, con la voz apagada, se presenta como hoy (solo actas y preguntas).
- **Transcripción**: fila nueva «Quién transcribe» con `provTranscribe`: «Automático (la primera clave que haya)» y los proveedores que transcriben; los que no tienen clave salen deshabilitados. **La fila solo se enseña si hay más de un proveedor de voz encendido** (con el estado de salida, no se ve). La fila «Modelo de Gemini» se queda.
- **Actas e IA**: el desplegable del acta automática sale del registro.
- **Coste**: la rejilla de precios se pinta desde el registro: entrada y salida por cada proveedor que redacta, `audio` para Gemini y `minuto` para los demás que transcriben.
- Todo id de modelo que venga de una API pasa por `escapa()` antes de ir a `innerHTML`.

### 8. Popup y resto de interfaz

- Diagnóstico: informa del proveedor de transcripción y prueba la conexión con su `GET …/models`.
- `reuniones.js`: los desplegables de acta y preguntas salen de `provsQueRedactan()`; se avisa si el acta llegó cortada.
- Textos: ninguno de `pop`, `opc`, `imp`, `com` u `off` nombra a Gemini o a Google salvo los que hablan de Gemini en concreto (su paso, su modelo, su Files API).

### 9. Coste (`comun.js`)

`costeReunion`: el tramo se cobra a `tr.prov` (`"gemini"` si no lo trae, como hasta ahora). Con `uso.segundos`, a `precios[prov].minuto`; con tokens, a `precios[prov].audio`. Sin precio o sin `uso`, el proveedor entra en `faltan`: nunca cuenta como cero.

### 10. Manifest y versión

`optional_host_permissions` no cambia en esta versión: el host de un proveedor (`https://api.mistral.ai/*`, `https://api.groq.com/*`, `https://api.deepseek.com/*`, `https://openrouter.ai/*`) se añade cuando se enciende, no antes. `permissions` y `host_permissions` no se tocan. Versión `3.8.0` en `manifest.json` y `package.json`.

### 11. Tests

Los 168 actuales siguen en verde. Nuevos, en el estilo de `tests/run.js`:

- Registro: cada proveedor tiene sus campos en `CFG_LOCAL` y sus textos en los dos idiomas; `proveedorVoz` y `proveedorTexto` en todos sus casos; ningún campo de clave en `CFG_SYNC`.
- Manifest: los opcionales son la unión de las webs de reunión y `origenesProveedores()`; `host_permissions` son exactamente los tres de siempre; el host de un proveedor apagado no está en ninguna de las dos listas; todo host de un `fetch("https://…")` está declarado.
- Interruptores: una capacidad apagada no sale en `provsQueTranscriben`/`provsQueRedactan`/`provsVisibles`, `proveedorVoz` y `proveedorTexto` la saltan aunque tenga clave, y `llamarIA`/`transcribirAudio` la rechazan; el estado de salida es el que dice el plan.
- La petición de acta a OpenAI y a Anthropic es idéntica a la de la 3.7.0 (URL, cabeceras y cuerpo).
- Por dialecto de voz (OpenAI con sus tres modelos, Groq, Mistral), encendiéndolo en el test: URL, cabecera, campos del formulario (glosario, idioma, nombre del fichero), respuesta convertida a líneas, hablantes numerados, tiempos, silencio sin texto inventado, frases inventadas de Whisper descartadas, 401 fatal, 402 y 429 de saldo, 429 y 503 reintentados, corte de red, modelo de reserva tras un 404.
- La trampa del «:» en líneas sin hablante.
- Ronda completa sin clave de Gemini y con otra; sin ninguna clave queda esperando y al guardar la de otro proveedor se transcribe sola; grabación en vivo con otro proveedor.
- Coste: tramo por minuto, tramo antiguo sin proveedor, proveedor sin precio.
- `llamarIA` por cada proveedor nuevo; acta automática sin clave de Gemini; 529; saldo; `content` como lista; `truncado`.
- `detalleErrorApi` y `sinSaldo` con los cuerpos reales de arriba.

Hacen falta en los simulados: `FormData`, `chrome.permissions` y un `fetch` que reparta por URL.

### 12. Documentación

`PRIVACY.md` (grabar sin clave; a quién va el audio y el texto según la clave que se ponga, **nombrando solo los proveedores encendidos**), `README.md`, `LEEME.txt`, `STORE_LISTING.md` (descripción, justificación de hosts, versión y nombre del zip), `CONTRIBUTING.md` y la descripción de los cinco `_locales` (132 caracteres como máximo).

## Lo que cambió tras la revisión (05/10/2026)

Seis revisores y un contraste por hallazgo, sobre el código ya escrito. Arreglado en esta versión:

- **Nada sin transcribir se borra solo, ni recién transcrito.** El tope de cien reuniones del historial ya no se lleva las que siguen sin transcribir, y tanto ese tope como la poda por límite dejan una semana de margen a las que se cierran con retraso, acaben bien o en error (quien graba sin clave junta más que el límite y, al poner la clave, se transcriben todas de golpe).
- **La clave de Gemini se puede quitar** («Quitar la clave de este equipo»). Vaciar el campo no la borra y ya no finge que falta.
- Una clave de OpenAI con permisos recortados (su 401 de «Missing scopes») se guarda, como hasta la 3.7.
- Si la clave llega mientras se cierra una ronda sin clave, la reunión se reintenta sola.
- Borrar la reunión abierta calla su audio; el aviso de la biblioteca ya no sale partido en columnas; la rejilla de precios de Opciones recupera su forma.
- Los hosts de los proveedores apagados salen del manifest.

## Antes de encender cada proveedor

Lo que la revisión encontró en el código apagado. No afecta a nadie hoy; hay que resolverlo, con su clave real delante, antes de cambiar el interruptor:

- **Voz de OpenAI.** `gpt-transcribe` da el uso en tokens y Opciones solo ofrece precio por minuto para la voz que no es Gemini: su coste saldría siempre «sin precio». Y **al encenderla, quien tenga la clave de OpenAI solo para las actas y haya grabado «sin clave» vería esas grabaciones enviarse solas a OpenAI**: hay que preguntarlo, no darlo por hecho.
- **Whisper (Groq y `whisper-1`).** Con idioma «Detectar» el `prompt` va en español y puede sesgar una reunión en otro idioma; el recorte a 600 caracteres conserva el principio y Whisper atiende sobre todo al final; el idioma elegido se manda como orden, no como pista.
- **Hablantes (Mistral, modelo de hablantes de OpenAI).** Se numeran desde 1 en cada tramo: «Hablante 1» de un tramo puede no ser el del siguiente. Hace falta decirlo en la interfaz o casar las voces entre tramos.
- **Líneas sin hablante.** El carácter invisible U+2060 viaja en lo que se manda a la IA para el acta, en «Copiar» de la página de importar y en el `.md` de Descargas.
- **Diagnóstico.** Enseña los primeros caracteres de la clave, pensado para la de Gemini; revisar con las demás.
- **Lo que solo una clave real puede decir:** que acepten el `webm` de `MediaRecorder`, los cuerpos reales de 429 y 413, los límites del plan gratuito y la calidad en castellano.

## Verificación

1. `npm test` en verde, en Node 20 y 22.
2. En Chrome real, con el paquete: Gemini con clave real de punta a punta (no debe cambiar nada); cada proveedor nuevo con sus respuestas simuladas por interceptación de red (petición bien formada y texto en la biblioteca); la tarjeta de Opciones con el diálogo de permiso; grabar sin clave, escuchar el audio en la biblioteca y que se transcriba al poner una clave.
3. Lo que no se puede dar por probado sin una clave de cada proveedor: que acepten el `webm` de `MediaRecorder` tal cual y la calidad en castellano.
