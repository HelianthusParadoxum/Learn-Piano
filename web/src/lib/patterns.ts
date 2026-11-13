/**
 * Pattern analysis, separately for each hand.
 *
 * The right and the left hand are analysed independently. A melody that comes back over a new
 * accompaniment is the same right-hand pattern; an accompaniment figure that repeats under a changing
 * melody is the same left-hand pattern. Each hand's patterns are learned once, then the hands are put
 * together — far fewer things to learn than when both hands have to repeat at the same time.
 *
 *  1. Similarity of two fragments of one hand (equal number of measures) is computed note by note:
 *     same position in the fragment (± 1/24 of a quarter), same pitch after the best transposition
 *     (chromatic, or along the scale for sequences). A note whose length differs counts ¾.
 *     Similarity = 2·matches / (notes in both fragments) (the Dice coefficient).
 *  2. Fragments are one pattern when they are at least `threshold` similar (80 % by default).
 *  3. Segmentation of each hand: pairs of repeating fragments of a learnable size are chosen greedily
 *     (longer, closer and phrase-aligned pairs first) as anchors; the remaining measures are split at
 *     phrase boundaries by dynamic programming. Long silences of a hand are not fragments.
 *  4. Families per hand — right hand A, B, C…, left hand a, b, c…; differences of each variation from
 *     the base are recorded.
 *  5. Hands together: the piece is cut into chunks whose boundaries coincide with the fragments of both
 *     hands where possible; identical chunks are learned once. Long pieces are learned part by part.
 */
import { type Block, type BlockDiff, type GuideStep, type Hand, type NoteEvent, type PatternFamily, type Score } from './model';
import { fixedRanges, measureBoundaries, type BlockSizeMode, type BoundaryInfo } from './segment';

/** Onset grid: 1/24 of a quarter note (covers triplets and 32nd notes). */
const Q = 24;
export const HANDS: Hand[] = ['R', 'L'];
const STEPS = 'CDEFGAB';

/** Size of a fragment that one hand learns in one go, in note onsets (a chord counts once). */
export const HAND_TARGET = 14;
/** Size of a chunk played with both hands together (onsets of both hands): each hand already knows its part. */
export const TOGETHER_TARGET = 30;
/** Parts up to this length are joined in one go, longer ones through groups of about 8 measures. */
const SHORT_PART = 20;
/** Pieces longer than this are learned part by part. */
const PART_MIN_PIECE = 24;

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
  /** matched notes: [index in A, index in B, quality 1 | 0.75] */
  pairs: [number, number, number][];
}

/** Notes of measures [i, i+L) as fragment events (cached); only one hand's notes if `hand` is given. */
export class FragmentCache {
  private byMeasure: NoteEvent[][];
  private cache = new Map<string, WEvent[]>();
  private sizes = new Map<string, number>();

  constructor(
    private score: Score,
    readonly hand: Hand | null = null,
  ) {
    this.byMeasure = score.measures.map(() => []);
    for (const n of score.notes) if (n.hand && !n.grace && (!hand || n.hand === hand)) this.byMeasure[n.measureIndex]?.push(n);
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

  /** Learning size of measures [i, i+L): distinct onsets of each hand (a chord counts once). */
  size(i: number, L: number): number {
    const key = `${i}|${L}`;
    let n = this.sizes.get(key);
    if (n === undefined) {
      n = new Set(this.events(i, L).map((e) => keyOf(e.hand, e.q))).size;
      this.sizes.set(key, n);
    }
    return n;
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
  let score = 0;
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
    score += quality;
    pairs.push([a, found, quality]);
  }
  const total = A.length + B.length;
  return { sim: total ? (2 * score) / total : 1, t: diatonic ? 0 : shift, steps: diatonic ? shift : 0, pairs };
}

/** The most common pitch shifts between notes at the same place of two fragments. */
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

const MIN_NOTES = 3;
const LEN_COST = [0, 0.4, 0, 0.35, 0, 0.7, 0.3, 0.8, 0.1];

interface Segmenter {
  /** preferred fragment size (onsets) */
  target: number;
  valid(i: number, L: number): boolean;
  size(i: number, L: number): number;
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
      const size = seg.size(from + i, L);
      const effL = from + i === 0 && pickup && L > 1 ? L - 1 : L;
      const sizeCost = size === 0 ? 1 : 2.5 * ((size - seg.target) / seg.target) ** 2;
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

function prefixCount(M: number, flag: (k: number) => boolean): number[] {
  const p = [0];
  for (let k = 0; k < M; k++) p.push(p[k] + (flag(k) ? 1 : 0));
  return p;
}

interface HandRange {
  a: number;
  b: number;
  /** the hand is silent here: not a fragment to learn */
  rest?: boolean;
}

/** Measures where the hand is silent for a while (at the start or end of the piece, or for 2+ measures). */
function silentMeasures(cache: FragmentCache, M: number): Uint8Array {
  const silent = new Uint8Array(M);
  for (let k = 0; k < M; ) {
    if (cache.size(k, 1) > 0) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < M && cache.size(e + 1, 1) === 0) e++;
    if (k === 0 || e === M - 1 || e - k + 1 >= 2) for (let x = k; x <= e; x++) silent[x] = 1;
    k = e + 1;
  }
  return silent;
}

/** Cuts one hand's part into fragments that line up with its repetitions. */
function handRanges(score: Score, cache: FragmentCache, bounds: BoundaryInfo[], threshold: number): HandRange[] {
  const M = bounds.length;
  const maxL = Math.min(8, M);
  const pickup = !!score.measures[0]?.implicit && M > 1;
  const silent = silentMeasures(cache, M);
  const hardPrefix = prefixCount(M, (k) => bounds[k].hard);
  const silentPrefix = prefixCount(M, (k) => silent[k] === 1);
  const seg: Segmenter = {
    target: HAND_TARGET,
    valid: (i, L) =>
      i >= 0 &&
      i + L <= M &&
      hardPrefix[i + L - 1] - hardPrefix[i] === 0 &&
      !bounds[i + L - 1].forbidden &&
      silentPrefix[i + L] - silentPrefix[i] === 0,
    size: (i, L) => cache.size(i, L),
  };
  const startStrength = (i: number) => (i === 0 ? 3 : bounds[i - 1].strength);
  const minSize = Math.max(MIN_NOTES, Math.round(HAND_TARGET * 0.4));
  const maxSize = Math.round(HAND_TARGET * 2.2);

  // 1. repeating pairs of learnable size
  const pairs: { i: number; j: number; L: number; value: number }[] = [];
  for (let L = 1; L <= maxL; L++) {
    for (let i = 0; i + L <= M; i++) {
      if (!seg.valid(i, L)) continue;
      const si = seg.size(i, L);
      // a sparse hand (whole notes, chords) still has phrase-long fragments
      if (si < MIN_NOTES || (si < minSize && L < 4) || si > maxSize) continue;
      const A = cache.events(i, L);
      for (let j = i + L; j + L <= M; j++) {
        if (!seg.valid(j, L)) continue;
        const sj = seg.size(j, L);
        if (sj < MIN_NOTES || (sj < minSize && L < 4) || sj > maxSize) continue;
        const B = cache.events(j, L);
        // the Dice coefficient cannot exceed 2·min/(sum): skip hopeless pairs early
        if ((2 * Math.min(A.length, B.length)) / (A.length + B.length) < threshold) continue;
        const m = bestMatch(A, B);
        if (m.sim < threshold) continue;
        const fit = 1 - Math.min(1, Math.abs((si + sj) / 2 - HAND_TARGET) / HAND_TARGET);
        const phrase = startStrength(i) + startStrength(j) + bounds[i + L - 1].strength + bounds[j + L - 1].strength;
        const exact = m.sim > 0.999 && m.t === 0 && m.steps === 0 ? 0.5 : 0;
        // irregular lengths (3, 5, 7 measures) are rarely phrases
        const effL = i === 0 && pickup && L > 1 ? L - 1 : L;
        const irregular = 1.5 * (LEN_COST[Math.min(effL, 8)] ?? 1);
        pairs.push({ i, j, L, value: L * m.sim * fit + 0.5 * Math.min(phrase, 14) + exact - irregular });
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

  // 3. silences stay out; the gaps between anchors are split at phrase boundaries
  const out: HandRange[] = [];
  let k = 0;
  while (k < M) {
    if (silent[k]) {
      let e = k;
      while (e + 1 < M && silent[e + 1]) e++;
      out.push({ a: k, b: e, rest: true });
      k = e + 1;
      continue;
    }
    if (owner[k] >= 0) {
      const L = anchorLen.get(k)!;
      out.push({ a: k, b: k + L - 1 });
      k += L;
      continue;
    }
    let end = k;
    while (end + 1 < M && owner[end + 1] < 0 && !silent[end + 1]) end++;
    const filled = phraseFill(seg, bounds, k, end, pickup);
    if (filled) out.push(...filled.map(([a, b]) => ({ a, b })));
    else if (k === 0 && end === 0 && out.length === 0 && M > 1) {
      // a lone pickup measure: attach it to the following fragment
      const nextL = anchorLen.get(1);
      if (nextL) {
        anchorLen.delete(1);
        out.push({ a: 0, b: nextL });
        k = nextL + 1;
        continue;
      }
      out.push({ a: 0, b: 0 });
    } else out.push(...fixedRanges(bounds.slice(k, end + 1), 4).map(([a, b]) => ({ a: a + k, b: b + k })));
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

/** Pattern letter: right hand A, B, C…; left hand a, b, c… */
export function patternLetter(hand: Hand, i: number): string {
  return hand === 'R' ? letterFor(i) : letterFor(i).toLowerCase();
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
  return { changed, rhythm, baseUnmatched, measures: perMeasure };
}

export interface PatternStructure {
  /** fragments of both hands: first the right hand's in order, then the left hand's */
  blocks: Block[];
  families: PatternFamily[];
}

const coreLen = (b: Block) => b.endMeasure - (b.coreStart ?? b.startMeasure) + 1;

/** Fragments and pattern families of one hand (appended to `blocks` and `families`). */
function analyzeHand(
  score: Score,
  hand: Hand,
  mode: BlockSizeMode,
  threshold: number,
  bounds: BoundaryInfo[],
  blocks: Block[],
  families: PatternFamily[],
) {
  const M = score.measures.length;
  const cache = new FragmentCache(score, hand);
  if (cache.size(0, M) === 0) return;
  const ranges: HandRange[] =
    mode === 'auto'
      ? handRanges(score, cache, bounds, threshold)
      : fixedRanges(bounds, mode).map(([a, b]) => ({ a, b, rest: cache.size(a, b - a + 1) === 0 }));

  // a pickup measure belongs to the first fragment but is not part of its pattern
  const pickup = !!score.measures[0]?.implicit && M > 1;
  const mine: Block[] = [];
  for (const r of ranges) {
    if (r.rest) continue;
    const b: Block = {
      index: blocks.length,
      hand,
      startMeasure: r.a,
      endMeasure: r.b,
      start: score.measures[r.a].start,
      end: score.measures[r.b].start + score.measures[r.b].length,
      coreStart: pickup && r.a === 0 && r.b > 0 ? 1 : r.a,
      family: -1,
      label: '',
      role: 'base',
      similarity: 1,
      transpose: 0,
    };
    blocks.push(b);
    mine.push(b);
  }

  const handFamilies: PatternFamily[] = [];
  const ev = (b: Block) => cache.events(b.coreStart ?? b.startMeasure, coreLen(b));
  const variantCount = new Map<number, number>();
  for (const b of mine) {
    const notes = ev(b);
    let bestFamily: PatternFamily | null = null;
    let bestM: WindowMatch | null = null;
    if (notes.length >= MIN_NOTES) {
      for (const f of handFamilies) {
        const base = blocks[f.base];
        if (coreLen(base) !== coreLen(b) || ev(base).length < MIN_NOTES) continue;
        const m = bestMatch(ev(base), notes);
        if (m.sim >= threshold && (!bestM || m.sim > bestM.sim)) {
          bestM = m;
          bestFamily = f;
        }
      }
    }
    if (!bestFamily || !bestM) {
      const f: PatternFamily = {
        index: families.length,
        hand,
        letter: patternLetter(hand, handFamilies.length),
        base: b.index,
        blocks: [b.index],
      };
      families.push(f);
      handFamilies.push(f);
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
    if (bestM.sim > 0.999) {
      // the same notes, possibly from another note (a sequence)
      b.role = 'repeat';
      b.repeatOf = base.index;
      b.label = f.letter;
      continue;
    }
    b.diff = diffOf(ev(base), notes, bestM, coreLen(b));
    // identical (possibly transposed) to an earlier variation of the same pattern?
    let same: Block | undefined;
    let sameM: WindowMatch | undefined;
    for (const k of f.blocks.slice(0, -1)) {
      const v = blocks[k];
      if (v.role !== 'variation' || coreLen(v) !== coreLen(b)) continue;
      const m = bestMatch(ev(v), notes);
      if (m.sim > 0.999) {
        same = v;
        sameM = m;
        break;
      }
    }
    if (same && sameM) {
      b.role = 'repeat';
      b.repeatOf = same.index;
      b.label = same.label;
      b.transpose = sameM.t;
      b.steps = sameM.steps || undefined;
      continue;
    }
    const n = (variantCount.get(f.index) ?? 0) + 1;
    variantCount.set(f.index, n);
    b.role = 'variation';
    b.label = variantLabel(f.letter, n);
  }

  // a sequence: transposed copies right after a fragment are learned together with it
  for (let k = 0; k < mine.length; k++) {
    const first = mine[k];
    if (first.role === 'repeat') continue;
    let end = k;
    while (
      end + 1 < mine.length &&
      mine[end + 1].role === 'repeat' &&
      mine[end + 1].family === first.family &&
      (mine[end + 1].transpose !== 0 || !!mine[end + 1].steps) &&
      mine[end + 1].startMeasure === mine[end].endMeasure + 1
    ) {
      end++;
      mine[end].sequenceOf = first.index;
    }
    if (end > k) first.sequenceEnd = mine[end].index;
  }
}

/** Splits each hand's part into fragments and groups them into pattern families. */
export function analyzePatterns(score: Score, mode: BlockSizeMode = 'auto', threshold = 0.8): PatternStructure {
  const blocks: Block[] = [];
  const families: PatternFamily[] = [];
  if (score.measures.length === 0) return { blocks, families };
  const bounds = measureBoundaries(score);
  for (const hand of HANDS) analyzeHand(score, hand, mode, threshold, bounds, blocks, families);
  return { blocks, families };
}

/**
 * Pairs of equal notes (same position, pitch and length) between each block and the base of its
 * family — used to give every appearance of a pattern the same fingering.
 */
export function equalNotePairs(score: Score, blocks: Block[], families: PatternFamily[]): [number, number][] {
  const caches = new Map<Hand, FragmentCache>();
  const out: [number, number][] = [];
  for (const f of families) {
    let cache = caches.get(f.hand);
    if (!cache) caches.set(f.hand, (cache = new FragmentCache(score, f.hand)));
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

/** A stretch played with both hands; identical stretches are learned once (`repeatOf`). */
export interface Chunk {
  startMeasure: number;
  endMeasure: number;
  /** index of an earlier chunk with exactly the same notes in both hands */
  repeatOf?: number;
}

/**
 * Chunks for playing with both hands: boundaries where both hands' fragments end are preferred,
 * cutting through a fragment is avoided. Empty if the piece is for one hand.
 */
export function togetherChunks(score: Score, blocks: Block[], bounds: BoundaryInfo[] = measureBoundaries(score)): Chunk[] {
  const M = bounds.length;
  if (!M || HANDS.some((h) => !blocks.some((b) => b.hand === h))) return [];
  const adjusted = bounds.map((bd, k) => {
    let strength = bd.strength;
    for (const h of HANDS) {
      const inside = blocks.some((b) => b.hand === h && b.startMeasure <= k && b.endMeasure > k);
      strength += inside ? -1.5 : 1.5;
    }
    return { ...bd, strength };
  });
  const cache = new FragmentCache(score);
  const hardPrefix = prefixCount(M, (k) => bounds[k].hard);
  const seg: Segmenter = {
    target: TOGETHER_TARGET,
    valid: (i, L) => i >= 0 && i + L <= M && hardPrefix[i + L - 1] - hardPrefix[i] === 0 && !bounds[i + L - 1].forbidden,
    size: (i, L) => cache.size(i, L),
  };
  const pickup = !!score.measures[0]?.implicit && M > 1;
  const ranges = phraseFill(seg, adjusted, 0, M - 1, pickup) ?? fixedRanges(bounds, 4);
  const out: Chunk[] = [];
  for (const [a, b] of ranges) {
    const c: Chunk = { startMeasure: a, endMeasure: b };
    const L = b - a + 1;
    const ev = cache.events(a, L);
    if (ev.length) {
      const same = out.findIndex(
        (o) => o.repeatOf === undefined && o.endMeasure - o.startMeasure + 1 === L && matchWindows(cache.events(o.startMeasure, L), ev, 0).sim > 0.999,
      );
      if (same >= 0) c.repeatOf = same;
    }
    out.push(c);
  }
  return out;
}

/**
 * Parts of a long piece, learned one after another: sections between repeat signs and double bars,
 * long sections split at strong phrase endings. Short pieces are one part.
 */
export function pieceParts(bounds: BoundaryInfo[]): [number, number][] {
  const M = bounds.length;
  if (M <= PART_MIN_PIECE) return M ? [[0, M - 1]] : [];
  const sections: [number, number][] = [];
  let s = 0;
  for (let k = 0; k < M; k++) {
    if (bounds[k].hard || k === M - 1) {
      sections.push([s, k]);
      s = k + 1;
    }
  }
  const merged: [number, number][] = [];
  for (const p of sections) {
    const last = merged[merged.length - 1];
    if (last && (p[1] - p[0] + 1 < 8 || last[1] - last[0] + 1 < 8)) last[1] = p[1];
    else merged.push([p[0], p[1]]);
  }
  const out: [number, number][] = [];
  for (const [a, b] of merged) {
    let start = a;
    while (b - start + 1 > PART_MIN_PIECE) {
      let best = -1;
      let bestStrength = -Infinity;
      for (let k = start + 11; k <= Math.min(b - 8, start + 19); k++) {
        if (!bounds[k].forbidden && bounds[k].strength > bestStrength) {
          bestStrength = bounds[k].strength;
          best = k;
        }
      }
      if (best < 0) break;
      out.push([start, best]);
      start = best + 1;
    }
    out.push([start, b]);
  }
  return out;
}

export interface GuidePlan {
  steps: GuideStep[];
  parts: [number, number][];
  chunks: Chunk[];
}

/**
 * Learning order, part by part: the right hand's patterns and variations, the left hand's, then both
 * hands together chunk by chunk, then longer stretches, and finally the whole piece.
 */
export function buildSteps(score: Score, blocks: Block[], families: PatternFamily[]): GuidePlan {
  const M = score.measures.length;
  const bounds = measureBoundaries(score);
  const parts = pieceParts(bounds);
  const chunks = togetherChunks(score, blocks, bounds);
  const steps: GuideStep[] = [];
  if (!M || !blocks.length) return { steps, parts, chunks };
  const partOf = (m: number) => Math.max(0, parts.findIndex(([a, b]) => m >= a && m <= b));
  const twoHands = chunks.length > 0;
  // what is joined in the assembly steps: chunks, or the fragments of the only hand
  const units: [number, number][] = twoHands
    ? chunks.map((c) => [c.startMeasure, c.endMeasure])
    : blocks.map((b) => [b.startMeasure, b.endMeasure]);
  const assembled = new Set<string>();
  const assemble = (a: number, b: number, whole: boolean, part: number) => {
    const key = `${a}-${b}`;
    if (assembled.has(key)) return;
    assembled.add(key);
    steps.push({ kind: 'assemble', startMeasure: a, endMeasure: b, whole, part });
  };

  parts.forEach(([pa, pb], p) => {
    for (const hand of HANDS) {
      for (const f of families) {
        if (f.hand !== hand) continue;
        if (partOf(blocks[f.base].startMeasure) === p) steps.push({ kind: 'pattern', block: f.base, part: p });
        for (const k of f.blocks) {
          if (blocks[k].role === 'variation' && partOf(blocks[k].startMeasure) === p) steps.push({ kind: 'variation', block: k, part: p });
        }
      }
    }
    if (twoHands) {
      for (const c of chunks) {
        if (c.repeatOf === undefined && partOf(c.startMeasure) === p) {
          steps.push({ kind: 'together', startMeasure: c.startMeasure, endMeasure: c.endMeasure, part: p });
        }
      }
    }
    // join the chunks of the part: groups of about 8 measures, then the whole part
    const inPart = units.filter(([a]) => partOf(a) === p);
    if (inPart.length < 2) return;
    const groups: [number, number, number][] = []; // [first measure, last measure, units]
    let cur: [number, number, number] | null = null;
    for (const [a, b] of inPart) {
      if (!cur) cur = [a, b, 1];
      else {
        cur[1] = b;
        cur[2]++;
      }
      if (cur[1] - cur[0] + 1 >= 8 || bounds[b]?.hard) {
        groups.push(cur);
        cur = null;
      }
    }
    if (cur) {
      // a short tail joins the previous group
      const last = groups[groups.length - 1];
      if (last && cur[1] - cur[0] + 1 < 4) {
        last[1] = cur[1];
        last[2] += cur[2];
      } else groups.push(cur);
    }
    const multi = groups.filter((g) => g[2] > 1);
    const partWhole = inPart[0][0] === pa && inPart[inPart.length - 1][1] === pb;
    const coversPart = multi.length === 1 && multi[0][0] === inPart[0][0] && multi[0][1] === inPart[inPart.length - 1][1];
    if (!coversPart && pb - pa + 1 > SHORT_PART) for (const g of multi) assemble(g[0], g[1], false, p);
    if (parts.length > 1 && partWhole) assemble(pa, pb, false, p);
  });
  if (units.length > 1) assemble(0, M - 1, true, Math.max(0, parts.length - 1));
  return { steps, parts, chunks };
}

/** The step where a block is learned (repeats lead to what they repeat). */
export function stepOfBlock(steps: GuideStep[], blocks: Block[], blockIndex: number): number {
  let b = blocks[blockIndex];
  if (b?.sequenceOf !== undefined) b = blocks[b.sequenceOf];
  for (let guard = 0; b?.role === 'repeat' && b.repeatOf !== undefined && guard < 100; guard++) b = blocks[b.repeatOf];
  const idx = steps.findIndex((s) => (s.kind === 'pattern' || s.kind === 'variation') && s.block === b?.index);
  return idx >= 0 ? idx : 0;
}

/** Fragments of one hand. */
export function handBlocks(blocks: Block[], hand: Hand): Block[] {
  return blocks.filter((b) => b.hand === hand);
}
