# 🎙️ Escriba

[![CI](https://github.com/AlvaroGarrido10/escriba/actions/workflows/ci.yml/badge.svg)](https://github.com/AlvaroGarrido10/escriba/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Extensión de Chrome (Manifest V3) que graba reuniones y las transcribe con IA. Sin servidor, sin cuenta y sin suscripción: cada usuario pone su propia clave de API (BYOK) y el audio va de su navegador al modelo, sin intermediarios.

- **Reuniones online** (Meet, Teams web…): graba el audio de la pestaña **y** el micrófono a la vez.
- **Reuniones presenciales**: graba solo con el micrófono.
- Al parar, la transcripción se descarga en `Descargas\reuniones\` como `.md` y queda en el historial.
- Análisis posterior de la transcripción con **Gemini, GPT o Claude**, a elegir.

## Cómo está construido

La grabación vive en un **documento offscreen**, no en el popup, así que cerrar la ventanita no corta la grabación. El *service worker* orquesta; el documento offscreen graba y transcribe.

```
popup.js  ──▶  background.js (service worker)  ──▶  offscreen.js
 control          orquestación + storage           grabación + transcripción
```

## Decisiones de ingeniería

Las tres cosas que impedían que funcionara de verdad, y cómo se resolvieron:

**1. Una sola llamada por reunión no escala.** Enviar la reunión entera en una petición hacía que el modelo se rindiera a los pocos minutos y devolviera la transcripción truncada, marcada como correcta — una reunión larga se quedó en 83 segundos transcritos. Ahora el audio se corta en **tramos de 5 minutos**, con un `MediaRecorder` por tramo, y el progreso se reporta tramo a tramo.

**2. Sin reintentos, un 503 transitorio cuesta la reunión entera.** Ahora hay **backoff de 3/8/20 s** respetando el `retryDelay` que devuelve la API, y una **cascada de modelos de reserva**. Un tramo fallido cuesta 5 minutos, no la reunión, y su audio se conserva en disco para reintentarlo.

**3. El modelo alucina con el silencio.** Ante audio mudo, Gemini llegó a inventarse una reunión completa, con hablantes y acuerdos falsos. Ahora un tramo sin voz **no se manda**, y el prompt obliga además a responder literalmente `SIN_VOZ`. Es el fallo más caro de los tres: una transcripción truncada se nota, una inventada no.

**Y el fallo que introdujo ese arreglo.** La primera versión del guardia de silencio medía con un `AnalyserNode` muestreado una vez por segundo: 2048 muestras, unos 42 ms de cada 1.000. Veía el **4 % del audio**, así que una intervención corta caía entre muestras y el tramo se descartaba entero sin preguntar al modelo. Descartar voz real es peor que el problema original. Ahora el tramo ya grabado se **decodifica completo** y se recorre en ventanas de 20 ms; el analizador se ha quedado solo para el informe de niveles por fuente, que es para lo que sirve. Si la decodificación falla, el tramo se envía igual: gastar tres céntimos es más barato que perder un minuto de reunión.

## Validación

Los tests corren en Node contra un navegador simulado: se carga el código real de la extensión con `vm.runInContext` y se le inyectan stubs de `chrome`, `MediaRecorder`, `AudioContext` y `fetch`. Sin build, sin dependencias.

```
npm test
```

Cubren el ciclo de grabación y troceado, la cola de escritura del historial, la política de reintentos y modelos de reserva, la clasificación de silencio y la migración de claves de `sync` a `local`.

Además, una prueba de extremo a extremo con audio real: WAV sintético de 13 minutos con 120 puntos numerados, generado por TTS → troceado → transcrito → **120/120 recuperados, en orden y sin duplicados**.

## Instalación (2 minutos, una vez)

1. Abre Chrome en `chrome://extensions`
2. Activa el **Modo desarrollador** (interruptor arriba a la derecha).
3. Pulsa **«Cargar descomprimida»** y elige esta carpeta.
4. Ancla el icono: puzzle 🧩 de la barra → chincheta 📌 junto a Escriba.

## Configuración (1 minuto, una vez)

1. Consigue tu clave gratis en **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** → **Create API key** → copiar.
2. Clic derecho en el icono → **Opciones**:
   - Pega la clave. Se valida sola y se pone en verde.
   - Pulsa **Permitir micrófono** y acepta. *(Un documento offscreen no puede pedir el permiso de micrófono por sí mismo; hay que concederlo desde esta página.)*
3. Opcional: rellena el **glosario** con nombres propios y jerga de tu dominio, para que el modelo respete la ortografía exacta. Viene vacío.
4. Opcional: claves de OpenAI y Anthropic, si quieres analizar con GPT o Claude además de con Gemini.

## Uso

1. En la pestaña de la reunión, pulsa el icono 🎙️ y elige modo: **pestaña + micro**, **todo el PC + micro** o **solo micro**.
2. **⏺ Empezar a grabar.** Puedes cerrar el popup: el badge REC indica que sigue grabando.
3. **⏹ Parar y transcribir.** Verás el avance por tramos («3/12»). Una reunión de una hora tarda un par de minutos.
4. La transcripción se descarga sola, queda en el historial y puedes analizarla con la IA que elijas.

## Preguntas rápidas

- **¿Cuánto cuesta?** Nada por la extensión. La capa gratuita de Gemini cubre reuniones diarias de sobra.
- **¿Dónde va mi audio?** De tu Chrome a la API del proveedor cuya clave hayas puesto. No hay servidor intermedio: no existe backend que pueda verlo. Ver [PRIVACY.md](PRIVACY.md).
- **¿Se corta si cambio de pestaña?** No. La grabación vive en el documento offscreen.
- **La transcripción falló.** El audio no se pierde: está en `Descargas/reuniones/audio_<fecha>/`.

## Stack

JavaScript sin dependencias ni build · Chrome Extensions MV3 · `MediaRecorder` · `AudioContext` · `chrome.tabCapture` · `chrome.offscreen` · Gemini API (inline y Files API) · OpenAI API · Anthropic API.

Cómo desarrollar y depurar: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

MIT — ver [LICENSE](LICENSE).
