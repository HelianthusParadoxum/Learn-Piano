/**
 * Pattern analysis.
 *
 * Finds fragments of the piece that come back — exactly, with small changes, or transposed — and
 * represents the piece as a sequence of pattern instances (A A′ B A′ …). A learner then studies each
 * pattern once and, for every variation, only what differs from the pattern's first appearance.
 *
 *  1. Similarity of two fragments of equal length is computed note by note: same hand, same position
 *     in the fragment (± 1/24 of a quarter), same pitch after the best transposition (chromatic, or
 *     along the scale for sequences). A note whose length differs counts ¾.
 *     Similarity = 2·matches / (notes in both fragments) (the Dice coefficient).
 *  2. Fragments are one pattern when they are at least `threshold` similar (80 % by default), or when
 *     one hand is identical and the whole is still close (a melody repeated over a new accompaniment).
 *  3. Segmentation: pairs of repeating fragments of a learnable size are chosen greedily (longer,
 *     closer and phrase-aligned pairs first) as anchors; the remaining measures are split at phrase
 *     boundaries by dynamic programming.
 *  4. Fragments are grouped into families; differences of each variation from the base are recorded.
 */
import { type Block, type BlockDiff, type GuideStep, type Hand, type NoteEvent, type PatternFamily, type Score } from './model';
import { fixedRanges, measureBoundaries, TARGET_NOTES, type BlockSizeMode, type BoundaryInfo } from './segment';

/** Onset grid: 1/24 of a quarter note (covers triplets and 32nd notes). */
const Q = 24;
const HANDS: Hand[] = ['R', 'L'];
const STEPS = 'CDEFGAB';

export interface WEvent {
  id: number;
  hand: Hand;
  /** onset from the start of the fragment, in 1/24 quarters */
  q: number;
  midi: number;
  /** diatonic position: octave·7 + step */
  dia: number;
  dur: number;
  /** measure offset inside the fragment */
  off: number;
}

export interface WindowMatch {
  sim: number;
  /** chromatic transposition in semitones (B = A + t) */
  t: number;
  /** diatonic transposition in scale steps (used instead of t for sequences) */
  steps: number;
  /** similarity per hand */
  hands: Record<Hand, number>;
  /** share of each fragment's notes played by each hand: [in A, in B] */
  share: Record<Hand, [number, number]>;
  /** matched notes: [index in A, index in B, quality 1 | 0.75] */
  pairs: [number, number, number][];
}

/** Notes of measures [i, i+L) as fragment events (cached). */
export class FragmentCache {
  private byMeasure: NoteEvent[][];
  private cache = new Map<string, WEvent[]>();

  constructor(private score: Score) {
    this.byMeasure = score.measures.map(() => []);
    for (const n of score.notes) if (n.hand && !n.grace) this.byMeasure[n.measureIndex]?.push(n);
  }

  events(i: number, L: number): WEvent[] {
    const key = `${i}|${L}`;
    let ev = this.cache.get(key);
    if (ev) return ev;
    ev = [];
    const start = this.score.measures[i].start;
    for (let k = i; k < i + L && k < this.byMeasure.length; k++) {
      for (const n of this.byMeasure[k]) {
        ev.push({
          id: n.id,
          hand: n.hand!,
          q: Math.round((n.onset - start) * Q),
          midi: n.midi,
          dia: n.octave * 7 + Math.max(0, STEPS.indexOf(n.step)),
          dur: n.duration,
          off: k - i,
        });
      }
    }
    this.cache.set(key, ev);
    return ev;
  }
}

function keyOf(hand: Hand, q: number) {
  return hand === 'R' ? q * 2 : q * 2 + 1;
}

/**
 * Matches the notes of two fragments: B = A shifted by `shift` semitones (chromatic) or by `shift`
 * scale steps (diatonic).
 */
export function matchWindows(A: WEvent[], B: WEvent[], shift: number, diatonic = false): WindowMatch {
  const index = new Map<number, number[]>();
  B.forEach((e, k) => {
    const key = keyOf(e.hand, e.q);
    const list = index.get(key);
    if (list) list.push(k);
    else index.set(key, [k]);
  });
  const usedB = new Uint8Array(B.length);
  const score: Record<Hand, number> = { R: 0, L: 0 };
  const pairs: [number, number, number][] = [];
  for (let a = 0; a < A.length; a++) {
    const ea = A[a];
    let found = -1;
    for (const dq of [0, -1, 1]) {
      const list = index.get(keyOf(ea.hand, ea.q + dq));
      if (!list) continue;
      for (const k of list) {
        const ok = diatonic ? B[k].dia === ea.dia + shift : B[k].midi === ea.midi + shift;
        if (!usedB[k] && ok) {
          found = k;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) continue;
    usedB[found] = 1;
    const eb = B[found];
    const quality = Math.abs(ea.dur - eb.dur) <= 0.25 * Math.max(ea.dur, eb.dur) + 1e-6 ? 1 : 0.75;
    score[ea.hand] += quality;
    pairs.push([a, found, quality]);
  }
  const countA: Record<Hand, number> = { R: 0, L: 0 };
  const countB: Record<Hand, number> = { R: 0, L: 0 };
  for (const e of A) countA[e.hand]++;
  for (const e of B) countB[e.hand]++;
  const total = A.length + B.length;
  const hands = {} as Record<Hand, number>;
  const share = {} as Record<Hand, [number, number]>;
  for (const h of HANDS) {
    const n = countA[h] + countB[h];
    hands[h] = n === 0 ? 1 : (2 * score[h]) / n;
    share[h] = [A.length ? countA[h] / A.length : 0, B.length ? countB[h] / B.length : 0];
  }
  return {
    sim: total ? (2 * (score.R + score.L)) / total : 1,
    t: diatonic ? 0 : shift,
    steps: diatonic ? shift : 0,
    hands,
    share,
    pairs,
  };
}

function topShifts(A: WEvent[], B: WEvent[], diatonic: boolean): number[] {
  const at = new Map<number, number[]>();
  for (const e of B) {
    const key = keyOf(e.hand, e.q);
    const list = at.get(key);
    const v = diatonic ? e.dia : e.midi;
    if (list) list.push(v);
    else at.set(key, [v]);
  }
  const hist = new Map<number, number>();
  for (const a of A) {
    for (const v of at.get(keyOf(a.hand, a.q)) ?? []) {
      const d = v - (diatonic ? a.dia : a.midi);
      if (d !== 0 && Math.abs(d) <= (diatonic ? 7 : 12)) hist.set(d, (hist.get(d) ?? 0) + 1);
    }
  }
  const minVotes = Math.max(3, 0.3 * Math.min(A.length, B.length));
  return Array.from(hist.entries())
    .filter(([, c]) => c >= minVotes)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 2)
    .map(([d]) => d);
}

/** Best match over a few candidate transpositions (the most common pitch shifts between the fragments). */
export function bestMatch(A: WEvent[], B: WEvent[]): WindowMatch {
  const plain = matchWindows(A, B, 0);
  if (plain.sim > 0.999 || !A.length || !B.length) return plain;
  let best = plain;
  for (const t of topShifts(A, B, false)) {
    const m = matchWindows(A, B, t);
    if (m.sim >= best.sim + 0.1) best = m;
  }
  for (const d of topShifts(A, B, true)) {
    const m = matchWindows(A, B, d, true);
    if (m.sim >= best.sim + 0.1) best = m;
  }
  return best;
}

/** Do two fragments belong to the same pattern? */
export function isFamilyMatch(m: WindowMatch, threshold: number): boolean {
  if (m.sim >= threshold) return true;
  // the same melody (or bass) over a changed other hand
  for (const h of HANDS) {
    const [sa, sb] = m.share[h];
    if (m.hands[h] >= 0.95 && sa >= 0.4 && sb >= 0.4 && m.sim >= threshold - 0.2) return true;
  }
  return false;
}

const MIN_NOTES = 3;
const LEN_COST = [0, 0.4, 0, 0.35, 0, 0.7, 0.3, 0.8, 0.1];

interface Segmenter {
  M: number;
  valid(i: number, L: number): boolean;
  notes(i: number, L: number): number;
}

/** Splits measures [from, to] at phrase boundaries (dynamic programming). Null if impossible. */
function phraseFill(seg: Segmenter, bounds: BoundaryInfo[], from: number, to: number, pickup: boolean): [number, number][] | null {
  const n = to - from + 1;
  const best = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let L = 1; L <= 8 && j - L >= 0; L++) {
      const i = j - L;
      if (!Number.isFinite(best[i]) || !seg.valid(from + i, L)) continue;
      const notes = seg.notes(from + i, L);
      const effL = from + i === 0 && pickup && L > 1 ? L - 1 : L;
      const sizeCost = notes === 0 ? 1 : 2.5 * ((notes - TARGET_NOTES) / TARGET_NOTES) ** 2;
      const lenCost = LEN_COST[Math.min(effL, 8)] ?? 1;
      const endCost = 0.6 * Math.max(0, 3 - bounds[from + j - 1].strength);
      const cost = best[i] + sizeCost + lenCost + endCost + 0.4;
      if (cost < best[j]) {
        best[j] = cost;
        prev[j] = i;
      }
    }
  }
  if (!Number.isFinite(best[n])) return null;
  const out: [number, number][] = [];
  for (let j = n; j > 0; j = prev[j]) out.push([from + prev[j], from + j - 1]);
  return out.reverse();
}

/** Cuts the piece into fragments that line up with its repetitions. */
function patternRanges(score: Score, cache: FragmentCache, bounds: BoundaryInfo[], threshold: number): [number, number][] {
  const M = bounds.length;
  const maxL = Math.min(8, M);
  const pickup = !!score.measures[0]?.implicit && M > 1;
  const hardPrefix = [0];
  for (let k = 0; k < M; k++) hardPrefix.push(hardPrefix[k] + (bounds[k].hard ? 1 : 0));
  const seg: Segmenter = {
    M,
    valid: (i, L) => i >= 0 && i + L <= M && hardPrefix[i + L - 1] - hardPrefix[i] === 0 && !bounds[i + L - 1].forbidden,
    notes: (i, L) => cache.events(i, L).length,
  };
  const startStrength = (i: number) => (i === 0 ? 3 : bounds[i - 1].strength);
  const minNotes = Math.max(MIN_NOTES, Math.round(TARGET_NOTES * 0.6));
  const maxNotes = Math.round(TARGET_NOTES * 2.2);

  // 1. repeating pairs of learnable size
  const pairs: { i: number; j: number; L: number; value: number }[] = [];
  for (let L = 1; L <= maxL; L++) {
    for (let i = 0; i + L <= M; i++) {
      if (!seg.valid(i, L)) continue;
      const ni = seg.notes(i, L);
      if (ni < minNotes || ni > maxNotes) continue;
      for (let j = i + L; j + L <= M; j++) {
        if (!seg.valid(j, L)) continue;
        const nj = seg.notes(j, L);
        if (nj < minNotes || nj > maxNotes) continue;
        const m = bestMatch(cache.events(i, L), cache.events(j, L));
        if (!isFamilyMatch(m, threshold)) continue;
        const fit = 1 - Math.min(1, Math.abs((ni + nj) / 2 - TARGET_NOTES) / TARGET_NOTES);
        const phrase = startStrength(i) + startStrength(j) + bounds[i + L - 1].strength + bounds[j + L - 1].strength;
        const exact = m.sim > 0.999 && m.t === 0 && m.steps === 0 ? 0.5 : 0;
        pairs.push({ i, j, L, value: L * m.sim * fit + 0.5 * Math.min(phrase, 14) + exact });
      }
    }
  }
  pairs.sort((a, b) => b.value - a.value);

  // 2. accept non-overlapping anchors greedily
  const owner = new Int32Array(M).fill(-1); // start of the anchor covering each measure
  const anchorLen = new Map<number, number>();
  const freeOrSame = (i: number, L: number) => {
    if (anchorLen.get(i) === L) return true;
    for (let k = i; k < i + L; k++) if (owner[k] >= 0) return false;
    return true;
  };
  const take = (i: number, L: number) => {
    if (anchorLen.get(i) === L) return;
    anchorLen.set(i, L);
    for (let k = i; k < i + L; k++) owner[k] = i;
  };
  for (const p of pairs) {
    if (freeOrSame(p.i, p.L) && freeOrSame(p.j, p.L)) {
      take(p.i, p.L);
      take(p.j, p.L);
    }
  }

  // 3. fill the gaps between anchors at phrase boundaries
  const out: [number, number][] = [];
  let k = 0;
  while (k < M) {
    if (owner[k] >= 0) {
      const L = anchorLen.get(k)!;
      out.push([k, k + L - 1]);
      k += L;
      continue;
    }
    let end = k;
    while (end + 1 < M && owner[end + 1] < 0) end++;
    const filled = phraseFill(seg, bounds, k, end, pickup);
    if (filled) out.push(...filled);
    else if (k === 0 && end === 0 && out.length === 0 && M > 1) {
      // a lone pickup measure: attach it to the following fragment
      const nextL = anchorLen.get(1);
      if (nextL) {
        anchorLen.delete(1);
        out.push([0, nextL]);
        k = nextL + 1;
        continue;
      }
      out.push([0, 0]);
    } else out.push(...fixedRanges(bounds.slice(k, end + 1), 4).map(([a, b]) => [a + k, b + k] as [number, number]));
    k = end + 1;
  }
  return out;
}

export function letterFor(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const PRIMES = ['', '′', '″', '‴'];
function variantLabel(letter: string, n: number) {
  return n < PRIMES.length ? letter + PRIMES[n] : `${letter}${n}`;
}

function diffOf(base: WEvent[], other: WEvent[], m: WindowMatch, measures: number): BlockDiff {
  const matchedBase = new Set(m.pairs.map((p) => p[0]));
  const matchedOther = new Set(m.pairs.map((p) => p[1]));
  const changed: number[] = [];
  const rhythm: number[] = [];
  const baseUnmatched: number[] = [];
  const perMeasure = Array.from({ length: measures }, (_, offset) => ({ offset, changed: 0, missing: 0, rhythm: 0 }));
  other.forEach((e, k) => {
    if (!matchedOther.has(k)) {
      changed.push(e.id);
      if (perMeasure[e.off]) perMeasure[e.off].changed++;
    }
  });
  for (const [, k, quality] of m.pairs) {
    if (quality < 1) {
      rhythm.push(other[k].id);
      if (perMeasure[other[k].off]) perMeasure[other[k].off].rhythm++;
    }
  }
  base.forEach((e, k) => {
    if (!matchedBase.has(k)) {
      baseUnmatched.push(e.id);
      if (perMeasure[e.off]) perMeasure[e.off].missing++;
    }
  });
  return { changed, rhythm, baseUnmatched, measures: perMeasure, hands: m.hands };
}

export interface PatternStructure {
  blocks: Block[];
  families: PatternFamily[];
}

/** Splits the piece into fragments and groups them into pattern families. */
export function analyzePatterns(score: Score, mode: BlockSizeMode = 'auto', threshold = 0.8): PatternStructure {
  const M = score.measures.length;
  if (M === 0) return { blocks: [], families: [] };
  const cache = new FragmentCache(score);
  const bounds = measureBoundaries(score);
  const ranges = mode === 'auto' ? patternRanges(score, cache, bounds, threshold) : fixedRanges(bounds, mode);
  const blocks: Block[] = ranges.map(([a, b], index) => ({
    index,
    startMeasure: a,
    endMeasure: b,
    start: score.measures[a].start,
    end: score.measures[b].start + score.measures[b].length,
    family: -1,
    label: '',
    role: 'base',
    similarity: 1,
    transpose: 0,
  }));

  // a pickup measure belongs to the first fragment but is not part of its pattern
  const pickup = !!score.measures[0]?.implicit && M > 1;
  for (const b of blocks) b.coreStart = pickup && b.startMeasure === 0 && b.endMeasure > 0 ? 1 : b.startMeasure;
  const families: PatternFamily[] = [];
  const len = (b: Block) => b.endMeasure - (b.coreStart ?? b.startMeasure) + 1;
  const ev = (b: Block) => cache.events(b.coreStart ?? b.startMeasure, len(b));
  const variantCount = new Map<number, number>();

  for (const b of blocks) {
    const mine = ev(b);
    let bestFamily: PatternFamily | null = null;
    let bestM: WindowMatch | null = null;
    if (mine.length >= MIN_NOTES) {
      for (const f of families) {
        const base = blocks[f.base];
        if (len(base) !== len(b) || ev(base).length < MIN_NOTES) continue;
        const m = bestMatch(ev(base), mine);
        if (isFamilyMatch(m, threshold) && (!bestM || m.sim > bestM.sim)) {
          bestM = m;
          bestFamily = f;
        }
      }
    }
    if (!bestFamily || !bestM) {
      const f: PatternFamily = { index: families.length, letter: letterFor(families.length), base: b.index, blocks: [b.index] };
      families.push(f);
      b.family = f.index;
      b.label = f.letter;
      continue;
    }
    const f = bestFamily;
    const base = blocks[f.base];
    f.blocks.push(b.index);
    b.family = f.index;
    b.similarity = bestM.sim;
    b.transpose = bestM.t;
    if (bestM.steps) b.steps = bestM.steps;
    if (bestM.sim > 0.999 && bestM.t === 0 && bestM.steps === 0) {
      b.role = 'repeat';
      b.repeatOf = base.index;
      b.label = f.letter;
      continue;
    }
    b.diff = diffOf(ev(base), mine, bestM, len(b));
    // identical to an earlier variation of the same pattern?
    const same = f.blocks
      .slice(0, -1)
      .map((k) => blocks[k])
      .find((v) => v.role === 'variation' && matchWindows(ev(v), mine, 0).sim > 0.999);
    if (same) {
      b.role = 'repeat';
      b.repeatOf = same.index;
      b.label = same.label;
      continue;
    }
    const n = (variantCount.get(f.index) ?? 0) + 1;
    variantCount.set(f.index, n);
    b.role = 'variation';
    b.label = variantLabel(f.letter, n);
  }
  return { blocks, families };
}

/**
 * Pairs of equal notes (same position, pitch and length) between each block and the base of its
 * family — used to give every appearance of a pattern the same fingering.
 */
export function equalNotePairs(score: Score, blocks: Block[], families: PatternFamily[]): [number, number][] {
  const cache = new FragmentCache(score);
  const out: [number, number][] = [];
  for (const f of families) {
    const base = blocks[f.base];
    const baseStart = base.coreStart ?? base.startMeasure;
    const L = base.endMeasure - baseStart + 1;
    const baseEv = cache.events(baseStart, L);
    for (const k of f.blocks) {
      const b = blocks[k];
      if (k === f.base || b.transpose !== 0 || b.steps) continue;
      const evB = cache.events(b.coreStart ?? b.startMeasure, L);
      const m = matchWindows(baseEv, evB, 0);
      for (const [a, c, quality] of m.pairs) if (quality === 1) out.push([baseEv[a].id, evB[c].id]);
    }
  }
  return out;
}

/** Learning order: each pattern, then its variations; then fragments joined together; then the whole piece. */
export function buildSteps(score: Score, blocks: Block[], families: PatternFamily[]): GuideStep[] {
  const steps: GuideStep[] = [];
  for (const f of families) {
    steps.push({ kind: 'pattern', block: f.base });
    for (const k of f.blocks) if (blocks[k].role === 'variation') steps.push({ kind: 'variation', block: k });
  }
  if (blocks.length >= 2) {
    const bounds = measureBoundaries(score);
    let groupStart = 0;
    let measures = 0;
    const groups: [number, number][] = [];
    blocks.forEach((b, k) => {
      measures += b.endMeasure - b.startMeasure + 1;
      const sectionEnd = bounds[b.endMeasure]?.hard;
      if (measures >= 6 || sectionEnd || k === blocks.length - 1) {
        groups.push([groupStart, k]);
        groupStart = k + 1;
        measures = 0;
      }
    });
    const multi = groups.filter(([a, b]) => b > a);
    const coversAll = multi.length === 1 && multi[0][0] === 0 && multi[0][1] === blocks.length - 1;
    if (!coversAll) for (const [a, b] of multi) steps.push({ kind: 'assemble', fromBlock: a, toBlock: b, whole: false });
    steps.push({ kind: 'assemble', fromBlock: 0, toBlock: blocks.length - 1, whole: true });
  }
  return steps;
}

/** The step where a block is learned (repeats lead to what they repeat). */
export function stepOfBlock(steps: GuideStep[], blocks: Block[], blockIndex: number): number {
  let b = blocks[blockIndex];
  for (let guard = 0; b?.role === 'repeat' && b.repeatOf !== undefined && guard < 100; guard++) b = blocks[b.repeatOf];
  const idx = steps.findIndex((s) => s.kind !== 'assemble' && s.block === b?.index);
  return idx >= 0 ? idx : 0;
}
