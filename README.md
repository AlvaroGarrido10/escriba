# 🎙️ TranscripcionesAG

Graba tus reuniones desde Chrome y obtén la **transcripción completa con IA** al parar. Sin cuotas, sin suscripciones: solo tu clave gratuita de Google Gemini.

- **Reuniones online** (Meet, Teams web…): graba el audio de la pestaña **y** tu micrófono a la vez.
- **Reuniones presenciales**: graba solo con el micrófono del portátil.
- Al parar, la transcripción se descarga sola en `Descargas\reuniones\` (`.md`) y puedes copiarla con un clic para pasársela a tu IA (resúmenes, actas, tareas…).

## Instalación (2 minutos, una vez)

1. Abre Chrome y ve a `chrome://extensions`
2. Activa el **Modo desarrollador** (interruptor arriba a la derecha).
3. Pulsa **«Cargar descomprimida»** y elige esta carpeta (`C:\TranscripcionesAG`).
4. Ancla el icono: puzzle 🧩 de la barra → chincheta 📌 junto a TranscripcionesAG.

## Configuración (1 minuto, una vez)

1. Consigue tu clave gratis: entra en **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** con tu cuenta de Google → **Create API key** → copiar.
2. Clic derecho en el icono de la extensión → **Opciones**:
   - Pega la clave y pulsa **Guardar**.
   - Pulsa **Probar clave** (debe decir ✅).
   - Pulsa **Permitir micrófono** y acepta.
3. (Opcional) Ajusta el **glosario**: nombres de empresas/proyectos/jerga para que la IA los escriba bien.

## Uso

1. **En la pestaña de la reunión** (Meet/Teams), pulsa el icono 🎙️. Si es presencial, púlsalo desde cualquier pestaña y elige «Solo micro».
2. **⏺ Empezar a grabar**. Minimiza la ventanita — no la cierres.
3. Al terminar: **⏹ Parar y transcribir**. En 1-3 minutos tienes la transcripción:
   - Se descarga sola en `Descargas\reuniones\`
   - Botón **Copiar** para pegarla en tu IA
   - Botón **Guardar audio** por si quieres conservar la grabación

## Preguntas rápidas

- **¿Cuánto cuesta?** Nada. La capa gratuita de Gemini cubre reuniones diarias de sobra.
- **¿Cuánto puede durar una reunión?** Probado hasta ~1 h sin problema (el audio de 1 h ocupa ~20 MB y se sube automáticamente por la vía de archivos grandes).
- **¿Y la privacidad?** El audio va de tu Chrome a la API de Google Gemini con TU clave. No pasa por ningún otro servidor.
- **¿Se corta si cambio de pestaña?** No. Solo si cierras la pestaña de la reunión o la ventanita de grabación.
- **La transcripción falló.** El audio no se pierde: botón «Guardar audio», revisa la clave en Opciones y reinténtalo.

---
Hecho en Ditay Tech · v2.0 — grabación en segundo plano, historial y análisis con 3 IAs (BYOK: cada uno con su clave)
