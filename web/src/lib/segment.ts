/**
 * Splits a score into learning blocks (chunks of 1–8 measures).
 *
 * Automatic mode looks for musical phrase boundaries (section ends, repeats, double bars,
 * long notes / rests at the end of a measure, 2- and 4-bar regularity) and picks the segmentation
 * with dynamic programming, aiming at a block size that depends on how dense the music is.
 */
import { EPS, type Block, type Hand, type NoteEvent, type Score } from './model';

export type BlockSizeMode = 'auto' | 1 | 2 | 4 | 8;

/** Target number of notes (both hands) a beginner can comfortably learn in one go. */
const TARGET_NOTES = 26;

interface BoundaryInfo {
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

/** Median number of notes (both hands) per quarter note, over non-empty measures. */
function medianNotesPerQuarter(score: Score): number {
  const counts = new Array(score.measures.length).fill(0);
  for (const n of score.notes) if (n.hand && !n.grace) counts[n.measureIndex]++;
  const dens = counts
    .map((c, i) => (c > 0 ? c / Math.max(0.5, score.measures[i].length) : 0))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  if (!dens.length) return 1;
  return dens[Math.floor(dens.length / 2)];
}

/** Target block length in measures: about TARGET_NOTES notes, between 4 and 16 quarter notes. */
function targetMeasures(score: Score): number {
  const perQuarter = medianNotesPerQuarter(score);
  const quarters = Math.min(16, Math.max(4, TARGET_NOTES / Math.max(perQuarter, 0.1)));
  const lengths = score.measures.map((m) => m.nominalLength).sort((a, b) => a - b);
  const typical = lengths[Math.floor(lengths.length / 2)] || 4;
  return Math.min(8, Math.max(1, quarters / typical));
}

export function segmentBlocks(score: Score, mode: BlockSizeMode = 'auto'): Block[] {
  const M = score.measures.length;
  if (M === 0) return [];
  const bounds = measureBoundaries(score);
  const ranges: [number, number][] = mode === 'auto' ? autoRanges(score, bounds) : fixedRanges(bounds, mode);
  const blocks: Block[] = ranges.map(([a, b], index) => ({
    index,
    startMeasure: a,
    endMeasure: b,
    start: score.measures[a].start,
    end: score.measures[b].start + score.measures[b].length,
  }));
  markRepeats(score, blocks);
  return blocks;
}

function fixedRanges(bounds: BoundaryInfo[], size: number): [number, number][] {
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

function autoRanges(score: Score, bounds: BoundaryInfo[]): [number, number][] {
  const M = bounds.length;
  const target = targetMeasures(score);
  const maxLen = Math.min(8, Math.max(2, Math.round(target * 2)));
  const best = new Array<number>(M + 1).fill(Infinity);
  const from = new Array<number>(M + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= M; j++) {
    for (let len = 1; len <= maxLen && j - len >= 0; len++) {
      const i = j - len;
      if (!Number.isFinite(best[i])) continue;
      // no hard boundary inside the block
      let crossesHard = false;
      for (let k = i; k < j - 1; k++) if (bounds[k].hard) crossesHard = true;
      if (crossesHard) continue;
      const endB = bounds[j - 1];
      if (endB.forbidden) continue;
      // the pickup measure is not counted in the length
      const effLen = i === 0 && score.measures[0].implicit && len > 1 ? len - 1 : len;
      const lenCost = 4 * ((effLen - target) / target) ** 2;
      const endCost = Math.max(0, 3 - endB.strength);
      const cost = best[i] + lenCost + endCost + 0.3;
      if (cost < best[j]) {
        best[j] = cost;
        from[j] = i;
      }
    }
  }
  if (!Number.isFinite(best[M])) return fixedRanges(bounds, Math.max(1, Math.round(target)));
  const out: [number, number][] = [];
  let j = M;
  while (j > 0) {
    const i = from[j];
    out.push([i, j - 1]);
    j = i;
  }
  return out.reverse();
}

/** Signature tokens of a block: relative onset, pitch, duration, hand. */
function blockTokens(score: Score, b: Block): string[] {
  const tokens: string[] = [];
  for (const n of score.notes) {
    if (!n.hand || n.onset < b.start - EPS || n.onset >= b.end - EPS) continue;
    tokens.push(`${Math.round((n.onset - b.start) * 48)}:${n.midi}:${Math.round(Math.min(n.duration, b.end - n.onset) * 48)}:${n.hand}`);
  }
  return tokens.sort();
}

function markRepeats(score: Score, blocks: Block[]) {
  const sigs = blocks.map((b) => blockTokens(score, b));
  for (let i = 0; i < blocks.length; i++) {
    const a = sigs[i];
    if (!a.length) continue;
    let bestSim = 0;
    let bestJ = -1;
    for (let j = 0; j < i; j++) {
      if (blocks[j].repeatOf !== undefined) continue;
      const b = sigs[j];
      if (!b.length) continue;
      if (a.length === b.length && a.every((t, k) => t === b[k])) {
        blocks[i].repeatOf = j;
        bestJ = -1;
        break;
      }
      const sim = similarity(a, b);
      if (sim > bestSim) {
        bestSim = sim;
        bestJ = j;
      }
    }
    if (blocks[i].repeatOf === undefined && bestJ >= 0 && bestSim >= 0.7) {
      blocks[i].similarTo = bestJ;
      blocks[i].similarity = bestSim;
    }
  }
}

function similarity(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  return common / Math.max(a.length, b.length);
}

export function blockOfMeasure(blocks: Block[], measureIndex: number): Block | undefined {
  return blocks.find((b) => measureIndex >= b.startMeasure && measureIndex <= b.endMeasure);
}
