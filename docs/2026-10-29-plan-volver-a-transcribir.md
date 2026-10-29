# Volver a transcribir una reunión (29/10/2026)

Petición de Álvaro: «si alguna transcripción deja de funcionar, ¿tiene un botón
para volver a transcribir directamente desde la extensión? Si no, créalo».

## Lo que hay hoy (comprobado en el código, main 1a948c4)

- **Si falla la transcripción**, la reunión queda «pendiente»: el audio de los
  tramos fallidos sigue en IndexedDB (`audios`), Escriba reintenta sola
  (1/5/15/60/180/720 min) y en «Más acciones» sale **«Reintentar ahora»**
  (`reuniones.js` `btnReintentar`, `background.js` `reintentar`). Ese caso ya está
  cubierto.
- **Si la transcripción acaba pero sale mal** (texto cortado, inventado, en otro
  idioma, un tramo vacío), no hay nada: el audio de cada tramo se borra en cuanto
  su texto se guarda. Solo se conserva si está activado «Conservar el audio» en
  Opciones (`conservarAudio`, **apagado por defecto**), en el almacén `escucha`.

## Qué se hace

Botón **«Volver a transcribir»** en «Más acciones» de la biblioteca. Manda otra vez
a la IA el audio conservado de la reunión y sustituye el texto de cada tramo.

- Solo sale si la reunión tiene audio conservado y no está grabándose ni
  transcribiéndose. Sin audio no hay nada que mandar: no se enseña.
- Pregunta antes: el texto se sustituye y las actas ya hechas no cambian.
- **No se pierde nada si falla**: cada tramo conserva su texto hasta que llega
  uno nuevo. Si la IA falla (sin cuota, sin red, clave mala) o no oye voz, el
  tramo se queda como estaba y la biblioteca avisa: «N trozos no se han podido
  volver a transcribir: motivo. Se queda el texto anterior».
- Los nombres puestos a los hablantes, las notas y las marcas se quedan.

### Cómo (sin un motor nuevo)

1. `background.js` `retranscribir(id)`: en la cola del historial marca con
   `rehacer: true` los tramos «ok» con audio en `escucha` y lanza la ronda de
   siempre.
2. `offscreen.js` `ronda`: además de los pendientes, coge los `rehacer`.
   `transcribirTramo` lee su audio de `escucha`. Si sale «ok» se guarda el texto
   nuevo; si no, se guarda solo `rehacer: false` y el motivo (`errorRehacer`), y el
   texto viejo sigue. Ese audio no se borra: es el conservado.
3. El cierre de ronda (`finRonda`) rehace el `.md` de Descargas como siempre.

Alternativa descartada: pasar los tramos a «pendiente» y reutilizar los
reintentos. Es menos código, pero si la IA falla (p. ej. la cuota gratuita de
Gemini agotada) el texto desaparece durante horas hasta que un reintento sale bien.

## Criterio de aceptación

1. Reunión transcrita con audio conservado: el botón sale, pregunta, y al
   confirmar el texto pasa a ser el nuevo, el `.md` se rehace y el audio sigue.
2. Con la IA fallando: el texto anterior se queda entero y sale el aviso con el motivo.
3. Sin audio conservado, grabando o transcribiendo: el botón no sale.
4. Suite en verde con tests nuevos que fallan sin el cambio.
5. En pantalla: extensión cargada en el Chromium de Playwright, una reunión real
   con audio, pulsar el botón y ver el texto nuevo.

## Lo que queda fuera

- Que «Conservar el audio» venga encendido por defecto. Sin eso, en las reuniones
  de quien no lo ha tocado el botón no sale. Lo decide Álvaro: ocupa disco
  (unos 30 MB por hora de reunión en webm/opus).
