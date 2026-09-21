# Política de privacidad — Escriba

**Última actualización: 21/09/2026 (versión 3.1.0)**

Escriba es una extensión de Chrome que graba reuniones y las transcribe/analiza usando servicios de IA con las claves API del propio usuario.

## Qué datos se tratan y dónde

- **Audio de la reunión** (pestaña y/o micrófono): se graba localmente en tu navegador. Al parar la grabación, el audio se envía **directamente desde tu navegador a la API de Google Gemini** usando **tu propia clave API**, con el único fin de generar la transcripción. La extensión no tiene servidores propios: el audio no pasa por ningún sistema del desarrollador.
- **Audio pendiente de transcribir**: mientras se graba, y hasta que su transcripción está guardada, cada tramo de audio se conserva en el almacenamiento interno del navegador (IndexedDB de la extensión), **solo en tu equipo**. Sirve para reintentar si la transcripción falla o para recuperar la grabación si Chrome se cierra. Se borra solo en cuanto el tramo está transcrito, y siempre que borras esa reunión del historial.
- **Archivos que importas** («Transcribir un archivo»): se procesan dentro de tu navegador y siguen el mismo camino que una grabación. No se suben a ningún sitio salvo a Gemini, para transcribirlos.
- **Transcripciones y análisis**: se guardan localmente en tu navegador (historial de la extensión) y en tu carpeta de Descargas. Si pulsas «Analizar», el texto de la transcripción se envía al proveedor de IA que elijas (Google Gemini, OpenAI o Anthropic), siempre con tu propia clave.
- **Claves API**: se guardan en `chrome.storage.local`, es decir, **solo en el equipo donde las escribiste**. No se sincronizan con tu cuenta de Google ni con tus otros navegadores, y nunca se envían al desarrollador. Si usabas una versión anterior a la 3.0.0, que las guardaba en `chrome.storage.sync`, la extensión las traslada a almacenamiento local y las borra del sincronizado la primera vez que se abre.

## Qué datos NO se tratan

- No hay cuentas de usuario, ni telemetría, ni analítica, ni cookies.
- El desarrollador no recibe, almacena ni puede acceder a tus audios, transcripciones, análisis o claves.

## Terceros

El uso de las APIs de Google Gemini, OpenAI y Anthropic está sujeto a las políticas de privacidad de esos proveedores. Tú eliges qué proveedor usar y con qué clave.

## Permisos de la extensión

- `tabCapture`: capturar el audio de la pestaña de la reunión (Meet, Teams web…), solo cuando tú inicias una grabación.
- Micrófono: grabar tu voz o reuniones presenciales, solo cuando tú inicias una grabación.
- `downloads`: guardar la transcripción (.md) y el audio en tu carpeta de Descargas.
- `storage` y `unlimitedStorage`: guardar tu configuración, tu historial y el audio pendiente de transcribir, localmente.
- `alarms`: reintentar sola, pasados unos minutos, una transcripción que falló.

## Contacto

Para cualquier consulta sobre esta política: alvarogarrido98@hotmail.com
