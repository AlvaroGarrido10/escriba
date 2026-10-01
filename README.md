# <img src="icon128.png" width="32" alt=""> Escriba

[![CI](https://github.com/AlvaroGarrido10/escriba/actions/workflows/ci.yml/badge.svg)](https://github.com/AlvaroGarrido10/escriba/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Extensión de Chrome (Manifest V3) que graba reuniones y las transcribe con IA. Sin servidor, sin cuenta y sin suscripción: cada usuario pone su propia clave de API (BYOK) y el audio va de su navegador al modelo, sin intermediarios.

- **Reuniones online** (Meet, Teams web…): graba el audio de la pestaña **y** el micrófono a la vez.
- **Reuniones presenciales**: graba solo con el micrófono.
- **Archivos que ya tienes** (notas de voz, grabaciones de otra herramienta): «📂 Transcribir un archivo» acepta mp3, m4a, wav, webm, ogg, flac o mp4.
- Al parar, la transcripción se descarga en `Descargas\reuniones\` como `.md` y queda en el historial.
- **No se pierde audio**: si un tramo no se puede transcribir, su audio se guarda y se reintenta solo. Si Chrome se cierra a mitad de reunión, se recupera lo grabado.
- **Biblioteca de reuniones** (3.2): búsqueda en todas las reuniones, lectura con marcas de tiempo y cada voz en su color, nombres reales para cada hablante («Hablante 2» → «Marcos») y exportación a Word, PDF, texto, Markdown o subtítulos SRT.
- **Actas con plantillas** (acta completa, resumen breve, tareas y responsables, correo de seguimiento o una plantilla propia) y **preguntas a la reunión**, con **Gemini, GPT o Claude**. El acta puede generarse sola al terminar.
- **Mientras grabas** (3.3): cada tramo se transcribe en cuanto se cierra, **pausa**, **marcadores** de momentos importantes, **notas**, **panel lateral en vivo** con niveles de audio, **aviso si en dos minutos no entra voz** y **atajo de teclado** (Alt+Shift+G).
- **Escuchar la reunión** (3.4, opcional): se pulsa una frase y suena ese momento.
- **Coste estimado** (3.5): con los precios que pongas en Opciones, la biblioteca dice cuánto costó cada reunión y lo que llevas de mes. Sin precios no se inventa nada.
- **Aviso al entrar en una reunión** (3.5, opcional): Meet, Teams, Zoom web, kMeet de Infomaniak o Jitsi. Te recuerda grabar; grabar sigue siendo cosa tuya (Chrome solo deja capturar una pestaña si pulsas el icono o el atajo).
- **Interfaz en español e inglés** (3.5): según el idioma de Chrome, o el que elijas en Opciones.
- **Se oye la reunión por cualquier salida** (3.5.1): si cambia el dispositivo (monitor, cascos) el sonido se rehace, y mientras grabas, «🔊 ¿No oyes la reunión?» cambia en vivo la forma de devolverlo.
- Idioma configurable, incluida la detección automática para reuniones que mezclan idiomas.

## Cómo está construido

La grabación vive en un **documento offscreen**, no en el popup, así que cerrar la ventanita no corta la grabación. El *service worker* orquesta; el documento offscreen graba y transcribe.

```
popup.js ──┐                                        ┌─▶ offscreen.js
vivo.js ───┤                                        │   grabación, pausa, transcripción en vivo
importar.js├─▶ background.js (service worker) ──────┤   y por rondas, acta automática
reuniones.js┘  historial (única vía de escritura),  │
               alarmas, atajos, avisos, recuperación└─▶ IndexedDB (comun.js): audio pendiente
                                                         y audio conservado para escuchar
ia.js       plantillas, Gemini/GPT/Claude, preguntas (lo usan la biblioteca y el offscreen)
exportar.js Word (.docx sin librerías), SRT, texto y HTML seguro
```

Un mismo motor (`transcribirReunion`) transcribe los tramos pendientes de una reunión, venga de una grabación, de un reintento o de un archivo importado.

## Decisiones de ingeniería

Las tres cosas que impedían que funcionara de verdad, y cómo se resolvieron:

**1. Una sola llamada por reunión no escala.** Enviar la reunión entera en una petición hacía que el modelo se rindiera a los pocos minutos y devolviera la transcripción truncada, marcada como correcta — una reunión larga se quedó en 83 segundos transcritos. Ahora el audio se corta en **tramos de 5 minutos**, con un `MediaRecorder` por tramo, y el progreso se reporta tramo a tramo.

**2. Sin reintentos, un 503 transitorio cuesta la reunión entera.** Ahora hay **backoff de 3/8/20 s** respetando el `retryDelay` que devuelve la API, y una **cascada de modelos de reserva**. Un tramo fallido cuesta 5 minutos, no la reunión, y su audio se conserva en disco para reintentarlo.

**3. El modelo alucina con el silencio.** Ante audio mudo, Gemini llegó a inventarse una reunión completa, con hablantes y acuerdos falsos. Ahora un tramo sin voz **no se manda**, y el prompt obliga además a responder literalmente `SIN_VOZ`. Es el fallo más caro de los tres: una transcripción truncada se nota, una inventada no.

**Y el fallo que introdujo ese arreglo.** La primera versión del guardia de silencio medía con un `AnalyserNode` muestreado una vez por segundo: 2048 muestras, unos 42 ms de cada 1.000. Veía el **4 % del audio**, así que una intervención corta caía entre muestras y el tramo se descartaba entero sin preguntar al modelo. Descartar voz real es peor que el problema original. Ahora el tramo ya grabado se **decodifica completo** y se recorre en ventanas de 20 ms; el analizador se ha quedado solo para el informe de niveles por fuente, que es para lo que sirve. Si la decodificación falla, el tramo se envía igual: gastar tres céntimos es más barato que perder un minuto de reunión.

**4. Un fallo no puede costar la reunión (3.1).** El 21/09/2026 una reunión de 13 minutos perdió sus tres tramos con «Falta la clave de Gemini» teniendo clave. Había dos defectos. El primero: el documento offscreen pide la configuración al *service worker* por mensaje, y una respuesta vacía se tomaba por «no hay clave». Ahora se reintenta y, si no llega, el error es «interno», no una mentira. El segundo: aunque el audio se guardaba en Descargas, la extensión no puede volver a leer ficheros de disco, así que no había forma de reintentar. Ahora cada tramo va a **IndexedDB** al grabarse (y el tramo en curso cada 30 s) y solo se borra cuando su texto está a salvo en el historial. Cada fallo lleva un código (`sin_clave`, `clave_invalida`, `saturado`, `red`, `interno`) que decide qué hacer:
- errores pasajeros → reintento automático a los 1, 5, 15, 60, 180 y 720 min (`chrome.alarms`), y al abrir el panel;
- clave ausente o rechazada → esperar no sirve: se reintenta en cuanto el usuario guarda una clave;
- siempre → botón «Reintentar ahora» en el historial.

Al arrancar Chrome, una reunión que se quedó en «grabando» se transcribe con lo que llegó a guardarse. La poda automática del historial no toca reuniones con tramos pendientes.

**5. Lo que viene después de grabar (3.2 – 3.4).** Comparado con Transkriptor, Tactiq, tl;dv, Fireflies y Otter (`docs/2026-09-30-plan-mejoras.md`), Escriba ganaba en no perder nada y en no cobrar, pero perdía en todo lo que viene después de grabar. Las decisiones que sostienen lo nuevo:
- **Marcas de tiempo por tramo.** El modelo marca `[MM:SS]` desde el principio de SU tramo. Cada tramo guarda dónde empieza (`inicioS`) y el texto se pasa a tiempo de reunión una sola vez, al guardarse. Así el visor, el .md y los subtítulos no saben nada de tramos.
- **Los nombres no tocan el texto.** «Hablante 2 → Marcos» es un mapa aparte que se aplica al ver, exportar y analizar. Un nombre mal puesto se corrige sin perder nada, y la palabra «Hablante 2» dentro de una frase no se cambia.
- **Transcribir mientras se graba sin pagar dos veces.** Cada tramo cerrado entra en una cola en vivo. Al parar, el cierre espera a que esa cola termine **antes** de leer el historial: si no, un texto recién llegado se pisaría con «pendiente» y se mandaría otra vez. Una grabación recuperada tras un cierre de Chrome conserva los tramos que ya tenían texto (su audio ya no existe, y no son «perdidos»).
- **La pausa cuenta tiempo grabado, no de reloj.** El tramo se corta cuando lleva 5 minutos grabados, y las marcas, la duración y los marcadores descuentan la pausa. Es lo único que casa con el audio.
- **La IA sale del popup.** Plantillas, llamadas y preguntas viven en `ia.js`, sin DOM ni `chrome.*`. El acta automática se genera en el documento offscreen y no en el service worker, que Chrome puede parar a mitad de una llamada larga.
- **Word de verdad sin librerías.** Un .docx es un zip de cinco XML. Se escribe sin comprimir (método «store») con un CRC32 propio. La suite lo vuelve a leer y lo valida.
- **Todo lo que viene del modelo se escapa** antes de pintarse: un acta o una respuesta con `<script>` se ve como texto.

## Validación

Los tests corren en Node contra un navegador simulado: se carga el código real de la extensión con `vm.runInContext` y se le inyectan stubs de `chrome`, `MediaRecorder`, `AudioContext` y `fetch`. Sin build, sin dependencias.

```
npm test
```

Cubren el ciclo de grabación y troceado, la cola de escritura del historial, la política de reintentos y modelos de reserva, la clasificación de silencio, la migración de claves de `sync` a `local` y, desde la 3.1, el motor completo con el *service worker* y el offscreen hablándose: reintentos programados, espera de clave, recuperación de grabaciones cortadas, limpieza de audio huérfano y el markdown que se rehace al completar un hueco. Desde la 3.2 – 3.4, además: marcas de tiempo, hablantes, Word/SRT/HTML, plantillas y las tres APIs de IA, acta automática, transcripción en vivo, pausa con reloj simulado, marcadores, aviso de silencio, atajo y audio conservado (103 casos).

Pruebas de extremo a extremo en Chromium real con la extensión cargada y Gemini de verdad (3.1):

| Escenario | Resultado |
|---|---|
| Importar un WAV de 6 min con frases conocidas | 2 tramos, ambas frases transcritas, audio interno borrado |
| Sin clave → el usuario la guarda | queda pendiente sin llamar a la red; se transcribe sola al guardar la clave |
| Clave rechazada → clave buena | pendiente con «Google rechaza la clave»; se completa al cambiarla |
| Gemini inalcanzable → vuelve la red | pendiente con alarma de reintento; «Reintentar ahora» la completa |
| Grabar 35 s con el micrófono | transcrita con la frase del audio de prueba |
| Chrome se cierra a los 65 s sin parar | al reabrir, se recupera y transcribe lo grabado |

Y la de la 2.5: WAV sintético de 13 minutos con 120 puntos numerados → troceado → transcrito → **120/120 recuperados, en orden y sin duplicados**.

Pruebas en pantalla de la 3.2 – 3.4 (30/09/2026), en Chromium con la extensión cargada y la IA simulada:

| Escenario | Resultado |
|---|---|
| Biblioteca con 4 reuniones (completa, incompleta, de la 3.1 y con error) | todas se abren; la de la 3.1 conserva su acta, marcada como versión anterior |
| Renombrar «Hablante 3» → Clara | cambia en todas sus intervenciones, el .md se rehace y el texto original no se toca |
| Buscar «renovacion» sin tilde en todas | encuentra la única reunión donde se dijo «renovación» |
| Exportar a Word y SRT | el .docx pasa `zipfile.testzip` y lo abre python-docx; el SRT sale con los nombres puestos |
| Acta de tareas y pregunta a la reunión | la IA recibe los nombres y los participantes; quedan guardadas con sus tokens |
| Grabar con micro simulado: marcar, pausar, notas desde el panel en vivo, parar sin red | el reloj se para en pausa, marcas y notas guardadas, la reunión queda pendiente con su audio a salvo |
| Escuchar desde una frase | suena desde ese segundo, resalta la frase y «🗑 Audio» borra el audio sin tocar el texto |

**Lo que no se ha probado aún con Gemini de verdad:** que el modelo respete siempre el formato `[MM:SS] Hablante: texto`. Si un tramo sale sin marcas, se ve igual que en la 3.1, sin romper nada.

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

1. En la pestaña de la reunión, pulsa el icono de Escriba y elige modo: **pestaña + micro** (Meet, Teams o cualquier reunión en el navegador) o **solo micro** (presenciales).
2. **⏺ Empezar a grabar.** Puedes cerrar el popup: el badge REC indica que sigue grabando.
   Opcional: escribe los **participantes** («Marcos, Ana»); ayudan a poner nombre a cada voz y al acta.
3. Mientras grabas: **⏸ Pausar**, **⭐ Marcar** un momento (o Alt+Shift+M) y **🪟 En vivo** para abrir el panel lateral con el texto que va llegando, los niveles y tus notas.
4. **⏹ Parar y transcribir** (o Alt+Shift+G). Como los tramos se transcriben mientras grabas, al parar solo falta el último.
5. La reunión se abre en la **biblioteca** («📚 Reuniones»): léela, pon nombre a cada voz, exporta a Word o PDF, saca el acta con la plantilla que quieras o pregúntale lo que necesites.

Para un audio que ya tienes: **📂 Transcribir un archivo** en el panel, arrástralo y pulsa Transcribir. Varios archivos a la vez se tratan como partes seguidas de la misma reunión.

## Preguntas rápidas

- **¿Cuánto cuesta?** Nada por la extensión. La capa gratuita de Gemini cubre reuniones diarias de sobra.
- **¿Dónde va mi audio?** De tu Chrome a la API del proveedor cuya clave hayas puesto. No hay servidor intermedio: no existe backend que pueda verlo. Ver [PRIVACY.md](PRIVACY.md).
- **¿Se corta si cambio de pestaña?** No. La grabación vive en el documento offscreen.
- **¿Se guarda el audio?** Solo el de lo pendiente de transcribir, salvo que actives «Conservar el audio» en Opciones para poder escucharlo desde la biblioteca. Siempre en tu navegador, y se borra con la reunión.
- **¿Por qué me avisa de que no oye nada?** Si en dos minutos no entra voz por ninguna fuente, Escriba avisa: suele ser la pestaña equivocada o el micro silenciado. Se quita en cuanto vuelve la voz.
- **La transcripción falló.** No hagas nada: la reunión sale como «incompleta» en el historial, dice por qué y cuándo lo reintentará. Si el problema era la clave, se reintenta al guardar una nueva. También tienes «🔄 Reintentar ahora», y una copia del audio en `Descargas/reuniones/audio_<fecha>/`.

## Stack

JavaScript sin dependencias ni build · Chrome Extensions MV3 · `MediaRecorder` · `AudioContext` · IndexedDB · `chrome.alarms` · `chrome.tabCapture` · `chrome.offscreen` · `chrome.sidePanel` · `chrome.commands` · `chrome.notifications` · Gemini API (inline y Files API) · OpenAI API · Anthropic API.

Cómo desarrollar y depurar: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

MIT — ver [LICENSE](LICENSE).
