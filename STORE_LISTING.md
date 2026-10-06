# Ficha de Chrome Web Store (3.8.1)

Todo lo que pide el panel de desarrollador, en el orden en que lo pide. Lo marcado con **(tú)** solo puede hacerlo el titular de la cuenta.

## 0. Antes de nada (tú)

1. Entra en <https://chrome.google.com/webstore/devconsole> con la cuenta de Google con la que quieras publicar. El nombre de desarrollador y el correo de contacto salen en la ficha.
2. Ten activada la verificación en dos pasos en esa cuenta: el panel la exige.
3. Paga la cuota de registro: **5 $, una sola vez**.
4. Acepta el acuerdo de desarrollador.
5. Estado de comerciante: **No comerciante («Non-trader»)**. Escriba es gratis y no se cobra nada.

## 1. Paquete

- Fichero: `tienda/Escriba_3.8.1_chrome_web_store.zip`. Tiene `manifest.json` en la raíz, que es lo que exige la tienda.
- No uses `Escriba_*_para_instalar.zip`: lleva una carpeta dentro y la tienda lo rechaza.
- Panel: la primera vez, **Nuevo elemento** → subir el zip. Para una versión nueva: el elemento → **Paquete** → **Subir nuevo paquete**, y después **Enviar a revisión**.

## 2. Ficha de la tienda («Store listing»)

El idioma por defecto del manifest es **inglés** (`default_locale: en`), así que la ficha principal va en inglés. El español se añade como traducción. El nombre («Escriba») y la descripción corta salen del manifest (`_locales/*/messages.json`).

**Categoría:** Productivity → Tools (Productividad → Herramientas). **Idioma:** English, con traducción a Español.

### Descripción en inglés (por defecto)

```
Escriba records your meetings in Chrome and gives you the full transcript — and, with one click, the minutes: summary, decisions, tasks and open questions.

NO SUBSCRIPTION, NO ACCOUNT
There are no paid plans and no sign-up. You use your own free Google Gemini API key (and optionally OpenAI or Anthropic for minutes and questions). Your audio goes straight from your browser to the AI you choose — no servers in between.

NO KEY YET? RECORD ANYWAY
You can record without any API key. Escriba keeps the audio on your computer, sends nothing to anyone and lets you listen to it in the library. Add your Gemini key whenever you like and the meeting is transcribed on its own.

ANY KIND OF MEETING
• Online (Google Meet, Teams on the web, Zoom on the web…): records the tab audio and your microphone together.
• In person: records with your laptop microphone.
• Files: drop an mp3, m4a, wav or mp4 you already have.

WHILE YOU RECORD
See the level of each source in real time, pause, bookmark important moments, take notes in the side panel and watch the text arrive without waiting for the end. If no voice comes in for two minutes, Escriba tells you. Keyboard shortcut to start and stop.

NOTHING GETS LOST
If Google is busy, the network drops or the key fails, the meeting isn't lost: the audio stays in your browser and Escriba retries on its own. If Chrome closes mid-meeting, it recovers what was recorded.

YOUR MEETING LIBRARY
Search across all your meetings, read each one grouped by speaker with timestamps, name each voice with one click and export to Word, PDF, text or subtitles. Optionally, listen back: click a line and that moment plays.

MINUTES AND QUESTIONS WITH 3 AIs
Full minutes, short summary, tasks with owner and deadline, a ready-to-send follow-up email or your own template — with Gemini, GPT or Claude. Ask the meeting anything: it answers citing the minute. Minutes can be generated automatically when the transcript is ready.

REAL PRIVACY
No telemetry, no analytics, no accounts. The developer does not and cannot see your data. Unobfuscated, open-source code.

Interface in English and Spanish, with light and dark mode.
```

### Descripción en español (traducción)

```
Escriba graba tus reuniones desde Chrome y te da la transcripción completa — y con un clic, el acta: resumen, decisiones, tareas y temas abiertos.

SIN SUSCRIPCIÓN NI CUENTA
No hay planes de pago ni registro. Usas tu propia clave gratuita de Google Gemini (y, si quieres, OpenAI o Anthropic para actas y preguntas). Tu audio va directo de tu navegador a la IA que tú eliges, sin servidores intermedios.

¿AÚN SIN CLAVE? GRABA IGUAL
Puedes grabar sin ninguna clave de API. Escriba guarda el audio en tu equipo, no envía nada a nadie y te deja escucharlo desde la biblioteca. Pon tu clave de Gemini cuando quieras y la reunión se transcribe sola.

PARA TODO TIPO DE REUNIONES
• Online (Google Meet, Teams web, Zoom web…): graba el audio de la pestaña y tu micrófono a la vez.
• Presenciales: graba con el micrófono del portátil.
• Archivos: arrastra un mp3, m4a, wav o mp4 que ya tengas.

MIENTRAS GRABAS
Ves el nivel de cada fuente en tiempo real, pausas, marcas los momentos importantes, tomas notas en el panel lateral y ves llegar el texto sin esperar al final. Si en dos minutos no entra voz, Escriba te avisa. Atajo de teclado para empezar y parar.

NO SE PIERDE NADA
Si Google está saturado, se cae la red o la clave falla, la reunión no se pierde: el audio queda en tu navegador y Escriba lo reintenta sola. Si Chrome se cierra a mitad de reunión, recupera lo grabado.

TU BIBLIOTECA DE REUNIONES
Busca en todas tus reuniones, lee cada una agrupada por quién habla y con marcas de tiempo, pon nombre a cada voz con un clic y exporta a Word, PDF, texto o subtítulos. Si quieres, escúchala: pulsas una frase y suena ese momento.

ACTAS Y PREGUNTAS CON 3 IAs
Acta completa, resumen breve, tareas con responsable y plazo, correo de seguimiento listo para enviar o tu propia plantilla, con Gemini, GPT o Claude. Pregúntale a la reunión lo que quieras: responde citando el minuto. El acta puede generarse sola al terminar.

PRIVACIDAD DE VERDAD
Sin telemetría, sin analítica, sin cuentas. El desarrollador no ve ni puede ver tus datos. Código abierto y sin ofuscar.

Interfaz en español e inglés, con modo claro y oscuro.
```

### Imágenes

En `tienda/`, una serie por idioma (`en_*` para la ficha en inglés, `es_*` para la española):

| Campo | Fichero |
|---|---|
| Icono de la tienda (128×128) | `icon128.png`, en la raíz del repo |
| Capturas (1280×800, de 1 a 5) | `*_1_grabar.png`, `*_2_transcripcion.png`, `*_3_acta.png`, `*_4_preguntar.png` (en modo oscuro), `*_5_sin_clave.png` |
| Mosaico promocional pequeño (440×280) | `*_mosaico_440x280.png` |

Las capturas son de la extensión real (3.8.1) con datos de ejemplo, sacadas el 06/10/2026 en un Chromium sin ventana y sin red. En el panel, las `en_*` son las capturas globales (las ven también el catalán y el euskera, que no tienen propias) y las `es_*` son las localizadas del español. El mosaico no cambia.

### Enlaces

- **Sitio web:** <https://github.com/AlvaroGarrido10/escriba>
- **Asistencia:** <https://github.com/AlvaroGarrido10/escriba/issues>

## 3. Prácticas de privacidad («Privacy practices»)

**Finalidad única:**
```
Record meetings in Chrome (tab audio and/or microphone) and transcribe and summarize them with the AI provider and API key chosen by the user.
```

**Justificación de cada permiso:**

| Permiso | Justificación |
|---|---|
| `tabCapture` | Captures the audio of the meeting tab only when the user clicks Record (icon or keyboard shortcut) in the one-click «Quick» mode. Core feature. The default mode uses Chrome's own «Choose what to share» dialog (getDisplayMedia), which needs no manifest permission; only the audio is used and the picture is discarded at once. |
| `activeTab` | Identifies the tab the user is on when they start recording, so the right tab is captured and its title is shown. |
| `offscreen` | Recording runs in an offscreen document so it keeps going when the popup closes. Chrome requires one to use MediaRecorder from an extension. |
| `downloads` | Saves the transcript (.md) and, when a segment fails or the user records without an API key, its backup audio to the user's Downloads/reuniones folder. |
| `storage` | Saves the settings (the user's own API keys, glossary, language) and the local meeting history. |
| `unlimitedStorage` | Keeps the audio of segments not yet transcribed (and, if the user turns it on, the audio to listen back) in the extension's local IndexedDB, so long meetings are not lost. |
| `alarms` | Retries automatically, after a few minutes, a transcription that failed because the AI service was busy or the network was down. |
| `notifications` | Warns the user if no voice has come in for two minutes while recording and, only if the user turns it on, reminds them to record when they join a meeting. |
| `sidePanel` | The «Live» side panel, which the user opens to see the incoming text, the audio levels and take notes. |
| Permisos de host (`generativelanguage.googleapis.com`, `api.openai.com`, `api.anthropic.com`) | Direct calls to the AI APIs with the user's own keys, to transcribe and to create minutes. No other host is granted at install. |
| Permisos de host opcionales (Meet, Teams, Zoom, kMeet, Jitsi) | Only if the user turns on «Alert when you join a meeting». They are requested at that moment and removed when it is turned off. Only the tab address is checked; page content is never read. |

**Código remoto:** No, no uso código remoto. Todo el JavaScript va en el paquete.

**Uso de datos.** Marcar:
- **«Personal communications» (comunicaciones personales):** el audio y la transcripción de la reunión. Se envían al proveedor de IA que elige el usuario, con su clave, y solo para transcribir y resumir.
- **«Website content» (contenido de sitios web):** el audio de la pestaña que se graba.

Nada más: ni datos de identificación, ni historial de navegación, ni ubicación, ni actividad.

Y las tres certificaciones, marcadas:
- No vendo ni transfiero datos a terceros fuera de los casos de uso aprobados.
- No uso ni transfiero datos para fines ajenos a la finalidad única del elemento.
- No uso ni transfiero datos para determinar la solvencia crediticia ni para préstamos.

**Política de privacidad:**
```
https://github.com/AlvaroGarrido10/escriba/blob/main/PRIVACY.md
```

## 4. Distribución

- **Visibilidad:** Pública. Si prefieres una primera vuelta solo con el enlace, elige «No listado».
- **Regiones:** todas.
- **Precio:** gratis.

Después: **Enviar a revisión**. La primera revisión suele tardar unos días. Las extensiones con `tabCapture` y permisos de host pueden tardar más.
