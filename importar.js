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

const mb = (n) => {
  const dec = n < 10485760 ? 1 : 0;
  return (n / 1048576).toLocaleString(LOCALE_UI(), { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false }) + " MB";
};
const sinExtension = (n) => n.replace(/\.[^.]+$/, "");

function ponFicheros(lista) {
  if (idActual) return; // hay una importación en marcha
  const validos = lista.filter((f) => f.size > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }));
  ocultaAvisos();
  if (!validos.length) return;
  const grande = validos.find((f) => f.size > TOPE_MB * 1048576);
  if (grande) return muestraError(t("imp.demasiadoGrande", grande.name, mb(grande.size), TOPE_MB));
  ficheros = validos;
  $("lista").innerHTML = "";
  for (const f of ficheros) {
    const li = document.createElement("li");
    li.innerHTML = icono("archivo-audio") + '<span class="nom"></span><span class="tam"></span>';
    li.querySelector(".nom").textContent = f.name;
    li.querySelector(".tam").textContent = mb(f.size);
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
      return muestraError(t("imp.silencio"));
    }
    const f = fechaBonita(id);
    const r = await chrome.runtime.sendMessage({
      target: "bg", cmd: "histCrear", item: {
        id, fecha: f.legible, titulo: $("titulo").value.trim() || sinExtension(ficheros[0].name),
        origen: "archivo", estado: "transcribiendo", progreso: t("com.progresoTramos", tramos.length - pendientes, tramos.length),
        participantes: $("participantes").value.trim(),
        transcript: "", analisis: {}, tramos,
        meta: {
          fichero: f.fichero, minutos: Math.max(1, Math.round(segundos / 60)),
          audioLinea: ficheros.map((x) => x.name).join(" + "),
        },
      },
    });
    if (!r || !r.ok) throw new Error((r && r.error) || t("imp.noGuardado"));
    // Sin con quién transcribir no se transcribe nada: se guarda el audio (3.8.1).
    await miraVoz();
    pintaProgreso(sinVoz ? t("imp.guardando") : t("imp.transcribiendo"), 0);
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
      const cuantos = ficheros.length > 1 ? " " + t("imp.parteDe", k + 1, ficheros.length) : "";
      pintaProgreso(t("imp.leyendo", f.name, cuantos), 0);
      let audio;
      try {
        audio = await ctx.decodeAudioData(await f.arrayBuffer());
      } catch (_) {
        throw new Error(t("imp.formatoNoValido", f.name));
      }
      const muestras = aMono(audio);
      const inicioArchivo = segundos; // los archivos son partes seguidas de la misma reunión
      segundos += muestras.length / audio.sampleRate;
      const plan = planificarTramos([{ nombre: f.name, longitud: muestras.length, sampleRate: audio.sampleRate }]);
      for (let j = 0; j < plan.length; j++) {
        const p = plan[j];
        pintaProgreso(t("imp.preparando", f.name, cuantos, j + 1, plan.length), (j + 1) / plan.length);
        const trozo = muestras.subarray(p.desde, p.hasta);
        const { pico } = medirMuestras(trozo, audio.sampleRate, UMBRAL_VOZ);
        const etiqueta = ficheros.length > 1 ? `${f.name}, ${p.etiqueta}` : p.etiqueta;
        const inicioS = Math.round(inicioArchivo + p.desde / audio.sampleRate);
        if (pico < PICO_SILENCIO) {
          tramos.push({ estado: "mudo", pico, etiqueta, inicioS });
          continue;
        }
        const blob = new Blob([codificarWav(trozo, audio.sampleRate)], { type: "audio/wav" });
        try {
          await audios.guardar(id, tramos.length, blob);
        } catch (e) {
          throw new Error(t("imp.sinEspacio", (e && e.message) || e));
        }
        alGuardar(++guardados);
        tramos.push({ estado: "pendiente", pico, etiqueta, inicioS });
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
// Sin con quién transcribir (proveedores.js) se importa igual: se avisa de que el
// audio se queda guardado hasta que haya una clave, y mientras se guarda no se
// dice «Transcribiendo…».
let sinVoz = false;
async function miraVoz() {
  sinVoz = !proveedorVoz(await leerConfig());
  $("avisoClave").hidden = !sinVoz;
}
chrome.storage.onChanged.addListener((cambios, area) => {
  // Una clave puesta o quitada con esta página abierta cambia lo que se está haciendo.
  if (!cambios.historial) { miraVoz(); return; }
  if (area !== "local" || !idActual) return;
  const h = (cambios.historial.newValue || []).find((x) => x.id === idActual);
  if (!h) return;
  if (h.estado === "transcribiendo") {
    const r = resumenTramos(h.tramos);
    if (sinVoz) pintaProgreso(t("imp.guardando"), 0);
    else pintaProgreso(t("imp.transcribiendoTramos", r.total - r.pendientes, r.total), r.total ? (r.total - r.pendientes) / r.total : 0);
  } else if (["ok", "pendiente", "error"].includes(h.estado) && h.transcript) {
    muestraResultado(h);
  }
});

function muestraResultado(h) {
  idActual = null;
  $("btnAbrir").hidden = false;
  $("btnAbrir").onclick = () => chrome.tabs.create({ url: "reuniones.html#" + h.id });
  $("progreso").hidden = true;
  $("resultado").hidden = false;
  $("formulario").hidden = true;
  const caja = $("resultadoTxt");
  // Sin clave con la que transcribir (3.8) no ha fallado nada: el audio queda
  // guardado, a la espera. Y no hay texto que enseñar ni que copiar.
  const guardado = sinTranscribir(h) && !h.tramos.some((tr) => tr && tr.estado === "ok");
  $("texto").hidden = guardado;
  $("btnCopiar").hidden = guardado;
  if (h.estado === "ok") {
    ponAviso(caja, "ok", escapa(t("imp.listaOk")));
  } else if (guardado) {
    ponAviso(caja, "", escapa(t("imp.pendienteSinClave")), "llave");
  } else if (h.estado === "pendiente") {
    const r = resumenTramos(h.tramos);
    ponAviso(caja, "atencion", escapa(r.total === 1 ? t("imp.pendienteUno") : t("imp.pendienteVarios", r.pendientes, r.total)), "reloj");
  } else {
    ponAviso(caja, "error", escapa(t("imp.fallo")));
  }
  $("texto").value = h.transcript;
}

function pintaProgreso(txt, fraccion) {
  $("progreso").hidden = false;
  $("progresoTxt").innerHTML = icono("ondas") + `<span>${escapa(txt)}</span>`;
  $("progresoBarra").style.width = Math.round(Math.max(0.03, Math.min(1, fraccion)) * 100) + "%";
}
function muestraError(txt) {
  $("progreso").hidden = true;
  $("resultado").hidden = false;
  ponAviso($("resultadoTxt"), "error", escapa(txt));
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
  $("btnCopiar").innerHTML = icono("check") + `<span>${escapa(t("imp.copiado"))}</span>`;
  setTimeout(() => { $("btnCopiar").innerHTML = icono("copiar") + `<span>${escapa(t("imp.copiar"))}</span>`; }, 1500);
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
  // Antes de nada: el idioma elegido en Opciones (traduce el HTML).
  await cargarIdiomaUI();
  await miraVoz();
})();
