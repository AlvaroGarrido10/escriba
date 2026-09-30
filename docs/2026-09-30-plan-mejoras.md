# Plan de mejoras de Escriba (30/09/2026)

Objetivo que ha puesto Álvaro: que Escriba sea la mejor extensión de su categoría.

## 1. Punto de partida: dónde está Escriba frente a la competencia

Hemos comparado la versión 3.1.1 con Transkriptor, Tactiq, tl;dv, Fireflies, Otter, Bluedot y Notta. Las fuentes son sus fichas de la Chrome Web Store (leídas el 30/09), sus páginas de precios y funciones, 130 reseñas de la tienda y el código de Transkriptor 3.0.6.

**Escriba ya gana en lo que más castiga a los demás:**

| Queja repetida en la competencia | Escriba 3.1.1 |
|---|---|
| Muro de pago: no deja ni descargar el texto en el plan gratis (6 de las 8 reseñas de 1★ de Transkriptor) | Gratis. Cada usuario pone su propia clave (BYOK), y la capa gratuita de Gemini cubre el uso diario |
| «Lo perdí todo», «stuck at 100 %», «no audio detected» | El audio de cada tramo queda en IndexedDB hasta que su texto está guardado. Reintentos automáticos, recuperación si se cierra Chrome y guardia de silencio |
| El audio se sube a sus servidores; la analítica va a EE. UU. aunque la ficha dice «no recoge datos» | Sin servidor: el audio va del navegador al proveedor que elige el usuario |
| El vocabulario propio solo en el plan de 30 $/puesto | Glosario gratis |

**Dónde pierde hoy.** Es todo lo que viene después de grabar:

| Lo tienen los líderes | Escriba 3.1.1 |
|---|---|
| Visor cómodo con búsqueda en la reunión y entre reuniones | Un cuadro de texto de 150 px dentro del popup |
| Marcas de tiempo | No |
| Hablantes con nombre real, que se renombran una vez y se aplica en todo el texto | «Hablante 1, 2…», sin renombrar |
| Plantillas de acta (Transkriptor tiene 9 y personalizadas) | Un único prompt de acta |
| Preguntar a la reunión | No |
| Exportar a Word, PDF, TXT y SRT | Solo .md |
| Texto en directo o casi (el rasgo de Tactiq y Otter; en Transkriptor lo echan de menos) | Solo al parar |
| Pausa, marcadores y notas durante la reunión | No |
| Aviso inmediato si no entra audio | Solo al terminar |
| Arranque con atajo de teclado | No |
| Idiomas y mezcla de idiomas | Solo español |
| Captura del audio del sistema (Teams de escritorio, que es lo habitual en España) | Se quitó en la 3.1.1 porque el documento offscreen no puede usar `desktopCapture` |

## 2. Plan por tandas

Cada tanda es una versión. Dentro de cada tanda: primero las pruebas en rojo, luego el código, la suite completa y la comprobación en pantalla en Chromium con la extensión cargada. Al final de la tanda, Álvaro recarga la extensión en su Chrome.

### Tanda A — 3.2.0: sacar partido a la reunión grabada

**A1. Biblioteca de reuniones** (página nueva `reuniones.html`)
- Qué es: una página completa en lugar del cuadro del popup.
  - Lista con búsqueda por título y texto en todas las reuniones.
  - Visor con formato: marca de tiempo, hablante en color y texto.
  - Búsqueda dentro de la reunión, con las coincidencias resaltadas.
  - Título y participantes editables.
- El popup se queda para grabar. «Ver» abre la biblioteca en esa reunión.
- Alternativas descartadas:
  - Ampliar el popup: Chrome lo limita a 800×600.
  - Panel lateral: sirve para la reunión en curso (tanda B), no para leer.
- Aceptación: con 30 reuniones, la búsqueda filtra al escribir. Abrir una reunión de 2 horas no se bloquea. El título editado se ve en el popup.

**A2. Marcas de tiempo**
- Qué es: el prompt pide `[MM:SS]` al principio de cada intervención, relativo al tramo. Escriba lo convierte a tiempo de la reunión sumando el inicio del tramo, que ahora se guarda en cada tramo.
- Alternativa descartada: calcularlo por palabras. Sin audio de referencia no es fiable.
- Aceptación:
  - Una intervención del minuto 2 del tercer tramo sale como `[12:xx]`.
  - Las transcripciones antiguas, sin marcas, se ven igual que antes.

**A3. Hablantes con nombre**
- Participantes (opcional, al grabar o al importar): van al prompt con esta instrucción: usar el nombre solo si se presenta o se le nombra claramente; si hay duda, «Hablante N».
- Renombrar: en la biblioteca se pulsa «Hablante 2» → «Marcos». Se guarda un mapa por reunión y se aplica al ver, al exportar y al rehacer el .md.
- El texto original no se toca, así que el cambio se puede deshacer.
- Aceptación: renombrar cambia todas las intervenciones de ese hablante, y solo las etiquetas de inicio de línea, no la palabra dentro del texto.

**A4. Idioma**
- En Opciones: «Español» (por defecto, como ahora), «Detectar automáticamente (respeta mezclas)», «English», «Català», «Português», «Français», «Deutsch», «Italiano».
- Aceptación: en automático, el prompt no fuerza el español.

**A5. Acta con plantillas, y preguntar a la reunión**
- Plantillas: acta completa (la actual), resumen breve, tareas con responsable y fecha, correo de seguimiento listo para enviar, y una personalizada que se edita en Opciones.
- Todas reciben los participantes, el glosario y, desde la tanda B, las notas y los marcadores.
- «Preguntar»: una conversación sobre la transcripción con el proveedor elegido, guardada en la reunión.
- La lógica de IA sale del popup a `ia.js`, que la comparten el popup, la biblioteca y el documento offscreen.
- Aceptación:
  - Cada plantilla se guarda aparte («Tareas · Claude» no pisa «Acta · Gemini»).
  - Las actas de versiones anteriores siguen visibles.
  - Un 503 se reintenta con aviso.

**A6. Acta automática** (opcional, en Opciones)
- Qué es: al terminar una transcripción completa, se genera sola con la plantilla y el proveedor elegidos.
- Se hace en el documento offscreen, no en el service worker, porque Chrome puede parar el service worker a mitad de una llamada larga.
- Aceptación:
  - Apagada: no se hace ninguna llamada.
  - Encendida: una sola llamada.
  - Una reunión incompleta no la dispara.

**A7. Exportar**
- Formatos: Markdown, texto, Word (.docx de verdad, generado sin librerías), subtítulos SRT (si hay marcas de tiempo) y PDF (imprimir desde la biblioteca).
- «Copiar para correo»: copia el acta con formato, para pegarla en Outlook o Teams.
- Aceptación:
  - El .docx pasa la validación de zip y abre en Word.
  - El SRT tiene tiempos crecientes.
  - Los hablantes renombrados salen renombrados.

**A8. Uso**
- Qué es: se guardan los tokens que devuelve cada llamada (entrada y salida) por reunión, y la biblioteca los enseña.
- Es la base del coste estimado (tanda C).
- Aceptación: una reunión transcrita muestra los tokens de transcripción y los de cada acta.

### Tanda B — 3.3.0: grabar mejor

- **B1. Transcribir durante la grabación.**
  - Cada tramo se transcribe en cuanto se cierra, sin esperar a parar. Al parar solo queda el último, así que el resultado llega en segundos y no en minutos.
  - El cierre de la reunión (.md, estado final, reintentos) sigue haciéndose una sola vez, al final.
- **B2. Panel lateral en vivo:** texto que va llegando, nivel de cada fuente, cronómetro, marcadores y notas.
- **B3. Pausa y reanudar.** Las marcas de tiempo descuentan la pausa.
- **B4. Marcadores y notas.** «⭐ Marcar» guarda el minuto con una nota opcional. Van al .md, al visor y al prompt del acta («presta atención a estos momentos»).
- **B5. Aviso de silencio en vivo.** Si durante 2 minutos no entra voz por ninguna fuente, aparece la insignia «!» y una notificación de Chrome.
- **B6. Atajo de teclado** para empezar y parar (Alt+Shift+R, cambiable en `chrome://extensions/shortcuts`).
- **B7. Recordatorio de avisar a los asistentes** al empezar a grabar (RGPD). Se puede ocultar.

### Tanda C — 3.4.0: más allá

- **C1. Audio del sistema.** Una ventana pequeña de la extensión que graba el escritorio completo con micro. Es la vía para Teams de escritorio.
- **C2. Reproductor sincronizado:** pulsar una frase y oír ese momento. Exige conservar el audio (opcional, con borrado automático configurable).
- **C3. Coste estimado por reunión**, a partir de los tokens de A8 y el precio del modelo que ponga el usuario.
- **C4. Modelos de OpenAI y Anthropic** leídos de sus APIs con la clave del usuario, en vez de escribirlos a mano.
- **C5. Aviso al detectar una reunión** de Meet o Teams (permiso opcional; se pide solo si el usuario lo activa).
- **C6. Interfaz en inglés**, necesaria para publicar fuera de España.

## 3. Lo que NO se hace, y por qué

- **Bot que entra en la reunión:** necesita un servidor, y Escriba es sin servidor.
- **Integraciones con Notion, Slack o CRM por OAuth:** también necesitan un servidor. En su lugar, exportar y «copiar para correo».
- **Leer los subtítulos de Meet** (lo que hace Tactiq): exige inyectar código en Meet con permiso de lectura de la página. Con B1 el texto llega casi en directo sin pedir ese permiso.

## 4. Cómo se prueba

- **Suite en Node:** cada punto entra con su prueba en rojo primero. Se cuentan las pruebas antes y después (hoy: 57).
- **Pantalla:** Chromium de Playwright con la extensión cargada (método de la 3.1).
  - Historial sembrado con reuniones reales anonimizadas.
  - Capturas de la biblioteca, el renombrado, la exportación y las plantillas.
  - La IA simulada en la página para no gastar cuota.
- **Regresión:** las 57 pruebas actuales siguen en verde, y las reuniones de la 3.1 se abren en la biblioteca.
- **Cierre de cada tanda:** Álvaro recarga la extensión en su Chrome y graba una reunión de verdad.

## 5. Estado al cerrar el 30/09/2026

| Punto | Estado | Cómo se ha comprobado |
|---|---|---|
| A1 Biblioteca | Hecho | En pantalla: lista, búsqueda global sin tildes, búsqueda dentro de la reunión |
| A2 Marcas de tiempo | Hecho | Suite; en pantalla, el tramo 2 sale con tiempo de reunión (05:12) |
| A3 Hablantes con nombre | Hecho | Suite; en pantalla, renombrar cambia todas las intervenciones y rehace el .md |
| A4 Idioma | Hecho | Suite (prompt); en pantalla, el selector de Opciones |
| A5 Plantillas y preguntar | Hecho | Suite (las tres APIs); en pantalla con IA simulada |
| A6 Acta automática | Hecho | Suite: una sola llamada, ninguna si está apagada o la reunión está incompleta |
| A7 Exportar | Hecho | El .docx pasa `zipfile.testzip` y lo abre python-docx; SRT con nombres |
| A8 Uso | Hecho | Tokens de transcripción y de actas en la cabecera de la reunión |
| B1 Transcribir mientras se graba | Hecho | Suite: lo transcrito en vivo no se repite al parar ni se pierde al recuperar |
| B2 Panel en vivo | Hecho | En pantalla con grabación real (micro simulado) |
| B3 Pausa | Hecho | Suite con reloj simulado; en pantalla, el reloj se para |
| B4 Marcadores y notas | Hecho | Suite y pantalla; salen en el .md y en el prompt del acta |
| B5 Aviso de silencio | Hecho | Suite (aviso, sin repetir, se quita con la voz, no en pausa) |
| B6 Atajo de teclado | Hecho | Suite (empieza con el último modo, para al repetir) |
| B7 Recordatorio RGPD | Hecho | En pantalla, con «No volver a mostrar» |
| C2 Escuchar la reunión | Hecho (opcional, apagado) | Suite (se conserva, se borra con la reunión, la poda y el arranque); en pantalla suena desde la frase |
| C4 Modelos de OpenAI y Anthropic | Hecho | Sin probar contra las APIs reales (no hay claves en este equipo) |
| C1 Audio del sistema (Teams de escritorio) | **No hecho: decisión de Álvaro** | Se quitó el 24/09 por decisión suya. Hace falta una ventana visible de la extensión que grabe; se hace si lo pide |
| C3 Coste en euros | No hecho | Se enseñan los tokens; los precios por modelo cambian y no se pueden fijar sin que el usuario los ponga |
| C5 Aviso al detectar una reunión | No hecho | Exige permiso de lectura de pestañas o de Meet/Teams; queda para cuando se decida publicar |
| C6 Interfaz en inglés | No hecho | Necesario solo para publicar fuera de España |

**Pendiente de verdad antes de dar la 3.4 por buena:** una reunión real con Gemini de verdad en el Chrome de Álvaro. Las pruebas han simulado la IA. Lo que falta medir es que el modelo respete el formato `[MM:SS] Hablante: texto` y que ponga nombres solo cuando se oyen.
