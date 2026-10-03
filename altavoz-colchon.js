// Escriba — altavoz con colchón (AudioWorklet).
//
// Chrome silencia la pestaña que se captura, así que su sonido hay que devolverlo
// a los altavoces. Los dos reproductores de Chrome para audio en directo (un
// <audio> con el stream, o un AudioContext con el stream como fuente) trabajan
// casi sin reserva: el audio capturado llega a trompicones (trozos de 9 ms con
// un reloj que no es el de la tarjeta de sonido) y ellos lo arreglan tirando o
// repitiendo muestras y metiendo silencios. Eso son los microcortes.
//
// Aquí el sonido capturado se va guardando en un anillo y sale al ritmo de la
// tarjeta con una reserva fija (el «colchón»). Si los dos relojes no van
// exactamente igual, la reserva crece o mengua muy despacio: se corrige
// estirando o encogiendo el audio una fracción inaudible (como mucho un 0,3 %),
// nunca cortando.

const CAP = 1 << 17;          // muestras del anillo (2,7 s a 48 kHz)
const MASCARA = CAP - 1;
const TAPS = 16;              // muestras que intervienen en cada muestra de salida
const MITAD = TAPS / 2;
const FASES = 128;            // posiciones intermedias tabuladas entre dos muestras
const SUAVE = 0.003;          // filtro de la medida de la reserva (~1 s)
const GANANCIA = 0.2;         // corrección por segundo de error en la reserva: con los relojes un 0,2 %
                              // distintos (muchísimo) la reserva se queda a 10 ms del objetivo
const AJUSTE_MAX = 0.003;     // estirar o encoger, como mucho, un 0,3 %
const SOBRA_MAX_S = 0.4;      // reserva por encima del objetivo que ya no se recupera estirando
const PASO_SUBIDA = 1 / (0.005 * sampleRate);  // al empezar a sonar, de cero a todo en 5 ms

// Filtros para leer «entre dos muestras»: seno cardinal con ventana de Blackman.
// Con la posición entera el filtro es la propia muestra (no toca el sonido).
const TABLA = (() => {
  const t = new Float32Array((FASES + 1) * TAPS);
  for (let p = 0; p <= FASES; p++) {
    let suma = 0;
    for (let k = 0; k < TAPS; k++) {
      const x = k - (MITAD - 1) - p / FASES;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const v = 0.42 + 0.5 * Math.cos(2 * Math.PI * x / TAPS) + 0.08 * Math.cos(4 * Math.PI * x / TAPS);
      t[p * TAPS + k] = sinc * v;
      suma += sinc * v;
    }
    for (let k = 0; k < TAPS; k++) t[p * TAPS + k] /= suma;
  }
  return t;
})();

class EscribaAltavoz extends AudioWorkletProcessor {
  constructor(opciones) {
    super();
    const o = (opciones && opciones.processorOptions) || {};
    this.hzEntrada = o.hzEntrada || sampleRate;
    this.base = this.hzEntrada / sampleRate;      // muestras de entrada por cada una de salida
    this.objetivo = Math.round((o.colchonMs || 80) / 1000 * this.hzEntrada);
    this.L = new Float32Array(CAP);
    this.R = new Float32Array(CAP);
    this.w = 0;            // muestras escritas en total
    this.r = 0;            // posición de lectura (con decimales)
    this.cebado = false;   // false: esperando a tener la reserva antes de sonar
    this.subida = 1;
    this.err = 0;
    this.vacios = 0;       // veces que se quedó sin audio (hueco)
    this.tirados = 0;      // veces que hubo que saltar audio porque sobraba demasiado
    this.minLleno = Infinity;
    this.cuenta = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.entrada) { d.entrada.onmessage = (m) => this.recibe(m.data); return; }
      this.recibe(d);
    };
  }

  recibe(d) {
    if (!d || !d.l) return;
    const l = d.l, r = d.r || d.l, n = l.length;
    for (let i = 0; i < n; i++) {
      const j = (this.w + i) & MASCARA;
      this.L[j] = l[i];
      this.R[j] = r[i];
    }
    this.w += n;
    // Sobra demasiado (un parón largo y luego todo de golpe): mejor un salto que ir
    // medio segundo por detrás, o que lo nuevo pise lo que aún no ha sonado.
    if (this.cebado && this.w - this.r > this.objetivo + SOBRA_MAX_S * this.hzEntrada) {
      this.r = this.w - this.objetivo;
      this.err = 0;
      this.tirados++;
    }
  }

  process(_entradas, salidas) {
    const sal = salidas[0], L = sal[0], R = sal[1] || sal[0], n = L.length;
    let lleno = this.w - this.r;
    if (!this.cebado) {
      if (lleno < this.objetivo) return true;       // silencio hasta tener la reserva
      this.cebado = true;
      this.r = this.w - this.objetivo;              // posición entera: el sonido sale intacto
      this.err = 0;
      this.subida = 0;                              // entra subiendo en 5 ms: arrancar a media onda es un chasquido
      lleno = this.objetivo;
    }
    if (lleno < this.minLleno) this.minLleno = lleno;
    const e = (lleno - this.objetivo) / this.hzEntrada;
    this.err += (e - this.err) * SUAVE;
    const aj = Math.max(-AJUSTE_MAX, Math.min(AJUSTE_MAX, this.err * GANANCIA));
    const paso = this.base * (1 + aj);
    for (let i = 0; i < n; i++) {
      const i0 = Math.floor(this.r);
      if (i0 + MITAD >= this.w) {                   // se acabó la reserva: hueco, y a cebar otra vez
        for (let j = i; j < n; j++) { L[j] = 0; R[j] = 0; }
        this.cebado = false;
        this.vacios++;
        break;
      }
      const p = (this.r - i0) * FASES, p0 = p | 0, a = p - p0;
      const f0 = p0 * TAPS, f1 = f0 + TAPS, desde = i0 - (MITAD - 1);
      let sl = 0, sr = 0;
      for (let k = 0; k < TAPS; k++) {
        const h = TABLA[f0 + k] + (TABLA[f1 + k] - TABLA[f0 + k]) * a;
        const j = (desde + k) & MASCARA;
        sl += h * this.L[j];
        sr += h * this.R[j];
      }
      if (this.subida < 1) {
        sl *= this.subida; sr *= this.subida;
        this.subida = Math.min(1, this.subida + PASO_SUBIDA);
      }
      L[i] = sl;
      R[i] = sr;
      this.r += paso;
    }
    // Estado para el documento que graba, una vez por segundo aproximadamente.
    if (++this.cuenta >= 375) {
      this.port.postMessage({ estado: {
        vacios: this.vacios, tirados: this.tirados,
        reservaMs: Math.round((this.w - this.r) / this.hzEntrada * 1000),
        reservaMinMs: Math.round(this.minLleno / this.hzEntrada * 1000),
        ajuste: aj,
      } });
      this.cuenta = 0;
      this.minLleno = Infinity;
    }
    return true;
  }
}

registerProcessor("escriba-altavoz", EscribaAltavoz);
