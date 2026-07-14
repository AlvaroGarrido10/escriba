# Textos para la ficha de Chrome Web Store (cuando toque publicar)

## Nombre
TranscriptorGod — Transcribe tus reuniones con IA

## Descripción corta (132 caracteres máx.)
Graba Meet/Teams o reuniones presenciales y obtén transcripción y actas con IA. Sin cuenta, sin suscripción: con tus claves API.

## Descripción larga
🎙️ TranscriptorGod graba tus reuniones desde Chrome y te da la transcripción completa al momento — y con un clic, el acta: resumen ejecutivo, decisiones, tareas y temas abiertos.

✅ SIN SUSCRIPCIÓN NI CUENTA
A diferencia de otros servicios, no hay planes de pago ni registro. Usas tu propia clave API gratuita de Google Gemini (y opcionalmente OpenAI o Anthropic para los análisis). Tu audio va directo de tu navegador a la IA que TÚ eliges — sin servidores intermedios.

✅ PARA TODO TIPO DE REUNIONES
• Online (Google Meet, Teams web…): graba el audio de la pestaña y tu micrófono a la vez.
• Presenciales: graba con el micrófono del portátil.

✅ TODO EN SEGUNDO PLANO
Pulsa grabar y sigue con tu reunión: la grabación continúa aunque cierres el panel. Al parar, la transcripción se genera sola, se guarda en tu historial y se descarga en Descargas/reuniones.

✅ ANÁLISIS CON 3 IAs
Analiza cualquier transcripción con Gemini, GPT o Claude: resumen ejecutivo, decisiones tomadas, tabla de tareas con responsables, temas abiertos y datos citados. La IA sabe que trabaja sobre una transcripción automática (varios hablantes, posibles errores) y usa tu glosario personalizado para escribir bien los nombres de tu empresa y proyectos.

✅ PRIVACIDAD REAL
Sin telemetría, sin analítica, sin cuentas. El desarrollador no ve ni puede ver tus datos. Código sin ofuscar.

## Categoría
Productividad / Herramientas

## Justificación de permisos (formulario de revisión)
- tabCapture: capturar el audio de la pestaña de la reunión cuando el usuario pulsa Grabar. Es la función principal.
- Micrófono (getUserMedia): grabar la voz del usuario en reuniones online y presenciales. Función principal.
- downloads: guardar la transcripción (.md) y el audio de respaldo en la carpeta de Descargas del usuario.
- storage: configuración (claves API del usuario, glosario) e historial local de transcripciones.
- host_permissions (generativelanguage.googleapis.com, api.openai.com, api.anthropic.com): llamadas directas a las APIs de IA con las claves del propio usuario. No hay otros hosts.

## Pendiente antes de enviar
1. Cuenta de desarrollador Chrome Web Store (5 USD, una vez): https://chrome.google.com/webstore/devconsole
2. Publicar PRIVACY.md en una URL pública (GitHub Pages / ditaytech.com) y ponerla en la ficha.
3. 3-5 capturas de pantalla 1280×800 (popup grabando, historial, análisis).
4. Quitar del glosario por defecto los términos internos de Ditay (dejar genérico) — el glosario del equipo se comparte aparte.
5. Probado en reuniones reales ≥1 semana.
