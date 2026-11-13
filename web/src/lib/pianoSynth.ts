/**
 * A small physically inspired piano synthesizer (used by the artifact edition, which ships no audio
 * files). Each note is a sum of slightly inharmonic partials of two detuned strings with a two-stage
 * decay (fast "prompt" sound, slow "aftersound") and a short hammer noise.
 */

const SAMPLE_RATE = 44100;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Renders one note (stereo Float32 channels) at the given MIDI pitch. */
export function renderPianoNote(midi: number, sampleRate = SAMPLE_RATE): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const f0 = 440 * Math.pow(2, (midi - 69) / 12);
  const pos = (midi - 21) / 87; // 0 = lowest key, 1 = highest
  const seconds = 4.6 - 3 * pos;
  const n = Math.round(seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const rand = mulberry32(midi * 7919);

  const B = 0.00025 * Math.pow(2, (midi - 60) / 16); // inharmonicity
  const tau1 = 3.2 - 2.6 * pos; // aftersound decay of the fundamental (s)
  const nyquist = sampleRate / 2 - 500;
  const maxPartials = 28;
  const pan = Math.max(-0.6, Math.min(0.6, (midi - 64) / 50));
  const gl = Math.sqrt(0.5 * (1 - pan));
  const gr = Math.sqrt(0.5 * (1 + pan));

  for (let string = 0; string < 2; string++) {
    const detune = Math.pow(2, ((string === 0 ? -0.7 : 0.7) * (0.6 + rand() * 0.5)) / 1200);
    for (let k = 1; k <= maxPartials; k++) {
      const fk = k * f0 * detune * Math.sqrt(1 + B * k * k);
      if (fk >= nyquist || fk > 14000) break;
      // hammer spectrum: brighter in the treble, a dip near the strike point (1/8 of the string)
      const strike = Math.abs(Math.sin((Math.PI * k) / 8)) * 0.85 + 0.15;
      const amp = (strike / Math.pow(k, 1.15)) * Math.exp(-(k - 1) * (0.09 - 0.05 * pos)) * 0.5;
      const tauSlow = tau1 / (1 + 0.32 * (k - 1));
      const tauFast = Math.max(0.05, tauSlow * 0.18);
      const prompt = 0.68;
      const w = (2 * Math.PI * fk) / sampleRate;
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      const phase = rand() * 2 * Math.PI;
      let s = Math.sin(phase);
      let c = Math.cos(phase);
      const dSlow = Math.exp(-1 / (tauSlow * sampleRate));
      const dFast = Math.exp(-1 / (tauFast * sampleRate));
      let eSlow = amp * (1 - prompt);
      let eFast = amp * prompt;
      for (let i = 0; i < n; i++) {
        const v = s * (eSlow + eFast);
        left[i] += v * gl;
        right[i] += v * gr;
        const s2 = s * cw + c * sw;
        c = c * cw - s * sw;
        s = s2;
        eSlow *= dSlow;
        eFast *= dFast;
        if (eSlow + eFast < 1e-5) break;
      }
    }
  }

  // hammer noise (a few milliseconds, low-passed)
  const noiseLen = Math.round(0.012 * sampleRate);
  let lp = 0;
  const alpha = 0.08 + 0.3 * pos;
  for (let i = 0; i < noiseLen; i++) {
    lp += alpha * (rand() * 2 - 1 - lp);
    const v = lp * 0.25 * (1 - i / noiseLen);
    left[i] += v;
    right[i] += v;
  }

  // attack ramp, gentle fade at the end, normalisation
  const attack = Math.round(0.002 * sampleRate);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < attack) g = i / attack;
    if (i > n - 2000) g *= (n - i) / 2000;
    left[i] *= g;
    right[i] *= g;
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const norm = peak > 0 ? 0.55 / peak : 1;
  for (let i = 0; i < n; i++) {
    left[i] *= norm;
    right[i] *= norm;
  }
  return [left, right];
}

/** Renders the reference notes (every minor third, like the sample set) without blocking the page. */
export async function synthesizePiano(): Promise<Map<number, AudioBuffer>> {
  const out = new Map<number, AudioBuffer>();
  for (let midi = 21; midi <= 108; midi += 3) {
    const [l, r] = renderPianoNote(midi);
    const buf = new AudioBuffer({ length: l.length, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    out.set(midi, buf);
    await new Promise((res) => setTimeout(res, 0));
  }
  return out;
}
