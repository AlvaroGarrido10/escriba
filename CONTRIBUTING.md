# Desarrollar en Escriba

Extensión de Chrome (Manifest V3). No hay build ni dependencias: se edita el código y se recarga. Cualquiera con el repo puede tocar y probar en 2 minutos.

## Poner en marcha

```bash
git clone https://github.com/AlvaroGarrido10/escriba.git
```

1. Chrome → `chrome://extensions` → activa **Modo de desarrollador**
2. **Cargar descomprimida** → elige la carpeta del repo
3. Clic derecho en el icono de Escriba → **Opciones** → pega tu clave gratuita de [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (se valida sola) y permite el micrófono

Cada persona usa **su propia clave**: no hay servidores ni secretos en el repo. Sin clave la extensión también graba («Grabar sin transcribir» en el panel): guarda el audio y no transcribe hasta que haya una que transcriba.

**Tras cada cambio de código:** `chrome://extensions` → botón ↻ de la extensión.

## Cómo está montado

| Archivo | Qué hace |
|---|---|
| `manifest.json` | Permisos y declaración de la extensión (MV3) |
| `background.js` | Service worker: orquesta todo. **Es el único que puede usar `chrome.storage`, `chrome.downloads`, `chrome.tabs` y `chrome.tabCapture`** |
| `offscreen.js` | Documento offscreen: graba el audio (pestaña + micro) y tiene el motor de transcripción (`transcribirReunion`) que usan grabaciones, reintentos e importaciones. Sobrevive al cierre del popup |
| `comun.js` | Compartido por todos: almacén de audio en IndexedDB, códigos de error, estado y markdown de una reunión, troceado y WAV |
| `estilo.css` | Sistema visual común (3.6): tokens de claro y oscuro y componentes. Los colores se usan **siempre por token**: el test de contraste lee las parejas texto/fondo de aquí |
| `ui.js` | Piezas de interfaz comunes: tema (se aplica antes de pintar, desde `localStorage`), `icono()`, avisos, `toast`, menús y confirmación de borrado. Va en el `<head>` justo después de `i18n.js`. Solo declara funciones: cada página tiene su `const $` |
| `iconos.svg` | Sprite de iconos (Lucide, ISC). Se usan con `<svg class="i"><use href="iconos.svg#nombre">` o `icono("nombre")`; un test comprueba que todo icono usado existe |
| `importar.js/html/css` | Página «Transcribir un archivo»: decodifica, trocea en tramos de 5 min, guarda el audio y encarga la transcripción |
| `popup.js/html/css` | Panel: grabar/parar (también sin clave: la puerta es `puedeGrabar`), pausar, marcar, participantes, historial, reintentar, diagnóstico |
| `reuniones.js/html/css` | Biblioteca: buscar, leer con tiempos, renombrar hablantes, exportar, actas con plantillas, preguntar, notas, escuchar (el audio conservado y el pendiente de transcribir) |
| `vivo.js/html/css` | Panel lateral en vivo: texto que llega, niveles, pausa, marcadores y notas |
| `proveedores.js` | Registro de proveedores de IA (3.8): de cada uno, su API, su permiso de host, dónde vive su clave, sus modelos y qué sabe hacer (`chat`, `voz`), con **un interruptor por capacidad**. De aquí salen las tarjetas de Opciones, los desplegables y quién transcribe y quién redacta (`proveedorVoz`, `proveedorTexto`). También lee los errores de las APIs (`detalleErrorApi`, `sinSaldo`). Se carga después de `i18n.js` y antes de `config.js`, `comun.js` e `ia.js`, en todas partes. Sin DOM ni `chrome.*`. Ver «Proveedores de IA», más abajo |
| `ia.js` | Plantillas de acta, llamadas de acta y preguntas a quien diga el registro (Gemini, y los dialectos de Anthropic y de OpenAI) con reintentos, modelos de reserva y tokens. Sin DOM ni `chrome.*` |
| `exportar.js` | Word (.docx sin librerías), SRT, texto plano y markdown → HTML seguro |
| `options.js/html/css` | Configuración: valida la clave de Gemini y le elige modelo compatible, pinta desde el registro las tarjetas de «Claves de IA» y los precios, y pide permiso de micrófono |
| `config.js` | Dónde vive cada ajuste, la migración de las claves de `sync` a `local` y el guardado de la clave de un proveedor (`guardarClaveProveedor`: pide el permiso de host si es opcional y comprueba la clave antes de guardarla). Lo cargan el popup, las opciones, la biblioteca, la página de importar y el service worker (`importScripts`) |
| `tests/` | Suite en Node con el navegador simulado. `npm test` |

### Tests

```bash
npm test
```

No hay dependencias que instalar. La suite carga los ficheros reales de la
extensión con `vm.runInContext` y les inyecta stubs de `chrome`,
`MediaRecorder`, `AudioContext`, `FileReader` y `fetch` (`tests/stubs.js`). Los
almacenes simulados son asíncronos a propósito: es lo que hace que las carreras
de escritura se reproduzcan.

Los casos marcados **REGRESIÓN** cubren un fallo que llegó a estar en uso. Si
uno se pone rojo, ese fallo ha vuelto — no lo relajes, arregla el código.

### Proveedores de IA: el registro y sus interruptores (3.8)

`proveedores.js` es la única lista de proveedores de IA. Nadie más escribe sus nombres, sus direcciones ni sus modelos.

**Regla de publicación: solo se enseña lo probado con una clave real.** Sin ella no se puede garantizar que una API acepte el audio que manda Chrome, ni medir cómo transcribe. Por eso cada capacidad de cada proveedor lleva su interruptor: `voz.activo` (transcribir) y `chat.activo` (actas y preguntas). Una capacidad apagada **no existe para el usuario**: no sale en Opciones ni en ningún desplegable, `proveedorVoz` y `proveedorTexto` la saltan aunque tenga clave, `llamarIA` la rechaza sin tocar la red y no se pide su permiso de host. Nada pregunta al registro a pelo: todo pasa por `transcribe(id)` y `redacta(id)`.

Cómo sale la 3.8.0:

| id | `voz.activo` | `chat.activo` |
|---|---|---|
| `gemini` | encendido | encendido |
| `gpt` (OpenAI) | apagado | encendido |
| `claude` (Anthropic) | no tiene: su API no admite audio | encendido |
| `mistral`, `groq` | apagado | apagado |
| `deepseek`, `openrouter` | no tiene | apagado |

Lo apagado está escrito y lo cubre la suite con respuestas simuladas (cada test lo enciende en su propio contexto: `encender(ctx, "groq.voz")`), pero **nada de ello se ha probado con una clave real**. Por eso ni la ficha de la tienda, ni el README, ni la política de privacidad lo dan por disponible, y así debe seguir mientras esté apagado. Lo que se sabe de cada API, y lo que falta por comprobar, está en `docs/2026-10-05-plan-proveedores.md`.

**Para encender una capacidad:**

1. Con una clave real de ese proveedor, pon su interruptor a `true` en tu copia y, si su host no es `fijo`, añádelo a `optional_host_permissions` de `manifest.json`. Pasa `npm test` (caerán los tests que fijan el estado de salida: es lo esperado) y carga la extensión en Chrome.
2. Pruébala de punta a punta: guardar la clave en su tarjeta de «Claves de IA» (si su host no es `fijo`, Chrome enseña su diálogo de permiso; si no lo enseña y la tarjeta dice que falta el permiso, es que el host no está en el manifest), y después, según la capacidad, un acta y una pregunta, o una grabación de más de un tramo cuyo texto llegue a la biblioteca con sus marcas, con un rato de silencio en medio y en el idioma en que se vaya a usar.
3. Si va, deja el interruptor encendido y pon al día los tests que fijan el estado de salida (`tests/run.js`: «estado de salida», los de interruptores y los de permisos; `npm test` los nombra). Cambiarlos es decir que se ha probado con una clave de verdad.
4. Cuenta lo que el usuario ve ahora: `PRIVACY.md` (a quién va el audio y el texto; su host pasa a la lista de permisos opcionales), `STORE_LISTING.md` (descripción y justificación de los hosts), `README.md`, `LEEME.txt` y la descripción de `_locales` si deja de ser cierta.

Sobre el manifest: El host de un proveedor apagado no se declara, porque la tienda no admite pedir permisos para funciones que el usuario todavía no puede usar. `origenesProveedores()` da los que tocan (los de lo encendido), un test comprueba que manifest y registro coinciden y otro que todo host al que se llama está en el manifest. Declararlo como opcional no pide nada a nadie: el permiso se pide uno a uno, al guardar la clave.

Un proveedor nuevo nace apagado y necesita: su ficha en `PROVEEDORES` y su sitio en `ORDEN_VOZ` u `ORDEN_TEXTO`, sus campos en `CFG_LOCAL` (`config.js`, escritos a mano), sus textos de ayuda en los dos idiomas (`i18n.js`) y, si se quiere, sus precios en `PRECIOS_REFERENCIA`. Los tests del registro dicen lo que falte.

### Reglas del terreno (aprendidas a golpes)

- **En `offscreen.js` NO existe `chrome.storage` ni `chrome.downloads`.** Todo lo que necesite almacenamiento o descargas se pide al service worker por `chrome.runtime.sendMessage({target:"bg", ...})`.
- En `background.js`, descarta de forma **síncrona** los mensajes que no son suyos (`if (msg.target !== "bg") return false;`). Si devuelves `true` para mensajes ajenos, el canal se cierra sin respuesta y las órdenes mueren en silencio.
- El service worker **se duerme**: no guardes estado en variables globales, usa `chrome.storage.session`.
- Modelos de Gemini: no fijes uno a fuego. Las claves nuevas ya no pueden usar algunos modelos antiguos (404 "no longer available to new users"). `options.js` prueba varios y se queda con el que responda.
- La captura de pestaña falla en páginas `chrome://`, de la Web Store y de la propia extensión. `background.js` busca la pestaña que **esté sonando** (`tab.audible`).
- **El audio de un tramo se borra DESPUÉS de guardar su texto**, nunca antes: un fallo entre medias perdería las dos cosas.
- Un fallo de transcripción siempre lleva `codigo` (`comun.js`). Sin él no se sabe si reintentar con alarma o esperar a que el usuario cambie la clave, y el usuario recibe un mensaje falso.
- `comun.js` y `offscreen.js` se cargan como scripts clásicos en la misma página: una constante declarada en los dos es un `SyntaxError` que deja la extensión sin grabador. Lo compartido vive solo en `comun.js`. Lo mismo con `ui.js` y `exportar.js` en la biblioteca: por eso el escape de `ui.js` se llama `escapa` y no `escHtml`.
- **Un botón con `data-i18n` pierde lo que tenga dentro al traducirse** (`textContent`). Si lleva icono, el `data-i18n` va en un `<span>` interior.
- **Los textos de la interfaz no empiezan por emoji** (lo comprueba la suite): el icono va en el HTML o lo pone `ponAviso`/`ponEstado` según el tipo de aviso.
- En un manejador `async`, guarda `ev.currentTarget` **antes** del primer `await`: después vale `null`.
- **Un host nuevo va en `optional_host_permissions`, nunca en `host_permissions`.** Añadirlo a los fijos puede dejar la extensión desactivada al actualizarse, hasta que cada usuario acepte el permiso nuevo. Los opcionales no.
- `chrome.permissions.request` exige un gesto del usuario: se llama en el clic y es el **primer** `await` del manejador (`config.js`: `guardarClaveProveedor`). No se pide desde el popup, que se cierra con el diálogo de Chrome, y `chrome.permissions` no existe en el documento offscreen (el permiso concedido sí vale para sus `fetch`).
- **Sin clave no es un fallo.** Una reunión grabada sin clave queda `pendiente`, con `sin_clave` en sus tramos (`comun.js`: `sinTranscribir`), y la interfaz la enseña en neutro, no en rojo. No la trates como error ni la podes: su audio es lo único que hay.

## Depurar

- **Botón «Diagnóstico»** en el panel: comprueba la clave, la conexión con quien transcriba (hoy, Gemini) y el permiso de micro, graba 3 s de prueba y los transcribe. Sin clave lo dice y se salta la transcripción. Es la vía rápida cuando algo no va.
- Errores del grabador: `chrome://extensions` → tarjeta de la extensión → **Errores** / **Service worker** (consola).
- La transcripción y el audio siempre acaban en `Descargas/reuniones/`, incluso si algo falla.

## Publicar una versión

1. Sube el número en `manifest.json` **y en `package.json`**: el CI falla si no coinciden, y la Store rechaza versiones repetidas.
2. Zip con todo lo que carga Chrome: `manifest.json`, `_locales/`, `*.js` de la raíz, `*.html`, `*.css`, `iconos.svg`, `icon*.png`, `LEEME.txt` y `PRIVACY.md` (sin docs, ni tests, ni zips). **Ojo con `config.js`, `comun.js`, `proveedores.js`, `i18n.js`, `ui.js`, `estilo.css` e `iconos.svg`**: sin ellos la extensión no arranca o sale sin estilos ni iconos.
3. [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole) → el elemento → **Paquete** → subir → **Enviar a revisión**.

Textos de la ficha y justificación de permisos: `STORE_LISTING.md`. Política de privacidad: `PRIVACY.md`.

## Ideas pendientes

- Transcripción en vivo (por bloques de 1 min) mientras la reunión sigue.
- Plantillas de análisis: acta formal, correo de seguimiento, lista de tareas.
- Enviar el acta por correo con un clic.
- Webhooks: mandar el resultado a Odoo, Notion o Slack.
