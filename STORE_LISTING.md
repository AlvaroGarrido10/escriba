# Textos para la ficha de Chrome Web Store (cuando toque publicar)

## Nombre
Escriba — Transcribe tus reuniones con IA

## Descripción corta (132 caracteres máx.)
Graba Meet/Teams o reuniones presenciales y obtén transcripción y actas con IA. Sin cuenta, sin suscripción: con tus claves API.

## Descripción larga
🎙️ Escriba graba tus reuniones desde Chrome y te da la transcripción completa al momento — y con un clic, el acta: resumen ejecutivo, decisiones, tareas y temas abiertos.

✅ SIN SUSCRIPCIÓN NI CUENTA
A diferencia de otros servicios, no hay planes de pago ni registro. Usas tu propia clave API gratuita de Google Gemini (y opcionalmente OpenAI o Anthropic para los análisis). Tu audio va directo de tu navegador a la IA que TÚ eliges — sin servidores intermedios.

✅ PARA TODO TIPO DE REUNIONES
• Online (Google Meet, Teams web…): graba el audio de la pestaña y tu micrófono a la vez.
• Presenciales: graba con el micrófono del portátil.

✅ TODO EN SEGUNDO PLANO
Pulsa grabar y sigue con tu reunión: la grabación continúa aunque cierres el panel. Al parar, la transcripción se genera sola, se guarda en tu historial y se descarga en Descargas/reuniones.

✅ NO SE PIERDE NADA
Si Google está saturado, se cae la red o la clave falla, la reunión no se pierde: el audio queda guardado en tu navegador y Escriba lo reintenta sola. Si Chrome se cierra a mitad de reunión, al volver recupera lo grabado.

✅ TAMBIÉN ARCHIVOS
¿Ya tienes la grabación? Arrastra un mp3, m4a, wav o mp4 y obtén la transcripción igual.

✅ TU BIBLIOTECA DE REUNIONES
Busca en todas tus reuniones, lee cada una con marcas de tiempo y cada voz en su color, pon nombre a cada hablante con un clic y exporta a Word, PDF, texto o subtítulos. Si quieres, escucha la reunión: pulsas una frase y suena ese momento.

✅ MIENTRAS GRABAS
Pausa, marca los momentos importantes, toma notas en el panel lateral y ve llegar el texto sin esperar al final. Si en dos minutos no entra voz, Escriba te avisa. Atajo de teclado para empezar y parar.

✅ ANÁLISIS CON 3 IAs
Saca el acta completa, un resumen breve, las tareas con responsable y plazo, el correo de seguimiento listo para enviar o tu propia plantilla, con Gemini, GPT o Claude. Y pregúntale a la reunión lo que necesites: responde citando el minuto. El acta puede generarse sola al terminar. La IA sabe que trabaja sobre una transcripción automática (varios hablantes, posibles errores) y usa tu glosario personalizado para escribir bien los nombres de tu empresa y proyectos.

✅ PRIVACIDAD REAL
Sin telemetría, sin analítica, sin cuentas. El desarrollador no ve ni puede ver tus datos. Código sin ofuscar.

## Categoría
Productividad / Herramientas

## Justificación de permisos (formulario de revisión)
- tabCapture: capturar el audio de la pestaña de la reunión cuando el usuario pulsa Grabar. Es la función principal.
- Micrófono (getUserMedia): grabar la voz del usuario en reuniones online y presenciales. Función principal.
- downloads: guardar la transcripción (.md) y el audio de respaldo en la carpeta de Descargas del usuario.
- storage / unlimitedStorage: configuración (claves API del usuario, glosario), historial local de transcripciones y audio pendiente de transcribir (IndexedDB local, se borra al transcribirse).
- alarms: reintentar automáticamente, pasados unos minutos, una transcripción que falló por saturación o falta de red.
- notifications: avisar al usuario si durante la grabación no entra voz en dos minutos.
- sidePanel: panel lateral «En vivo» que el usuario abre para ver el texto, los niveles y tomar notas.
- host_permissions (generativelanguage.googleapis.com, api.openai.com, api.anthropic.com): llamadas directas a las APIs de IA con las claves del propio usuario. No hay otros hosts.

## Pendiente antes de enviar
1. Cuenta de desarrollador Chrome Web Store (5 USD, una vez): https://chrome.google.com/webstore/devconsole
2. Publicar PRIVACY.md en una URL pública (GitHub Pages) y ponerla en la ficha.
3. 3-5 capturas de pantalla 1280×800 (popup grabando, historial, análisis).
4. ~~Glosario por defecto genérico~~ — hecho: viene vacío.
5. Probado en reuniones reales ≥1 semana.
