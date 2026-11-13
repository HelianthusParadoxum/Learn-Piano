/**
 * Phrase boundaries between measures (section ends, repeats, double bars, long notes or rests at
 * the end of a measure, 2- and 4-bar regularity) and fixed-size splitting. The automatic, pattern
 * aware segmentation lives in patterns.ts.
 */
import { EPS, type Block, type Hand, type NoteEvent, type Score } from './model';

export type BlockSizeMode = 'auto' | 1 | 2 | 4 | 8;

/** Target number of notes (both hands) a beginner can comfortably learn in one go. */
export const TARGET_NOTES = 26;

export interface BoundaryInfo {
  /** strength of the boundary after measure i (larger = better place to cut) */
  strength: number;
  /** a block must not continue across this boundary */
  hard: boolean;
  /** a block must not end here (pickup measure) */
  forbidden: boolean;
}

export function measureBoundaries(score: Score): BoundaryInfo[] {
  const { measures, notes } = score;
  const M = measures.length;
  const byMeasure: NoteEvent[][] = measures.map(() => []);
  for (const n of notes) if (n.hand) byMeasure[n.measureIndex]?.push(n);
  const melodyHand: Hand = notes.some((n) => n.hand === 'R') ? 'R' : 'L';

  const info: BoundaryInfo[] = [];
  let sectionStart = 0;
  for (let i = 0; i < M; i++) {
    const m = measures[i];
    const next = measures[i + 1];
    let s = 0;
    let hard = false;
    if (i === M - 1) {
      info.push({ strength: 10, hard: true, forbidden: false });
      continue;
    }
    // structural markers
    const style = m.barStyleRight || '';
    if (m.repeatBackward || next.repeatForward) {
      s += 4;
      hard = true;
    }
    if (/light-light|light-heavy|heavy-light|heavy-heavy/.test(style)) {
      s += 3.5;
      hard = true;
    }
    if (m.endingStop || next.endingStart) {
      s += 3;
      hard = true;
    }
    if (next.timeChange || next.keyChange || next.rehearsal) {
      s += 3;
      hard = true;
    }
    // phrase ending: long note or rest at the end of the measure in the melody
    const mel = byMeasure[i].filter((n) => n.hand === melodyHand && !n.grace);
    const measureEnd = m.start + m.length;
    if (mel.length) {
      const last = mel.reduce((a, b) => (b.onset > a.onset ? b : a));
      const lastEnd = Math.max(...mel.map((n) => n.onset + n.duration));
      if (last.duration >= Math.min(2, m.length * 0.5) - EPS) s += 1.5;
      else if (measureEnd - lastEnd >= 0.5 - EPS) s += 1.2;
      // note tied over the barline: bad place to cut
      if (mel.some((n) => n.onset + n.duration > measureEnd + EPS)) s -= 1;
    } else {
      s += 0.8;
    }
    const nextMel = byMeasure[i + 1].filter((n) => n.hand === melodyHand && !n.grace);
    if (nextMel.length && Math.min(...nextMel.map((n) => n.onset)) - next.start >= 0.5 - EPS) s += 0.4;
    // regular phrase lengths
    const offset = i + 1 - sectionStart;
    if (offset % 4 === 0) s += 1;
    else if (offset % 2 === 0) s += 0.5;
    // a pickup (anacrusis) always belongs to the following measure, even if a repeat sign follows it
    const forbidden = i === 0 && measures[0].implicit && M > 1;
    if (forbidden) hard = false;
    info.push({ strength: s, hard, forbidden });
    if (hard) sectionStart = i + 1;
  }
  return info;
}

export function fixedRanges(bounds: BoundaryInfo[], size: number): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  let len = 0;
  for (let i = 0; i < bounds.length; i++) {
    len++;
    const b = bounds[i];
    if (b.forbidden) {
      len--; // a pickup measure does not count
      continue;
    }
    if (len >= size || b.hard) {
      out.push([start, i]);
      start = i + 1;
      len = 0;
    }
  }
  if (start < bounds.length) out.push([start, bounds.length - 1]);
  return out;
}

export function blockOfMeasure(blocks: Block[], measureIndex: number): Block | undefined {
  return blocks.find((b) => measureIndex >= b.startMeasure && measureIndex <= b.endMeasure);
}
