# Plan: interfaz nueva de Escriba (3.6.0)

Petición de Álvaro, 02/10/2026: «mejora la interfaz completa de Escriba a muerte».

Alcance: las cinco pantallas, que son el popup, la biblioteca, el panel en vivo, Opciones e Importar. **No se toca el motor**, es decir, `background.js`, `offscreen.js`, la grabación, la transcripción y el formato del historial. Tampoco se añaden funciones nuevas. Todo lo que hace hoy Escriba se sigue pudiendo hacer, con los mismos datos.

## 1. Diagnóstico

Las capturas son de la 3.5.2, sacadas en Chromium con datos de ejemplo. Están en el scratchpad de la sesión (`escriba/antes/`) y el script que las genera es `escriba/capturas.js`.

### Lo que falla en todas las pantallas

| Problema | Evidencia |
|---|---|
| **Emojis haciendo de iconos.** Cada sistema los pinta distinto. En Windows, 🗑 sale como un rectángulo estrecho que no se entiende y ✍️ y 🖨️ cambian de tamaño. | 119 de las 486 frases de `i18n.js` empiezan por un emoji: 42 del popup, 34 de la biblioteca, 17 de Opciones, 14 de Importar y 12 del panel en vivo. |
| **No hay modo oscuro.** Con Chrome o Windows en oscuro, todas las páginas salen blancas. | Ninguna hoja de estilos usa `prefers-color-scheme`. |
| **Cuatro hojas de estilo distintas** (popup, vivo, Opciones e Importar con un `<style>` propio, más `reuniones.css`). Repiten colores escritos a mano y tienen radios, tamaños y botones diferentes. | Hay unos 60 valores de color sueltos y tres estilos de botón. |
| **Letra demasiado pequeña.** Se usa 10,5 y 11 px en 35 sitios, 22 de ellos en el popup. | La nota «Puedes cerrar este panel…» va en `#999` sobre `#faf7f9`, con un contraste de 2,7:1. El mínimo de WCAG AA es 4,5:1. |
| **Sin foco visible al usar el teclado** y con botones que solo llevan un icono y ningún nombre accesible. | Por ejemplo, el botón 🗑 del historial no tiene `aria-label`. |

### Popup (`popup.png`, `popup_grabando.png`)

- **Lo enseña todo a la vez**, esté grabando o no: aviso del micro, modo, participantes, botón, un reloj a `00:00`, el estado, la nota de cierre, el aviso RGPD, Importar, Diagnóstico y el historial con un cuadro de texto abierto. Mide unos 1.050 px y Chrome corta los popups a 600, así que lo importante queda debajo.
- **Grabando** se siguen viendo el modo, los participantes (desactivados) y el aviso del micro, que ya no se pueden cambiar. Faltan en cambio los niveles de audio, que el service worker ya calcula (`niveles`) y que solo enseña el panel en vivo.
- El reloj marca `00:00` cuando no se graba.
- Cada reunión del historial lleva tres o cuatro botones iguales en fila. El de borrar está al lado del de abrir y pesa lo mismo que él.

### Biblioteca (`bib_texto.png`, `bib_acta.png`, `bib_preguntar.png`, `bib_estrecha.png`)

- La transcripción está bien, pero repite el nombre del hablante en cada línea aunque hable diez veces seguidas. Así no se ve dónde cambia de voz.
- Las notas y los momentos marcados ocupan 170 px **encima** del texto, que es lo que se viene a leer.
- La pestaña «Acta y resúmenes» es una fila de dos desplegables y un botón, con media pantalla vacía debajo. No dice qué hace cada plantilla.
- En «Preguntar», las sugerencias desaparecen después de la primera pregunta y el campo para escribir sube y baja según la conversación.
- Por debajo de unos 1.000 px de ancho, la lista sigue ocupando 320 px y el título de la reunión se corta («…presupuesto y mig»).
- La lista pone una etiqueta «lista» en todas las reuniones. Si lo normal lleva etiqueta, las que de verdad necesitan atención (pendiente, error) no destacan.

### Panel en vivo (`vivo_grabando.png`)

Funciona, pero son cinco bloques del mismo peso uno debajo de otro. El texto que va llegando, que es lo que más se mira, está al final y en un cuadro de un 42 % de alto. El «siguiente trozo llega en 02:23» es texto suelto, cuando se entendería mejor como una barra de progreso.

### Opciones (`opciones.png`)

Son 2.000 px de tarjetas en una columna, sin índice. Dice «dos pasos y listo» y luego vienen ocho apartados más. El **glosario**, que según su propia ayuda «mejora mucho la transcripción», está escondido en «Opciones avanzadas» junto a las claves de GPT y Claude.

### Importar (`importar.png`)

Está correcta, pero no lleva cabecera ni forma de volver a la biblioteca. Además, la zona para soltar archivos no tiene icono.

## 2. Cómo se arregla

### 2.1 Sistema visual común (antes que nada)

- **`estilo.css`**, una sola hoja para las cinco páginas:
  - **Tokens**: colores en claro y en oscuro, espaciado en múltiplos de 4 px, radios, sombras y tipografía.
  - **Componentes**: botón principal, secundario, fantasma, de peligro y de solo icono; campo; desplegable; tarjeta; aviso de información, éxito, atención y error; píldora de estado; chip; pestañas; control segmentado; menú; aviso flotante (*toast*); estado vacío; esqueleto de carga; barra de nivel.
  - Foco visible con `:focus-visible` y respeto a `prefers-reduced-motion`.
  - Cada página conserva solo lo suyo propio: `popup.css`, `reuniones.css` y las demás.
- **Identidad**: se mantiene el granate del logo (`#5d2a42`) como color principal y se toma el coral del degradado como acento. En oscuro, el fondo pasa a ser granate casi negro y no gris.
- **Iconos**: un sprite SVG propio (`iconos.svg`) con trazo de 1,75 px en vez de emojis. En el HTML van como `<svg class="i"><use href="iconos.svg#grabar"/></svg>` y desde JS con `icono("grabar")`. Los dibujos parten de Lucide (licencia ISC, que se cita en el propio fichero).
- **Tipografía**: la del sistema (`Segoe UI Variable`, `system-ui`). **Sin fuentes de Google**, porque la ficha de la tienda promete que Escriba no habla con ningún servidor salvo el proveedor de IA. El texto mide como mínimo 12 px y el de leer, 15.
- **Tema**: nuevo ajuste «Apariencia: Automático / Claro / Oscuro» (`tema` en `storage.sync`). Se aplica antes de pintar, a partir de una copia en `localStorage`, para que no haya un fogonazo blanco.
- **Textos**: los botones, las pestañas, los títulos y los menús pierden el emoji del principio, porque el icono va en el HTML. Los avisos que ya llevan icono por su tipo también lo pierden. Las claves de `i18n.js` no cambian de nombre, solo su texto en es y en.

Alternativas descartadas:
- **Una librería de componentes o Tailwind**: obligaría a añadir un paso de compilación a una extensión que no tiene ninguno, y con la CSP de MV3 no se pueden usar CDN.
- **Dejar los emojis**: son justo lo que hace que la interfaz parezca de aficionado en Windows.

### 2.2 Popup: tres estados, uno cada vez

| Estado | Qué se ve |
|---|---|
| **Sin configurar** | Una tarjeta «Configura Escriba en un minuto» con el botón a Opciones, y el historial debajo si lo hay. |
| **Listo para grabar** | Modo con control segmentado (Pestaña + micro / Solo micro). Tarjeta de lo que se va a grabar: título de la pestaña y si suena o no. Participantes. Botón grande «Empezar a grabar» y debajo el atajo. Si no hay permiso del micro, una línea ámbar con «Autorizar». El aviso RGPD en una línea con ✕. **Sin reloj.** |
| **Grabando** | Reloj grande con un punto rojo que late y el nombre de lo que se graba. **Niveles de pestaña y micro en vivo**, con la misma orden `niveles` que usa el panel. Pausar, Marcar y Panel en vivo como botones de icono con texto. «Parar y transcribir» grande. El enlace «¿No oyes la reunión?». Los participantes, como texto. |
| **Transcribiendo** | Una barra de progreso por tramos («2 de 3»). |

**Recientes**: filas compactas con título, hora · duración y una píldora **solo** si está pendiente, con error o transcribiéndose. La última reunión sale abierta con su texto y los botones «Copiar» y «Abrir», como pidió Álvaro el 02/10 («sin irme a otra ventana»). Las demás se abren con un clic. Borrar y Reintentar pasan a un menú «⋯» de cada fila, con la misma confirmación de ahora.

**Pie**: Transcribir un archivo · Diagnóstico · Borrar todo, como enlaces discretos.

Criterio de aceptación: en «Listo para grabar», con tres reuniones en el historial, todo lo de grabar cabe en los 600 px de alto de Chrome sin hacer scroll.

### 2.3 Biblioteca

- **Lista**:
  - Agrupada por día (Hoy, Ayer, Esta semana, y después por mes).
  - Cada fila lleva título, hora, duración y un icono de origen (grabación o archivo).
  - Las píldoras solo salen en los estados que piden atención.
  - El coste del mes va al pie de la lista.
- **Cabecera de la reunión**:
  - Título editable, con un lápiz al pasar el ratón.
  - Datos de la reunión con iconos.
  - Participantes.
  - Barra con Copiar, Exportar ▾ y un menú «⋯» con Reintentar y Borrar.
- **Pestañas pegadas arriba** al hacer scroll.
- **Transcripción**:
  - Las intervenciones seguidas de la misma voz se agrupan bajo un solo encabezado, con el círculo de color, la inicial, el nombre y la hora.
  - Cada línea conserva su marca de tiempo, que se puede pulsar para escuchar como ahora.
  - Ancho de lectura de unos 760 px.
  - La búsqueda dentro de la reunión queda pegada arriba, con botones de anterior y siguiente y el número de coincidencias. Hoy solo funciona con Intro y Mayús+Intro.
- **Columna derecha** a partir de 1.200 px de ancho, con hablantes (para renombrar), momentos marcados y notas. Por debajo de ese ancho se convierte en un bloque plegable encima del texto.
- **Acta y resúmenes**:
  - Si aún no hay ninguna, se ven las plantillas como tarjetas con lo que saca cada una y un botón «Generar» con el proveedor al lado.
  - Si ya hay alguna, se ve el documento con una tipografía cuidada y sus versiones como chips.
  - Mientras se genera, un esqueleto de carga.
- **Preguntar**:
  - El campo para escribir queda fijo abajo.
  - Las sugerencias siempre visibles como chips.
  - Mientras responde, una burbuja «pensando».
- **Por debajo de unos 1.000 px**, la lista se esconde detrás de un botón «Reuniones» en la barra superior y la reunión ocupa todo el ancho.
- **Reproductor**: la barra de abajo, más limpia, sin cambiar lo que hace.

### 2.4 Panel en vivo

- La cabecera lleva una píldora de estado: grabando, en pausa o sin grabación.
- Reloj grande con una barra de progreso del tramo y el texto «el siguiente texto llega en 02:23».
- Niveles con icono y con color según la señal: muda, baja o buena.
- Pausar y Parar.
- «Marcar» con su nota, en una sola línea.
- Notas plegables.
- **El texto que va llegando ocupa el resto del alto**, agrupado por voz, y baja solo. Si el usuario ha subido a leer, aparece un botón «Ir al final».
- Sin grabación, un estado vacío con el atajo y la última reunión.

### 2.5 Opciones

- **Dos columnas**: índice fijo a la izquierda y apartados a la derecha. Por debajo de 900 px, una sola columna.
- **Arriba, una tarjeta de estado**: «Escriba está listo», o lo que falta (clave ✓/✗, micro ✓/✗) con su botón.
- **Apartados**:
  - **Empezar**: clave de Gemini, con botón para mostrarla u ocultarla, y micrófono.
  - **Transcripción**: idioma de las reuniones y **glosario**, que sale de «avanzadas».
  - **Actas e IA**: acta automática, mi plantilla y las claves y modelos de GPT y Claude.
  - **Audio**: conservar el audio, el espacio ocupado y el sonido de la pestaña.
  - **Avisos**: aviso al entrar en una reunión y el atajo.
  - **Coste**: la tabla de precios.
  - **Almacenamiento**: cuántas transcripciones conservar.
  - **Apariencia**: idioma de la interfaz y tema, que es nuevo.
- Se sigue guardando todo solo, sin botón de guardar. Los mensajes de estado de cada apartado (`pinta()`) siguen donde están, ya con el estilo nuevo.

### 2.6 Importar

- Cabecera común con enlace a la biblioteca.
- Zona para soltar archivos con icono y los formatos como chips.
- Lista de archivos con icono y tamaño.
- El progreso, por pasos: leer, preparar y transcribir.
- El resultado, con los mismos botones de ahora.

## 3. Lo que no cambia

- **Todos los `id` que usa el JS.** Si alguno tiene que moverse de sitio en el HTML, se mueve con su `id`.
- La lógica de cada pantalla: mensajes al service worker, el historial solo lo escribe el service worker y las confirmaciones de borrado se mantienen.
- `background.js`, `offscreen.js`, `comun.js`, `ia.js` y `exportar.js`.
- Exportar a PDF imprimiendo. La hoja de impresión fuerza el tema claro.
- Los permisos del manifest.

## 4. Riesgos y cómo se controlan

| Riesgo | Control |
|---|---|
| `<use href="iconos.svg#x">` puede no resolverse en una página de extensión. | Se prueba lo primero, en Chromium. Si falla, el sprite se mete en la página desde `iconos.js`. |
| Que el popup no quepa en 600 px. | Se comprueba con una captura a 360×600 en cada estado. |
| Que un `id` movido rompa un manejador sin que falle ningún test. | Prueba de pantalla de cada botón (apartado 5.3), no solo la suite. |
| Contraste en modo oscuro. | Test automático de contraste entre los tokens (apartado 5.1). |
| Que el tema guardado tarde y haya un fogonazo blanco. | Copia en `localStorage`, que se lee sin esperar, antes de pintar. |

## 5. Verificación y criterios de cierre

1. **Suite.** Sigue en verde (hoy 140 tests), más estos, que se escriben primero y en rojo:
   - Las cinco páginas cargan `estilo.css`, y `i18n.js` sigue siendo el primer script.
   - Todo `#icono` usado en HTML o JS existe en `iconos.svg`.
   - Ningún botón, pestaña ni título del HTML empieza por un emoji.
   - Claro y oscuro definen los mismos tokens.
   - **Contraste WCAG ≥ 4,5:1** de cada pareja texto/fondo de los tokens, en los dos temas, calculado en Node.
2. **Capturas antes y después.** Cada pantalla y estado, en es y en, en claro y en oscuro: popup a 360 px, biblioteca a 1.440, 1.024 y 800 px, panel a 380 px, Opciones e Importar. Las reviso una a una.
3. **Prueba de pantalla en Chromium con la extensión cargada** (micro simulado y Gemini simulado en el offscreen):
   - Grabar en «Solo micro», pausar, marcar, parar, ver la transcripción en el popup y copiarla.
   - En la biblioteca: buscar, renombrar un hablante, exportar Word y SRT, generar un acta, preguntar, borrar y escuchar.
   - En Opciones: la clave, el tema y el idioma.
   - Importar un WAV.
4. **Chrome 154 de marca, con perfil aparte y clic real en el icono** (el banco del 01/10): grabar una pestaña de verdad con el diseño nuevo.
5. **Cierre**: Álvaro recarga la extensión (↻) en su Chrome y la ve. Hasta entonces, el estado es PARCIAL.

Entrega: versión **3.6.0** en manifest y package, y `Escriba_3.6.0_para_instalar.zip`. El commit y la subida a GitHub, solo cuando él lo diga.

## 6. Estado (02/10/2026, tarde)

Hecho todo el apartado 2, en la versión 3.6.0. Sin commit.

**Verificación:**

| Nivel | Resultado |
|---|---|
| Suite | 149 tests en verde: los 140 de antes y 9 nuevos. Los 9 nuevos se escribieron después del código, así que se comprobaron de otra forma: contra la 3.5.2 fallan los 9, y en una copia con un icono inexistente y un gris sin contraste saltan los dos tests correspondientes. |
| Capturas | Las cinco pantallas, en español e inglés, en claro y en oscuro: popup a 380 px; biblioteca a 1.440, 1.100, 820 y 420 px; panel a 380 px; Opciones a 1.280 y 700 px; Importar. |
| Prueba de pantalla en Chromium | 79 de 79 comprobaciones. Micro simulado con voz y Gemini simulado dentro del documento offscreen y de la biblioteca. Cubre: grabar en «Solo micro», pausar, marcar, el panel en vivo (marca con nota y notas), parar, ver y copiar el texto en el popup, el menú «⋯», el diagnóstico, renombrar una voz, buscar con flechas, ir a un momento, exportar .md y .srt, generar un acta desde una tarjeta, preguntar, el cajón en pantalla estrecha, importar un WAV, el tema y el idioma en vivo, y borrar. |
| Chrome 154 de marca | Perfil aparte. El popup abierto con `openPopup()` en su marco real mide 390×600 y el botón de grabar termina a 359 px. La biblioteca, Opciones y el panel cargan sin errores en claro y en oscuro. |
| Zip | Se descomprimió y se cargó limpio en Chromium: estilos e iconos presentes, sin errores. |

**Fallos que salieron al probar y ya están arreglados:**
- En el popup, «Copiar» leía el botón después de esperar al portapapeles. Para entonces `ev.currentTarget` ya vale `null` y el botón no confirmaba la copia.
- En el popup, tras una grabación real, el texto enseñaba la cabecera del .md (`# Transcripción…`, `**Origen:**`). Ahora se lee solo lo hablado y «Copiar» sigue copiando el .md completo.
- `ui.js` y `exportar.js` declaraban los dos `escHtml`, y eso es un `SyntaxError` en la biblioteca. El de `ui.js` pasa a llamarse `escapa`.
- En oscuro había dos parejas por debajo de 4,5:1 (el rojo de parar al pasar el ratón y el resaltado de la búsqueda). Las detectó el test de contraste.

**Sin hacer:**
- No se ha grabado una pestaña real con un clic real en el icono, porque el motor no se ha tocado: es el mismo que se verificó en la 3.5.x.
- Falta que Álvaro recargue la extensión en su Chrome y la vea.
