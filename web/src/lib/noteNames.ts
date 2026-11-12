export type NameStyle = 'solfege' | 'latin';

const SOLFEGE: Record<string, string> = { C: 'до', D: 'ре', E: 'ми', F: 'фа', G: 'соль', A: 'ля', B: 'си' };
const SHARP_NAMES = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const SHARP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const FLAT_NAMES = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'];
const FLAT_ALTER = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];

const OCTAVES_RU = [
  'субконтроктавы', 'контроктавы', 'большой октавы', 'малой октавы', 'первой октавы',
  'второй октавы', 'третьей октавы', 'четвёртой октавы', 'пятой октавы',
];

export function accidentalSign(alter: number): string {
  if (alter >= 2) return '𝄪';
  if (alter === 1) return '♯';
  if (alter === -1) return '♭';
  if (alter <= -2) return '𝄫';
  return '';
}

export function stepName(step: string, alter: number, style: NameStyle): string {
  const base = style === 'solfege' ? SOLFEGE[step] ?? step : step;
  return base + accidentalSign(alter);
}

export function noteLabel(n: { step: string; alter: number; octave: number }, style: NameStyle): string {
  return style === 'solfege' ? stepName(n.step, n.alter, style) : `${stepName(n.step, n.alter, style)}${n.octave}`;
}

/** Spelling for a bare MIDI number (keyboard labels). */
export function midiSpelling(midi: number, preferFlats = false): { step: string; alter: number; octave: number } {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return preferFlats
    ? { step: FLAT_NAMES[pc], alter: FLAT_ALTER[pc], octave }
    : { step: SHARP_NAMES[pc], alter: SHARP_ALTER[pc], octave };
}

export function midiLabel(midi: number, style: NameStyle, preferFlats = false): string {
  return noteLabel(midiSpelling(midi, preferFlats), style);
}

export function octaveNameRu(octave: number): string {
  return OCTAVES_RU[octave] ?? `${octave}-й октавы`;
}

/** "соль первой октавы (G4)" */
export function fullNoteName(n: { step: string; alter: number; octave: number }): string {
  return `${stepName(n.step, n.alter, 'solfege')} ${octaveNameRu(n.octave)} (${n.step}${n.alter > 0 ? '#' : n.alter < 0 ? 'b' : ''}${n.octave})`;
}

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

export function keySignatureAccidentals(fifths: number): { step: string; alter: number }[] {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).map((step) => ({ step, alter: 1 }));
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).map((step) => ({ step, alter: -1 }));
  return [];
}

const MAJOR_KEYS = ['до', 'соль', 'ре', 'ля', 'ми', 'си', 'фа♯', 'до♯'];
const MAJOR_FLAT_KEYS = ['до', 'фа', 'си♭', 'ми♭', 'ля♭', 'ре♭', 'соль♭', 'до♭'];
const MINOR_KEYS = ['ля', 'ми', 'си', 'фа♯', 'до♯', 'соль♯', 'ре♯', 'ля♯'];
const MINOR_FLAT_KEYS = ['ля', 'ре', 'соль', 'до', 'фа', 'си♭', 'ми♭', 'ля♭'];

export function keyName(fifths: number): string {
  const f = Math.max(-7, Math.min(7, fifths));
  const major = f >= 0 ? MAJOR_KEYS[f] : MAJOR_FLAT_KEYS[-f];
  const minor = f >= 0 ? MINOR_KEYS[f] : MINOR_FLAT_KEYS[-f];
  return `${major} мажор / ${minor} минор`;
}

export const FINGER_NAMES = ['', 'большой', 'указательный', 'средний', 'безымянный', 'мизинец'];

const INTERVALS_NOM = [
  'прима', 'малая секунда', 'большая секунда', 'малая терция', 'большая терция', 'кварта', 'тритон',
  'квинта', 'малая секста', 'большая секста', 'малая септима', 'большая септима', 'октава',
];
const INTERVALS_ACC = [
  'приму', 'малую секунду', 'большую секунду', 'малую терцию', 'большую терцию', 'кварту', 'тритон',
  'квинту', 'малую сексту', 'большую сексту', 'малую септиму', 'большую септиму', 'октаву',
];

/** Interval name; `accusative` gives the form used after «на» («скачок на октаву»). */
export function intervalName(semitones: number, accusative = false): string {
  const s = Math.abs(semitones);
  const names = accusative ? INTERVALS_ACC : INTERVALS_NOM;
  if (s <= 12) return names[s];
  if (s < 24) return `${names[s - 12]} через октаву`;
  if (s === 24) return 'две октавы';
  const oct = Math.floor(s / 12);
  return `${oct} ${oct < 5 ? 'октавы' : 'октав'}`;
}
