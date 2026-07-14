# Desarrollar en TranscriptorGod

Extensión de Chrome (Manifest V3). No hay build ni dependencias: se edita el código y se recarga. Cualquiera con el repo puede tocar y probar en 2 minutos.

## Poner en marcha

```bash
git clone https://github.com/AlvaroGarrido10/TranscriptorGod.git
```

1. Chrome → `chrome://extensions` → activa **Modo de desarrollador**
2. **Cargar descomprimida** → elige la carpeta del repo
3. Clic derecho en el icono 🎙️ → **Opciones** → pega tu clave gratuita de [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (se valida sola) y permite el micrófono

Cada persona usa **su propia clave**: no hay servidores ni secretos en el repo.

**Tras cada cambio de código:** `chrome://extensions` → botón ↻ de la extensión.

## Cómo está montado

| Archivo | Qué hace |
|---|---|
| `manifest.json` | Permisos y declaración de la extensión (MV3) |
| `background.js` | Service worker: orquesta todo. **Es el único que puede usar `chrome.storage`, `chrome.downloads`, `chrome.tabs` y `chrome.tabCapture`** |
| `offscreen.js` | Documento offscreen: graba el audio (pestaña + micro) y llama a Gemini. Sobrevive al cierre del popup |
| `popup.js/html` | Panel: grabar/parar, historial, ver transcripción, analizar con IA, diagnóstico |
| `options.js/html` | Configuración: valida la clave, elige modelo compatible y pide permiso de micrófono |

### Reglas del terreno (aprendidas a golpes)

- **En `offscreen.js` NO existe `chrome.storage` ni `chrome.downloads`.** Todo lo que necesite almacenamiento o descargas se pide al service worker por `chrome.runtime.sendMessage({target:"bg", ...})`.
- En `background.js`, descarta de forma **síncrona** los mensajes que no son suyos (`if (msg.target !== "bg") return false;`). Si devuelves `true` para mensajes ajenos, el canal se cierra sin respuesta y las órdenes mueren en silencio.
- El service worker **se duerme**: no guardes estado en variables globales, usa `chrome.storage.session`.
- Modelos de Gemini: no fijes uno a fuego. Las claves nuevas ya no pueden usar algunos modelos antiguos (404 "no longer available to new users"). `options.js` prueba varios y se queda con el que responda.
- La captura de pestaña falla en páginas `chrome://`, de la Web Store y de la propia extensión. `background.js` busca la pestaña que **esté sonando** (`tab.audible`).

## Depurar

- **Botón 🩺 Diagnóstico** en el panel: comprueba clave, conexión con Gemini, permiso de micro, graba 3 s de prueba y transcribe. Es la vía rápida cuando algo no va.
- Errores del grabador: `chrome://extensions` → tarjeta de la extensión → **Errores** / **Service worker** (consola).
- La transcripción y el audio siempre acaban en `Descargas/reuniones/`, incluso si algo falla.

## Publicar una versión

1. Sube el número en `manifest.json` (la Store rechaza versiones repetidas).
2. Zip con: `manifest.json`, `background.js`, `offscreen.*`, `popup.*`, `options.*`, `icon*.png` (sin docs ni zips).
3. [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole) → el elemento → **Paquete** → subir → **Enviar a revisión**.

Textos de la ficha y justificación de permisos: `STORE_LISTING.md`. Política de privacidad: `PRIVACY.md`.

## Ideas pendientes

- Transcripción en vivo (por bloques de 1 min) mientras la reunión sigue.
- Plantillas de análisis: acta formal, correo de seguimiento, lista de tareas.
- Enviar el acta por correo con un clic.
- Webhooks: mandar el resultado a Odoo, Notion o Slack.
