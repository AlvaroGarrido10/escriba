// Escriba — transcribir un archivo que ya está en el ordenador.
//
// La página solo PREPARA: decodifica el audio (cualquier formato que entienda
// Chrome), lo pasa a mono 16 kHz, lo trocea en tramos de 5 minutos como una
// grabación normal, guarda cada tramo en IndexedDB y crea la entrada del
// historial. La transcripción la hace el mismo motor que la de las grabaciones
// (offscreen.js), así que tiene sus reintentos y se puede cerrar la pestaña.

const $ = (id) => document.getElementById(id);
const TOPE_MB = 500;           // por archivo: más que eso no cabe decodificado en memoria
const FRECUENCIA = 16000;      // de sobra para voz, y 3 veces menos que 48 kHz
let ficheros = [], idActual = null;

// --- elegir archivos -----------------------------------------------------------
$("zona").onclick = () => $("fichero").click();
$("zona").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fichero").click(); } };
$("fichero").onchange = () => ponFicheros([...$("fichero").files]);
$("btnOtro").onclick = () => { $("fichero").value = ""; $("fichero").click(); };
$("zona").ondragover = (e) => { e.preventDefault(); $("zona").classList.add("encima"); };
$("zona").ondragleave = () => $("zona").classList.remove("encima");
$("zona").ondrop = (e) => {
  e.preventDefault();
  $("zona").classList.remove("encima");
  ponFicheros([...e.dataTransfer.files]);
};

const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace(".", ",") + " MB";
const sinExtension = (n) => n.replace(/\.[^.]+$/, "");

function ponFicheros(lista) {
  if (idActual) return; // hay una importación en marcha
  const validos = lista.filter((f) => f.size > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }));
  ocultaAvisos();
  if (!validos.length) return;
  const grande = validos.find((f) => f.size > TOPE_MB * 1048576);
  if (grande) return muestraError(`«${grande.name}» pesa ${mb(grande.size)}. El máximo es ${TOPE_MB} MB por archivo: pártelo antes en trozos.`);
  ficheros = validos;
  $("lista").innerHTML = "";
  for (const f of ficheros) {
    const li = document.createElement("li");
    li.innerHTML = "<span></span><span></span>";
    li.children[0].textContent = "🎧 " + f.name;
    li.children[1].textContent = mb(f.size);
    $("lista").appendChild(li);
  }
  $("titulo").value = sinExtension(ficheros[0].name);
  $("formulario").hidden = false;
  $("btnTranscribir").focus();
}

// --- preparar y encargar la transcripción ---------------------------------------
$("btnTranscribir").onclick = async () => {
  if (!ficheros.length || idActual) return;
  $("btnTranscribir").disabled = true;
  $("btnOtro").disabled = true;
  ocultaAvisos();
  const id = Date.now();
  idActual = id;
  let guardados = 0;
  try {
    const { tramos, segundos } = await preparar(id, (n) => { guardados = n; });
    const pendientes = tramos.filter((t) => t.estado === "pendiente").length;
    if (!pendientes) {
      await audios.borrarReunion(id).catch(() => {});
      idActual = null;
      return muestraError("No se oye ninguna voz en el audio (está en silencio). No se ha mandado nada a transcribir.");
    }
    const f = fechaBonita(id);
    const r = await chrome.runtime.sendMessage({
      target: "bg", cmd: "histCrear", item: {
        id, fecha: f.legible, titulo: $("titulo").value.trim() || sinExtension(ficheros[0].name),
        origen: "archivo", estado: "transcribiendo", progreso: `${tramos.length - pendientes}/${tramos.length} tramos`,
        transcript: "", analisis: {}, tramos,
        meta: {
          fichero: f.fichero, minutos: Math.max(1, Math.round(segundos / 60)),
          audioLinea: ficheros.map((x) => x.name).join(" + "),
        },
      },
    });
    if (!r || !r.ok) throw new Error((r && r.error) || "No se pudo guardar en el historial.");
    pintaProgreso("✍️ Transcribiendo…", 0);
    await chrome.runtime.sendMessage({ target: "bg", cmd: "transcribir", id });
  } catch (e) {
    // Lo guardado a medias no sirve de nada sin su entrada en el historial.
    if (guardados) await audios.borrarReunion(id).catch(() => {});
    idActual = null;
    muestraError((e && e.message) || String(e));
  } finally {
    $("btnTranscribir").disabled = false;
    $("btnOtro").disabled = false;
  }
};

async function preparar(id, alGuardar) {
  const ctx = new AudioContext({ sampleRate: FRECUENCIA });
  const tramos = [];
  let segundos = 0, guardados = 0;
  try {
    for (let k = 0; k < ficheros.length; k++) {
      const f = ficheros[k];
      const cuantos = ficheros.length > 1 ? ` (${k + 1} de ${ficheros.length})` : "";
      pintaProgreso(`🎧 Leyendo «${f.name}»${cuantos}…`, 0);
      let audio;
      try {
        audio = await ctx.decodeAudioData(await f.arrayBuffer());
      } catch (_) {
        throw new Error(`No se puede leer «${f.name}»: Chrome no reconoce su formato. Prueba con mp3, m4a, wav o webm.`);
      }
      const muestras = aMono(audio);
      segundos += muestras.length / audio.sampleRate;
      const plan = planificarTramos([{ nombre: f.name, longitud: muestras.length, sampleRate: audio.sampleRate }]);
      for (let j = 0; j < plan.length; j++) {
        const p = plan[j];
        pintaProgreso(`✂️ Preparando «${f.name}»${cuantos}: tramo ${j + 1} de ${plan.length}…`, (j + 1) / plan.length);
        const trozo = muestras.subarray(p.desde, p.hasta);
        const { pico } = medirMuestras(trozo, audio.sampleRate, UMBRAL_VOZ);
        const etiqueta = ficheros.length > 1 ? `${f.name}, ${p.etiqueta}` : p.etiqueta;
        if (pico < PICO_SILENCIO) {
          tramos.push({ estado: "mudo", pico, etiqueta });
          continue;
        }
        const blob = new Blob([codificarWav(trozo, audio.sampleRate)], { type: "audio/wav" });
        try {
          await audios.guardar(id, tramos.length, blob);
        } catch (e) {
          throw new Error("No hay espacio para guardar el audio en el navegador: " + ((e && e.message) || e));
        }
        alGuardar(++guardados);
        tramos.push({ estado: "pendiente", pico, etiqueta });
      }
    }
  } finally {
    ctx.close().catch(() => {});
  }
  return { tramos, segundos };
}

// Varios canales → uno, promediando. La voz no gana nada en estéreo.
function aMono(audio) {
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const n = audio.length, mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i];
  }
  for (let i = 0; i < n; i++) mono[i] /= audio.numberOfChannels;
  return mono;
}

// --- seguimiento --------------------------------------------------------------
chrome.storage.onChanged.addListener((cambios, area) => {
  if (area !== "local" || !cambios.historial || !idActual) return;
  const h = (cambios.historial.newValue || []).find((x) => x.id === idActual);
  if (!h) return;
  if (h.estado === "transcribiendo") {
    const r = resumenTramos(h.tramos);
    pintaProgreso(`✍️ Transcribiendo… ${r.total - r.pendientes} de ${r.total} tramos`, r.total ? (r.total - r.pendientes) / r.total : 0);
  } else if (["ok", "pendiente", "error"].includes(h.estado) && h.transcript) {
    muestraResultado(h);
  }
});

function muestraResultado(h) {
  idActual = null;
  $("progreso").hidden = true;
  $("resultado").hidden = false;
  $("formulario").hidden = true;
  const caja = $("resultadoTxt");
  if (h.estado === "ok") {
    caja.className = "aviso ok";
    caja.textContent = "✅ Transcripción lista. Está en el historial de Escriba (desde ahí puedes sacar el acta) y en Descargas/reuniones.";
  } else if (h.estado === "pendiente") {
    const r = resumenTramos(h.tramos);
    caja.className = "aviso pend";
    const falta = r.total === 1 ? "Todavía no se ha podido transcribir" : `Faltan ${r.pendientes} de ${r.total} tramos`;
    caja.textContent = `⏳ ${falta}. El audio está guardado y Escriba lo reintentará sola; verás el avance en el historial.`;
  } else {
    caja.className = "aviso err";
    caja.textContent = "❌ No se pudo transcribir. El detalle está abajo.";
  }
  $("texto").value = h.transcript;
}

function pintaProgreso(txt, fraccion) {
  $("progreso").hidden = false;
  $("progresoTxt").textContent = txt;
  $("progresoBarra").style.width = Math.round(Math.max(0.03, Math.min(1, fraccion)) * 100) + "%";
}
function muestraError(txt) {
  $("progreso").hidden = true;
  $("resultado").hidden = false;
  $("resultadoTxt").className = "aviso err";
  $("resultadoTxt").textContent = "❌ " + txt;
  $("texto").hidden = true;
  $("btnCopiar").hidden = true;
}
function ocultaAvisos() {
  $("resultado").hidden = true;
  $("texto").hidden = false;
  $("btnCopiar").hidden = false;
}

$("btnCopiar").onclick = async () => {
  await navigator.clipboard.writeText($("texto").value);
  $("btnCopiar").textContent = "📋 Copiado";
  setTimeout(() => { $("btnCopiar").textContent = "📋 Copiar"; }, 1500);
};
$("btnNuevo").onclick = () => {
  ficheros = [];
  $("lista").innerHTML = "";
  $("formulario").hidden = true;
  $("resultado").hidden = true;
  $("fichero").value = "";
  $("fichero").click();
};

(async () => {
  const { geminiKey } = await leerConfig();
  $("avisoClave").hidden = !!geminiKey;
})();
