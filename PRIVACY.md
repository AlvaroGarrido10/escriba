# Política de privacidad — TranscriptorGod

**Última actualización: 13/07/2026**

TranscriptorGod es una extensión de Chrome que graba reuniones y las transcribe/analiza usando servicios de IA con las claves API del propio usuario.

## Qué datos se tratan y dónde

- **Audio de la reunión** (pestaña y/o micrófono): se graba localmente en tu navegador. Al parar la grabación, el audio se envía **directamente desde tu navegador a la API de Google Gemini** usando **tu propia clave API**, con el único fin de generar la transcripción. La extensión no tiene servidores propios: el audio no pasa por ningún sistema del desarrollador.
- **Transcripciones y análisis**: se guardan localmente en tu navegador (historial de la extensión) y en tu carpeta de Descargas. Si pulsas «Analizar», el texto de la transcripción se envía al proveedor de IA que elijas (Google Gemini, OpenAI o Anthropic), siempre con tu propia clave.
- **Claves API**: se guardan en el almacenamiento de tu navegador (chrome.storage). Nunca se envían al desarrollador.

## Qué datos NO se tratan

- No hay cuentas de usuario, ni telemetría, ni analítica, ni cookies.
- El desarrollador no recibe, almacena ni puede acceder a tus audios, transcripciones, análisis o claves.

## Terceros

El uso de las APIs de Google Gemini, OpenAI y Anthropic está sujeto a las políticas de privacidad de esos proveedores. Tú eliges qué proveedor usar y con qué clave.

## Permisos de la extensión

- `tabCapture`: capturar el audio de la pestaña de la reunión (Meet, Teams web…), solo cuando tú inicias una grabación.
- Micrófono: grabar tu voz o reuniones presenciales, solo cuando tú inicias una grabación.
- `downloads`: guardar la transcripción (.md) y el audio en tu carpeta de Descargas.
- `storage`: guardar tu configuración e historial localmente.

## Contacto

Para cualquier consulta sobre esta política: alvarogarrido98@hotmail.com
