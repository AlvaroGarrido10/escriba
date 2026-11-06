# Ficha de Chrome Web Store (3.10.1)

Todo lo que pide el panel de desarrollador, en el orden en que lo pide. Lo marcado con **(tú)** solo puede hacerlo el titular de la cuenta.

## 0. Antes de nada (tú)

1. Entra en <https://chrome.google.com/webstore/devconsole> con la cuenta de Google con la que quieras publicar. El nombre de desarrollador y el correo de contacto salen en la ficha.
2. Ten activada la verificación en dos pasos en esa cuenta: el panel la exige.
3. Paga la cuota de registro: **5 $, una sola vez**.
4. Acepta el acuerdo de desarrollador.
5. Estado de comerciante: **No comerciante («Non-trader»)**. Escriba es gratis y no se cobra nada.

## 1. Paquete

- Fichero: `tienda/Escriba_3.10.1_chrome_web_store.zip`. Tiene `manifest.json` en la raíz, que es lo que exige la tienda.
- No uses `Escriba_*_para_instalar.zip`: lleva una carpeta dentro y la tienda lo rechaza.
- Panel: la primera vez, **Nuevo elemento** → subir el zip. Para una versión nueva: el elemento → **Paquete** → **Subir nuevo paquete**, y después **Enviar a revisión**.

## 2. Ficha de la tienda («Store listing»)

El idioma por defecto del manifest es **inglés** (`default_locale: en`), así que la ficha principal va en inglés. El español y el portugués de Brasil (3.10) se añaden como traducciones. El nombre y la descripción corta salen del manifest (`_locales/*/messages.json`). Desde la 3.10.1 el nombre lleva lo que se busca en la tienda: «Escriba: AI Voice Recorder & Transcription», «Escriba: grabadora de voz y transcripción con IA» y «Escriba: gravador de voz e transcrição com IA» (catalán, euskera y gallego, el castellano). En Chrome, el botón y la cabecera siguen diciendo «Escriba» (`short_name`).

**Categoría:** Productivity → Tools (Productividad → Herramientas). **Idioma:** English, con traducciones a Español y a Português (Brasil).

### Descripción en inglés (por defecto)

```
Escriba records your meetings in Chrome and gives you the full transcript — and, with one click, the minutes: summary, decisions, tasks and open questions.

NO SUBSCRIPTION, NO ACCOUNT
There are no paid plans and no sign-up. You use your own free Google Gemini API key (and optionally OpenAI or Anthropic for minutes and questions). Your audio goes straight from your browser to the AI you choose — no servers in between.

ABOUT THE FREE GOOGLE KEY
The free Gemini key has usage limits set by Google, which you can check in Google AI Studio; if you run out, Escriba keeps the audio and tries again later. On the free tier, Google may use what you send to improve its products, and human reviewers may read it — except in the EU (and the rest of the European Economic Area), the UK and Switzerland. If that matters to you, use a key from a Google project with billing enabled.

ALSO A SIMPLE VOICE RECORDER
Don't need a transcript? Use Escriba as a recorder, with no API key: record your microphone (or a tab plus your microphone), listen back in the library and download the recording as a single .wav file. No program to install, no account — nothing leaves your computer. Add your free Gemini key whenever you like and the recording is transcribed on its own.

ANY KIND OF MEETING
• Online (Google Meet, Teams on the web, Zoom on the web…): records the tab audio and your microphone together.
• In person: records with your laptop microphone.
• Files: drop an mp3, m4a, wav or mp4 you already have.

WHILE YOU RECORD
See the level of each source in real time, pause, bookmark important moments, take notes in the side panel and watch the text arrive without waiting for the end. If no voice comes in for two minutes, Escriba tells you. Keyboard shortcut to start and stop.

NOTHING GETS LOST
If Google is busy, the network drops or the key fails, the meeting isn't lost: the audio stays in your browser and Escriba retries on its own. If Chrome closes mid-meeting, it recovers what was recorded.

YOUR MEETING LIBRARY
Search across all your meetings, read each one grouped by speaker with timestamps, name each voice with one click and export to Word, PDF, text or subtitles. Listen back too: click a line and that moment plays. And if a transcript comes out wrong, transcribe it again from that saved audio.

MINUTES AND QUESTIONS WITH 3 AIs
Full minutes, short summary, tasks with owner and deadline, a ready-to-send follow-up email or your own template — with Gemini, GPT or Claude. Ask the meeting anything: it answers citing the minute. Minutes can be generated automatically when the transcript is ready.

REAL PRIVACY
No telemetry, no analytics, no accounts. The developer does not and cannot see your data. Unobfuscated, open-source code.

Interface in English, Spanish and Brazilian Portuguese, with light and dark mode.
```

### Descripción en español (traducción)

```
Escriba graba tus reuniones desde Chrome y te da la transcripción completa — y con un clic, el acta: resumen, decisiones, tareas y temas abiertos.

SIN SUSCRIPCIÓN NI CUENTA
No hay planes de pago ni registro. Usas tu propia clave gratuita de Google Gemini (y, si quieres, OpenAI o Anthropic para actas y preguntas). Tu audio va directo de tu navegador a la IA que tú eliges, sin servidores intermedios.

SOBRE LA CLAVE GRATUITA DE GOOGLE
La clave gratuita de Gemini tiene unos límites de uso que pone Google y que puedes consultar en Google AI Studio; si se agotan, Escriba guarda el audio y lo vuelve a intentar más tarde. Con la clave gratuita, Google puede usar lo que le envías para mejorar sus productos, y lo pueden leer revisores humanos, salvo en la UE (y el resto del Espacio Económico Europeo), el Reino Unido y Suiza. Si eso te importa, usa una clave de un proyecto de Google con la facturación activada.

TAMBIÉN, UNA GRABADORA SENCILLA
¿No necesitas la transcripción? Usa Escriba como grabadora, sin ninguna clave: graba el micrófono (o una pestaña con el micrófono), escúchalo en la biblioteca y descarga la grabación en un solo fichero .wav. Sin instalar ningún programa ni crear cuentas: nada sale de tu ordenador. Pon tu clave gratuita de Gemini cuando quieras y la grabación se transcribe sola.

PARA TODO TIPO DE REUNIONES
• Online (Google Meet, Teams web, Zoom web…): graba el audio de la pestaña y tu micrófono a la vez.
• Presenciales: graba con el micrófono del portátil.
• Archivos: arrastra un mp3, m4a, wav o mp4 que ya tengas.

MIENTRAS GRABAS
Ves el nivel de cada fuente en tiempo real, pausas, marcas los momentos importantes, tomas notas en el panel lateral y ves llegar el texto sin esperar al final. Si en dos minutos no entra voz, Escriba te avisa. Atajo de teclado para empezar y parar.

NO SE PIERDE NADA
Si Google está saturado, se cae la red o la clave falla, la reunión no se pierde: el audio queda en tu navegador y Escriba lo reintenta sola. Si Chrome se cierra a mitad de reunión, recupera lo grabado.

TU BIBLIOTECA DE REUNIONES
Busca en todas tus reuniones, lee cada una agrupada por quién habla y con marcas de tiempo, pon nombre a cada voz con un clic y exporta a Word, PDF, texto o subtítulos. Y escúchala: pulsas una frase y suena ese momento. Si una transcripción sale mal, vuelve a transcribirla con ese audio guardado.

ACTAS Y PREGUNTAS CON 3 IAs
Acta completa, resumen breve, tareas con responsable y plazo, correo de seguimiento listo para enviar o tu propia plantilla, con Gemini, GPT o Claude. Pregúntale a la reunión lo que quieras: responde citando el minuto. El acta puede generarse sola al terminar.

PRIVACIDAD DE VERDAD
Sin telemetría, sin analítica, sin cuentas. El desarrollador no ve ni puede ver tus datos. Código abierto y sin ofuscar.

Interfaz en español, inglés y portugués de Brasil, con modo claro y oscuro.
```

### Descripción en portugués de Brasil (traducción, 3.10)

La mitad de los usuarios tiene Chrome en portugués de Brasil (panel, 29/10/2026). Usa las capturas globales (`en_*`).

```
O Escriba grava suas reuniões no Chrome e entrega a transcrição completa — e, com um clique, a ata: resumo, decisões, tarefas e pontos em aberto.

SEM ASSINATURA, SEM CONTA
Não há planos pagos nem cadastro. Você usa sua própria chave gratuita da API do Google Gemini (e, se quiser, OpenAI ou Anthropic para atas e perguntas). Seu áudio vai direto do navegador para a IA que você escolher, sem servidores no meio do caminho.

SOBRE A CHAVE GRATUITA DO GOOGLE
A chave gratuita do Gemini tem limites de uso definidos pelo Google, que você pode consultar no Google AI Studio; se eles acabarem, o Escriba guarda o áudio e tenta de novo mais tarde. No nível gratuito, o Google pode usar o que você envia para melhorar os produtos dele, e revisores humanos podem ler esse conteúdo — exceto na UE (e no restante do Espaço Econômico Europeu), no Reino Unido e na Suíça. Se isso importa para você, use uma chave de um projeto do Google com faturamento ativado.

TAMBÉM UM GRAVADOR DE VOZ SIMPLES
Não precisa da transcrição? Use o Escriba como gravador, sem nenhuma chave de API: grave o microfone (ou uma aba junto com o microfone), ouça na biblioteca e baixe a gravação em um único arquivo .wav. Sem instalar programas e sem conta: nada sai do seu computador. Coloque sua chave gratuita do Gemini quando quiser e a gravação é transcrita sozinha.

QUALQUER TIPO DE REUNIÃO
• On-line (Google Meet, Teams na web, Zoom na web…): grava o áudio da aba e o seu microfone ao mesmo tempo.
• Presencial: grava com o microfone do notebook.
• Arquivos: arraste um mp3, m4a, wav ou mp4 que você já tenha.

ENQUANTO VOCÊ GRAVA
Veja o nível de cada fonte em tempo real, pause, marque os momentos importantes, faça anotações no painel lateral e acompanhe o texto chegando sem esperar o fim. Se nenhuma voz entrar por dois minutos, o Escriba avisa. Atalho de teclado para iniciar e parar.

NADA SE PERDE
Se o Google estiver sobrecarregado, a internet cair ou a chave falhar, a reunião não se perde: o áudio fica no seu navegador e o Escriba tenta de novo sozinho. Se o Chrome fechar no meio da reunião, ele recupera o que foi gravado.

SUA BIBLIOTECA DE REUNIÕES
Pesquise em todas as suas reuniões, leia cada uma agrupada por quem fala e com marcações de tempo, dê nome a cada voz com um clique e exporte para Word, PDF, texto ou legendas. E ouça de novo: clique em uma frase e aquele momento toca. Se uma transcrição sair errada, transcreva de novo a partir do áudio salvo.

ATAS E PERGUNTAS COM 3 IAs
Ata completa, resumo curto, tarefas com responsável e prazo, um e-mail de acompanhamento pronto para enviar ou o seu próprio modelo — com Gemini, GPT ou Claude. Pergunte o que quiser à reunião: ela responde citando o minuto. A ata pode ser gerada automaticamente quando a transcrição fica pronta.

PRIVACIDADE DE VERDADE
Sem telemetria, sem análises, sem contas. O desenvolvedor não vê e não pode ver seus dados. Código aberto e sem ofuscação.

Interface em português do Brasil, inglês e espanhol, com modo claro e escuro.
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
| `tabCapture` | Captures the audio of the meeting tab only when the user clicks Record (icon or keyboard shortcut) in the one-click «Quick» mode, which is the default. Core feature. The alternative «Tab + mic» mode uses Chrome's own «Choose what to share» dialog (getDisplayMedia), which needs no manifest permission; only the audio is used and the picture is discarded at once. |
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
