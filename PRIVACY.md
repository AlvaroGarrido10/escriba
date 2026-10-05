# Política de privacidad — Escriba

**Última actualización: 05/10/2026 (versión 3.8.0)**

Escriba es una extensión de Chrome que graba reuniones y las transcribe/analiza usando servicios de IA con las claves API del propio usuario. También graba sin ninguna clave: entonces guarda el audio en tu equipo y no envía nada a nadie.

## Qué datos se tratan y dónde

- **Lo que compartes al grabar** (forma «Pestaña + micro»): Chrome te enseña su ventana de «elegir qué compartir» y tú decides qué pestaña o pantalla. Escriba usa **solo el sonido**. La imagen que Chrome entrega junto a él se descarta en el mismo instante: nunca se graba, se guarda ni se envía.
- **Audio de la reunión** (pestaña o pantalla compartida, y/o micrófono): se graba localmente en tu navegador, en tramos de cinco minutos. Si has guardado tu clave de Google Gemini, el audio no espera al final: cada tramo se envía en cuanto se cierra, mientras sigues grabando, y el último al parar. Va **directamente desde tu navegador a la API de Google Gemini** usando **tu propia clave API**, con el único fin de generar la transcripción. La extensión no tiene servidores propios: el audio no pasa por ningún sistema del desarrollador.
- **Grabar sin clave** (desde la 3.8.0): puedes grabar sin haber puesto ninguna clave. En ese caso **el audio no se envía a nadie**: se queda en tu equipo, en el almacenamiento interno del navegador y con una copia en tu carpeta de Descargas (`reuniones/audio_<fecha>/`), y puedes escucharlo desde la biblioteca. Si más adelante guardas una clave con la que transcribir (hoy, la de Google Gemini), Escriba envía entonces ese audio a ese proveedor para transcribirlo, sin que tengas que pedirlo. Si no quieres que una grabación se envíe, bórrala antes de guardar la clave. La copia de Descargas no se borra al transcribirse: sigue en tu equipo hasta que borres la reunión con su audio de respaldo o la limpieza automática se la lleve.
- **Audio pendiente de transcribir**: mientras se graba, y hasta que su transcripción está guardada, cada tramo de audio se conserva en el almacenamiento interno del navegador (IndexedDB de la extensión), **solo en tu equipo**. Sirve para reintentar si la transcripción falla o para recuperar la grabación si Chrome se cierra. Se borra solo en cuanto el tramo está transcrito, y siempre que borras esa reunión del historial. Si grabaste sin clave, sigue ahí hasta que guardes una y se transcriba, o hasta que borres la reunión.
- **Audio conservado para escuchar** (opcional, desactivado por defecto): si activas «Conservar el audio» en Opciones, el audio de cada reunión ya transcrita se guarda en el almacenamiento interno del navegador, **solo en tu equipo**, para poder escucharlo desde la biblioteca. Se borra al borrar la reunión, al podarse el historial o con el botón de la papelera junto al reproductor («Borrar el audio»).
- **Participantes, glosario, notas y momentos marcados**: lo que escribes se guarda en tu navegador. Si pides una transcripción o un acta, se envía junto al audio o al texto al proveedor que elijas, para que ponga bien los nombres y tenga en cuenta tus notas.
- **Archivos que importas** («Transcribir un archivo»): se procesan dentro de tu navegador y siguen el mismo camino que una grabación: se envían a Google Gemini para transcribirlos si has guardado su clave, y a nadie si no la hay.
- **Transcripciones y análisis**: se guardan localmente en tu navegador (historial de la extensión) y en tu carpeta de Descargas. Cuando generas un acta o le haces una pregunta a la reunión, el texto de la transcripción se envía al proveedor de IA que elijas en ese momento (Google Gemini, OpenAI o Anthropic), siempre con tu propia clave. Si activas el acta automática, se envía al terminar la transcripción al proveedor elegido en Opciones o, si no has guardado su clave, a otro de esos tres del que sí la tengas.
- **Dirección de las pestañas de reuniones** (opcional, desactivado por defecto): si activas «Aviso al entrar en una reunión», Chrome te pide permiso para Google Meet, Microsoft Teams, Zoom, kMeet de Infomaniak y Jitsi. Con él, la extensión mira **solo la dirección** de esas pestañas para saber si estás en una sala, y te avisa. No lee el contenido de esas páginas, no guarda las direcciones más allá de la sesión del navegador y no envía nada a nadie. Al desactivarlo, el permiso se retira.
- **Precios para el coste estimado**: los que escribes en Opciones se guardan en tu configuración de Chrome y solo sirven para calcular el coste en la biblioteca. Los «precios de referencia» van dentro de la extensión: cargarlos no consulta ninguna web.
- **Preferencias de la interfaz** (idioma y tema claro u oscuro): se guardan en tu configuración de Chrome. El tema se copia además en el almacenamiento local de la extensión, para aplicarlo antes de pintar cada página.
- **Claves API**: se guardan en `chrome.storage.local`, es decir, **solo en el equipo donde las escribiste**. No se sincronizan con tu cuenta de Google ni con tus otros navegadores, y nunca se envían al desarrollador. Cada clave viaja solo al proveedor que te la dio: al guardarla, para comprobar que vale, y en cada petición que le haces. Si usabas una versión anterior a la 3.0.0, que las guardaba en `chrome.storage.sync`, la extensión las traslada a almacenamiento local y las borra del sincronizado la primera vez que se abre.

## Qué datos NO se tratan

- No hay cuentas de usuario, ni telemetría, ni analítica, ni cookies.
- El desarrollador no recibe, almacena ni puede acceder a tus audios, transcripciones, análisis o claves.

## Terceros

Qué recibe cada proveedor depende de la clave que hayas guardado:

| Clave guardada | Qué se le envía |
|---|---|
| Ninguna | Nada. El audio y todo lo demás se quedan en tu equipo. |
| Google Gemini | El audio, para transcribirlo. Y el texto de la transcripción, cuando le pides un acta o le haces una pregunta. |
| OpenAI | Solo el texto de la transcripción, cuando le pides un acta o le haces una pregunta. Nunca el audio. |
| Anthropic | Solo el texto de la transcripción, cuando le pides un acta o le haces una pregunta. Nunca el audio. |

El uso de las APIs de Google Gemini, OpenAI y Anthropic está sujeto a las políticas de privacidad de esos proveedores. Tú eliges qué proveedor usar y con qué clave.

## Permisos de la extensión

- Compartir pestaña o pantalla (la ventana de Chrome de «elegir qué compartir»; no es un permiso fijo, lo concedes cada vez): recibir el sonido de la reunión sin silenciarla, solo cuando tú inicias una grabación y eliges qué compartir.
- `tabCapture`: en la forma «Rápido», capturar con un clic el audio de la pestaña de la reunión (Meet, Teams web…), solo cuando tú inicias una grabación.
- Micrófono: grabar tu voz o reuniones presenciales, solo cuando tú inicias una grabación.
- `activeTab`: saber qué pestaña tienes delante en el momento en que tú inicias una grabación (su título, para ponérselo a la reunión).
- `offscreen`: el documento en segundo plano que graba y transcribe aunque cierres el panel de Escriba.
- `downloads`: guardar la transcripción (.md) y el audio en tu carpeta de Descargas.
- `storage` y `unlimitedStorage`: guardar tu configuración, tu historial y el audio pendiente de transcribir, localmente.
- `alarms`: reintentar sola, pasados unos minutos, una transcripción que falló.
- `notifications`: avisarte si en dos minutos de grabación no entra voz por ninguna fuente, y, si lo activas, cuando entras en una reunión.
- Acceso a `generativelanguage.googleapis.com`, `api.openai.com` y `api.anthropic.com`: llamar directamente a las APIs de Google Gemini, OpenAI y Anthropic con tus claves. Al proveedor del que no has guardado clave no se le envía nada.
- Acceso opcional a `meet.google.com`, `teams.microsoft.com`, `teams.live.com`, `*.zoom.us`, `kmeet.infomaniak.com` y `meet.jit.si`: solo si activas el aviso de reuniones, y solo para ver la dirección de la pestaña.
- `sidePanel`: el panel lateral «En vivo», que se abre solo cuando lo pides.
- Atajos de teclado (`commands`): empezar o parar la grabación y marcar un momento. Se pueden cambiar en `chrome://extensions/shortcuts`.

## Contacto

Para cualquier consulta sobre esta política: alvarogarrido98@hotmail.com
