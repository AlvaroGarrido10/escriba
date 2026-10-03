// Escriba — bomba del altavoz con colchón (Worker).
// Lleva el audio capturado de la pestaña al AudioWorklet que lo reproduce
// (altavoz-colchon.js). Va en un hilo aparte: el documento que graba se para a
// ratos (medir un tramo, prepararlo para transcribir) y, si el audio pasara por
// él, cada parón sería un hueco en lo que se oye.
//
// De paso remienda lo que Chrome pierde. Con el equipo en reposo (y más con
// batería) la captura de pestaña se salta trozos enteros de 9 ms, hasta uno por
// segundo: la hora de cada trozo dice cuánto falta. Pegar sin más lo de antes
// con lo de después es un chasquido, así que el hueco se rellena repitiendo el
// último ciclo del sonido (lo que hace la telefonía cuando se pierde un paquete)
// y se funde con lo que llega después.

const HIST = 2048;            // muestras recientes que se guardan para remendar
const MS_MIN = 4;             // por debajo de esto no es un trozo perdido, es el redondeo de las horas
const MS_MAX = 250;           // por encima no se remienda: ha sido un parón, no una pérdida
const MS_VENTANA = 5;         // trozo final que se compara para encontrar el ciclo
const MS_CICLO_MIN = 3, MS_CICLO_MAX = 15;
const MS_FUNDIDO = 2.5;
const MS_SOSTENIDO = 20, MS_APAGADO = 80;  // un hueco largo se va apagando: repetir mucho rato suena a robot
// El corte no cae justo donde cambia la hora, sino entre 1 y 3 ms dentro del trozo
// siguiente (medido en 15 casos: de 44 a 148 muestras). Ese arranque dudoso se
// descarta y se rellena también: así el corte queda siempre dentro del remiendo.
const MS_DUDOSO = 5;
const AJUSTE = 4;             // muestras que se prueba a mover lo que llega para que encaje con el relleno

const hl = new Float32Array(HIST), hr = new Float32Array(HIST);
let nh = 0;                   // muestras válidas en el historial (las más nuevas, al final)

function recuerda(l, r) {
  const n = l.length;
  if (n >= HIST) { hl.set(l.subarray(n - HIST)); hr.set(r.subarray(n - HIST)); nh = HIST; return; }
  hl.copyWithin(0, n); hr.copyWithin(0, n);
  hl.set(l, HIST - n); hr.set(r, HIST - n);
  nh = Math.min(HIST, nh + n);
}

// Cuántas muestras atrás empieza el ciclo que mejor repite el final del sonido.
function ciclo(hz) {
  const w = Math.round(MS_VENTANA * hz / 1000);
  const pMin = Math.round(MS_CICLO_MIN * hz / 1000), pMax = Math.min(Math.round(MS_CICLO_MAX * hz / 1000), nh - w);
  let mejor = pMin, nota = -Infinity;
  const fin = HIST - w;
  for (let p = pMin; p <= pMax; p++) {
    let cruz = 0, ener = 1e-9;
    for (let i = 0; i < w; i++) {
      const a = hl[fin + i] + hr[fin + i], b = hl[fin - p + i] + hr[fin - p + i];
      cruz += a * b; ener += b * b;
    }
    const v = cruz / Math.sqrt(ener);
    if (v > nota) { nota = v; mejor = p; }
  }
  return mejor;
}

// Faltan `faltan` muestras antes del trozo que llega (l, r). Devuelve el relleno
// (lo que falta más el arranque dudoso del trozo) y el resto del trozo, con su
// principio fundido con la continuación del relleno.
function remienda(faltan, l, r, hz) {
  const p = ciclo(hz);
  const dudoso = Math.min(Math.round(MS_DUDOSO * hz / 1000), l.length >> 1);
  const total = faltan + dudoso;
  const f = Math.min(Math.round(MS_FUNDIDO * hz / 1000), l.length - dudoso - AJUSTE);
  const sost = Math.round(MS_SOSTENIDO * hz / 1000), apag = Math.round(MS_APAGADO * hz / 1000);
  const base = HIST - p;
  const gan = (i) => (i <= sost ? 1 : i >= apag ? 0 : 1 - (i - sost) / (apag - sost));
  const pl = new Float32Array(total), pr = new Float32Array(total);
  // El relleno arranca donde arrancó el ciclo anterior. Si el sonido no es del todo
  // periódico queda un escalón respecto a la última muestra que sonó: se reparte en
  // el fundido en vez de dejarlo de golpe.
  const escL = hl[HIST - 1] - hl[base - 1], escR = hr[HIST - 1] - hr[base - 1];
  for (let i = 0; i < total; i++) {
    const k = base + (i % p), g = gan(i), c = i < f ? 1 - (i + 1) / (f + 1) : 0;
    pl[i] = (hl[k] + escL * c) * g;
    pr[i] = (hr[k] + escR * c) * g;
  }
  // Chrome estira y encoge lo que captura, así que lo que llega puede venir una o dos
  // muestras movido respecto a lo que el relleno espera: se busca el encaje fino.
  let encaje = 0, nota = -Infinity;
  for (let d = -AJUSTE; d <= AJUSTE; d++) {
    let cruz = 0, ener = 1e-9;
    for (let i = 0; i < f; i++) {
      const c = hl[base + ((total + i) % p)] + hr[base + ((total + i) % p)], v = l[dudoso + d + i] + r[dudoso + d + i];
      cruz += c * v; ener += v * v;
    }
    const n = cruz / Math.sqrt(ener);
    if (n > nota) { nota = n; encaje = d; }
  }
  const ll = l.slice(dudoso + encaje), rr = r === l ? ll : r.slice(dudoso + encaje);
  for (let i = 0; i < f; i++) {
    const k = base + ((total + i) % p), g = gan(total + i), a = (i + 1) / (f + 1);
    ll[i] = hl[k] * g * (1 - a) + ll[i] * a;
    if (rr !== ll) rr[i] = hr[k] * g * (1 - a) + rr[i] * a;
  }
  return [pl, pr, ll, rr];
}

onmessage = async (e) => {
  const { audio, salida } = e.data;
  const lector = audio.getReader();
  let finPrevio = null;       // hora (µs) a la que acababa el trozo anterior
  for (;;) {
    const { value: f, done } = await lector.read();
    if (done) break;
    const n = f.numberOfFrames, hz = f.sampleRate, hora = f.timestamp, dura = f.duration;
    let l = new Float32Array(n);
    f.copyTo(l, { planeIndex: 0, format: "f32-planar" });
    let r = l;
    if (f.numberOfChannels > 1) {
      r = new Float32Array(n);
      f.copyTo(r, { planeIndex: 1, format: "f32-planar" });
    }
    f.close();
    if (finPrevio !== null) {
      const ms = (hora - finPrevio) / 1000;
      if (ms > MS_MIN && ms < MS_MAX && nh === HIST) {
        // Se pierden trozos enteros: las horas llevan algo de holgura, el tamaño no.
        const faltan = dura > 0 ? Math.max(1, Math.round((hora - finPrevio) / dura)) * n : Math.round(ms * hz / 1000);
        const [pl, pr, ll, rr] = remienda(faltan, l, r, hz);
        recuerda(pl, pr);
        salida.postMessage({ l: pl, r: pr }, [pl.buffer, pr.buffer]);
        postMessage({ remiendo: ms });
        l = ll; r = rr;
      }
    }
    finPrevio = hora + dura;
    recuerda(l, r);
    salida.postMessage({ l, r: r === l ? null : r }, r === l ? [l.buffer] : [l.buffer, r.buffer]);
  }
};
