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
 *     Similarity = 2·matches / (notes in both fragments) (the Dice coefficient). Notes added or removed inside the
 *     measures only lower it. Fragments of different lengths — the same phrase with whole measures inserted or
 *     left out — are compared measure by measure after aligning their measures (alignMatch).
 *  2. Fragments are one pattern when they are at least `threshold` similar (50 % by default, 20–90 %); a
 *     match from another note (transposed) needs at least 60 % and must cover every measure of the fragment.
 *     A threshold below 50 % only groups fragments: the piece is cut with 50 %.
 *  3. Segmentation of each hand: pairs of repeating fragments of a learnable size are chosen greedily
 *     (longer, closer and phrase-aligned pairs first) as anchors; the remaining measures are split at
 *     phrase boundaries by dynamic programming. Long silences of a hand are not fragments. Two patterns
 *     that always come together, with no phrase end between them, are joined into one (joinCompanions);
 *     a fragment of one or two notes joins its neighbour (absorbTiny).
 *  4. Families per hand — right hand A, B, C…, left hand a, b, c…; differences of each variation from
 *     the base are recorded.
 *  5. Hands together: the piece is cut into chunks whose boundaries coincide with the fragments of both
 *     hands where possible; identical chunks are learned once. Long pieces are learned part by part.
 *
 * Fragments are counted in full measures, but a fragment starts with its upbeat (the end of the measure
 * before it that leads into its first measure, see upbeat.ts), and the fragment before it ends there.
 * Fragments are compared aligned at their first barline; upbeat notes come before it.
 */
import { DEFAULT_THRESHOLD, EPS, type Block, type BlockDiff, type GuideStep, type Hand, type NoteEvent, type PatternFamily, type Score } from './model';
import { fixedRanges, measureBoundaries, type BlockSizeMode, type BoundaryInfo } from './segment';
import { barlineAt, fragmentStart, measureAt, upbeats } from './upbeat';

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
  /** onset from the barline of its own measure, in 1/24 quarters (upbeat notes: from the fragment's first barline) */
  mq: number;
}

export interface WindowMatch {
  sim: number;
  /** chromatic transposition in semitones (B = A + t) */
  t: number;
  /** diatonic transposition in scale steps (used instead of t for sequences) */
  steps: number;
  /** matched notes: [index in A, index in B, quality 1 | 0.75] */
  pairs: [number, number, number][];
  /**
   * Fragments of different lengths (alignMatch): for each measure of B (index = offset + 1, the upbeat first) the
   * offset of the measure of A it corresponds to, or null for a measure B inserts; and the measures of A that B
   * leaves out.
   */
  map?: (number | null)[];
  dropped?: number[];
}

/**
 * Notes of the fragment whose full measures are [i, i+L) as events (cached): with the upbeat into
 * measure i, without the upbeat into measure i+L (it starts the next fragment); one hand's notes if
 * `hand` is given. Positions are counted from the barline of measure i: upbeat notes have negative `q`
 * and `off` = -1.
 */
export class FragmentCache {
  private byMeasure: NoteEvent[][];
  private cache = new Map<string, WEvent[]>();
  private sizes = new Map<string, number>();
  /** upbeat into each measure, in quarters (both hands: the earlier start) */
  readonly up: number[];

  constructor(
    private score: Score,
    readonly hand: Hand | null = null,
    up?: number[],
  ) {
    this.byMeasure = score.measures.map(() => []);
    for (const n of score.notes) if (n.hand && !n.grace && (!hand || n.hand === hand)) this.byMeasure[n.measureIndex]?.push(n);
    this.up = up ?? upbeats(score, hand);
  }

  /** Where the fragment whose first full measure is k starts (its upbeat included), in quarters. */
  startOf(k: number): number {
    return fragmentStart(this.score, this.up, k);
  }

  events(i: number, L: number): WEvent[] {
    const key = `${i}|${L}`;
    let ev = this.cache.get(key);
    if (ev) return ev;
    ev = [];
    const M = this.byMeasure.length;
    const from = this.startOf(i);
    const to = this.startOf(Math.min(i + L, M));
    const bar = barlineAt(this.score, i);
    for (let k = Math.max(0, i - 1); k < i + L && k < M; k++) {
      for (const n of this.byMeasure[k]) {
        if (n.onset < from - EPS || n.onset >= to - EPS) continue;
        const q = Math.round((n.onset - bar) * Q);
        ev.push({
          id: n.id,
          hand: n.hand!,
          q,
          midi: n.midi,
          dia: n.octave * 7 + Math.max(0, STEPS.indexOf(n.step)),
          dur: n.duration,
          off: k - i,
          mq: k < i ? q : Math.round((n.onset - barlineAt(this.score, k)) * Q),
        });
      }
    }
    this.cache.set(key, ev);
    return ev;
  }

  /** Learning size of the fragment: distinct onsets of each hand (a chord counts once). */
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

/**
 * Shifted (transposed) matches must be at least this similar: the best of several shifts finds chance
 * matches more easily. When both fragments have the same rhythm, the relation is clear anyway and the
 * pattern threshold applies (a phrase repeated a step higher with a changed middle is its variation).
 */
export const MIN_SHIFTED = 0.6;
/** Rhythm similarity from which fragments count as having the same rhythm. */
const SAME_RHYTHM = 0.9;

/** Similarity of the rhythms of two fragments: Dice over note onsets of each hand (pitches ignored). */
export function rhythmSimilarity(A: WEvent[], B: WEvent[]): number {
  const a = new Set(A.map((e) => keyOf(e.hand, e.q)));
  const b = new Set(B.map((e) => keyOf(e.hand, e.q)));
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const k of a) if (b.has(k) || b.has(k - 2) || b.has(k + 2)) common++;
  return (2 * common) / (a.size + b.size);
}

/** The match is spread over the whole fragment: every measure with notes has something in common. */
function spread(A: WEvent[], B: WEvent[], m: WindowMatch): boolean {
  const notes = new Map<number, number>();
  const matched = new Map<number, number>();
  for (const e of A) notes.set(e.off, (notes.get(e.off) ?? 0) + 1);
  for (const e of B) notes.set(e.off, (notes.get(e.off) ?? 0) + 1);
  for (const [a, , q] of m.pairs) matched.set(A[a].off, (matched.get(A[a].off) ?? 0) + q);
  for (const [off, n] of notes) if (n >= 2 && (2 * (matched.get(off) ?? 0)) / n < 0.25) return false;
  return true;
}

/**
 * Best match over a few candidate transpositions (the most common pitch shifts between the fragments).
 * A shift is used only if it is clearly better than no shift, spread over the whole fragment ("the
 * whole figure from another note", not half of it) and at least MIN_SHIFTED similar. With
 * `sameRhythmAtThreshold` (grouping fragments that are already cut), `threshold` is enough when both
 * fragments have the same rhythm; cutting the piece keeps the stricter rule, so that chance matches of
 * common rhythms do not decide where fragments begin.
 */
export function bestMatch(A: WEvent[], B: WEvent[], threshold = 0, sameRhythmAtThreshold = false): WindowMatch {
  const plain = matchWindows(A, B, 0);
  if (plain.sim > 0.999 || !A.length || !B.length) return plain;
  const relaxed = sameRhythmAtThreshold && rhythmSimilarity(A, B) >= SAME_RHYTHM;
  const minShifted = relaxed ? threshold : Math.max(threshold, MIN_SHIFTED);
  let best = plain;
  const better = (m: WindowMatch) => m.sim >= best.sim + 0.1 && m.sim >= minShifted && spread(A, B, m);
  for (const t of topShifts(A, B, false)) {
    const m = matchWindows(A, B, t);
    if (better(m)) best = m;
  }
  for (const d of topShifts(A, B, true)) {
    const m = matchWindows(A, B, d, true);
    if (better(m)) best = m;
  }
  return best;
}

/**
 * How many whole measures a variation may insert or leave out, for fragments of these lengths (in measures):
 * one in a phrase of three to five measures, two from six. Shorter fragments are compared only at equal length.
 */
export function allowedIndels(La: number, Lb: number): number {
  const min = Math.min(La, Lb);
  return min < 3 ? 0 : Math.max(1, Math.floor(min / 3));
}

/** Notes of two sets of events matched by their place inside the measure (`mq`) and pitch (see matchWindows). */
function matchMeasures(A: WEvent[], ia: number[], B: WEvent[], ib: number[], shift: number, diatonic: boolean) {
  const index = new Map<number, number[]>();
  for (const k of ib) {
    const key = keyOf(B[k].hand, B[k].mq);
    const list = index.get(key);
    if (list) list.push(k);
    else index.set(key, [k]);
  }
  const used = new Set<number>();
  let score = 0;
  const pairs: [number, number, number][] = [];
  for (const a of ia) {
    const ea = A[a];
    let found = -1;
    for (const dq of [0, -1, 1]) {
      for (const k of index.get(keyOf(ea.hand, ea.mq + dq)) ?? []) {
        if (!used.has(k) && (diatonic ? B[k].dia === ea.dia + shift : B[k].midi === ea.midi + shift)) {
          found = k;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) continue;
    used.add(found);
    const eb = B[found];
    const quality = Math.abs(ea.dur - eb.dur) <= 0.25 * Math.max(ea.dur, eb.dur) + 1e-6 ? 1 : 0.75;
    score += quality;
    pairs.push([a, found, quality]);
  }
  return { score, pairs };
}

/**
 * Match of two fragments of different lengths (`La`, `Lb` measures) that are the same music with whole measures
 * inserted or left out — a phrase extended by a measure, a measure dropped. The measures are aligned in order
 * (dynamic programming; the upbeats with each other), their notes compared by place in the measure and pitch,
 * as matchWindows does; the similarity is the Dice coefficient over all notes. At most `allowedIndels` measures
 * may be inserted or left out on either side. A shift (another note) counts only when clearly better and at least
 * MIN_SHIFTED similar; `fixed` matches at a given shift (the block's own). With `inner`, the first and the last
 * measures of both must correspond: a measure without a partner at the edge is a neighbouring phrase, not an
 * inserted one (used when cutting the piece; an extension sits before the closing measure).
 */
export function alignMatch(
  A: WEvent[],
  La: number,
  B: WEvent[],
  Lb: number,
  threshold = 0,
  fixed?: { shift: number; diatonic: boolean },
  inner = false,
): WindowMatch {
  const none: WindowMatch = { sim: 0, t: 0, steps: 0, pairs: [] };
  const K = allowedIndels(La, Lb);
  if (Math.abs(La - Lb) > K || !A.length || !B.length) return none;
  const byMeasure = (E: WEvent[], L: number) => {
    const out: number[][] = Array.from({ length: L + 1 }, () => []);
    E.forEach((e, k) => {
      if (e.off >= -1 && e.off < L) out[e.off + 1].push(k);
    });
    return out;
  };
  const Am = byMeasure(A, La);
  const Bm = byMeasure(B, Lb);
  const run = (shift: number, diatonic: boolean): WindowMatch => {
    const w = new Map<number, ReturnType<typeof matchMeasures>>();
    const weight = (a: number, b: number) => {
      const key = a * 64 + b;
      let v = w.get(key);
      if (!v) w.set(key, (v = matchMeasures(A, Am[a], B, Bm[b], shift, diatonic)));
      return v;
    };
    // best[a][b]: measures 1..a of A aligned with 1..b of B (index 0 is the upbeat, aligned with the upbeat)
    const best = Array.from({ length: La + 1 }, () => new Array<number>(Lb + 1).fill(-Infinity));
    const from = Array.from({ length: La + 1 }, () => new Array<number>(Lb + 1).fill(0));
    best[0][0] = weight(0, 0).score;
    for (let a = 0; a <= La; a++) {
      for (let b = 0; b <= Lb; b++) {
        if ((a === 0 && b === 0) || Math.abs(a - b) > K) continue;
        let v = -Infinity;
        let f = 0;
        if (a > 0 && b > 0 && best[a - 1][b - 1] > -Infinity) {
          v = best[a - 1][b - 1] + weight(a, b).score;
          f = 1; // the measures correspond (preferred when equal)
        }
        if (a > 0 && best[a - 1][b] > v) {
          v = best[a - 1][b];
          f = 2; // B leaves out measure a of A
        }
        if (b > 0 && best[a][b - 1] > v) {
          v = best[a][b - 1];
          f = 3; // B inserts measure b
        }
        best[a][b] = v;
        from[a][b] = f;
      }
    }
    if (best[La][Lb] === -Infinity) return none;
    const map: (number | null)[] = new Array(Lb + 1).fill(null);
    map[0] = -1;
    const dropped: number[] = [];
    const pairs: [number, number, number][] = [...weight(0, 0).pairs];
    let score = weight(0, 0).score;
    for (let a = La, b = Lb; a > 0 || b > 0; ) {
      const f = from[a][b];
      if (f === 1) {
        map[b] = a - 1;
        pairs.push(...weight(a, b).pairs);
        score += weight(a, b).score;
        a--;
        b--;
      } else if (f === 2) {
        dropped.push(a - 1);
        a--;
      } else {
        b--;
      }
    }
    if (dropped.length > K || map.filter((x) => x === null).length > K) return none;
    if (inner && (map[1] === null || map[Lb] === null || dropped.includes(0) || dropped.includes(La - 1))) return none;
    return {
      sim: (2 * score) / (A.length + B.length),
      t: diatonic ? 0 : shift,
      steps: diatonic ? shift : 0,
      pairs,
      map,
      dropped: dropped.reverse(),
    };
  };
  if (fixed) return run(fixed.shift, fixed.diatonic);
  let best = run(0, false);
  if (best.sim > 0.999) return best;
  // shifts: the most common pitch differences between notes at the same place of measures that may correspond
  const minShifted = Math.max(threshold, MIN_SHIFTED);
  for (const diatonic of [false, true]) {
    const hist = new Map<number, number>();
    for (let a = 1; a <= La; a++) {
      for (let b = Math.max(1, a - K); b <= Math.min(Lb, a + K); b++) {
        for (const x of Am[a]) {
          for (const y of Bm[b]) {
            if (A[x].hand !== B[y].hand || A[x].mq !== B[y].mq) continue;
            const d = diatonic ? B[y].dia - A[x].dia : B[y].midi - A[x].midi;
            if (d !== 0 && Math.abs(d) <= (diatonic ? 7 : 12)) hist.set(d, (hist.get(d) ?? 0) + 1);
          }
        }
      }
    }
    const minVotes = Math.max(3, 0.3 * Math.min(A.length, B.length));
    const shifts = [...hist.entries()].filter(([, c]) => c >= minVotes).sort((x, y) => y[1] - x[1]).slice(0, 2);
    for (const [d] of shifts) {
      const m = run(d, diatonic);
      if (m.sim >= best.sim + 0.1 && m.sim >= minShifted) best = m;
    }
  }
  return best;
}

/** Match of two fragments of any lengths: note by note when equally long, measures aligned otherwise. */
export function fragmentMatch(A: WEvent[], La: number, B: WEvent[], Lb: number, threshold = 0, sameRhythmAtThreshold = false): WindowMatch {
  return La === Lb ? bestMatch(A, B, threshold, sameRhythmAtThreshold) : alignMatch(A, La, B, Lb, threshold);
}

const MIN_NOTES = 3;
/** Boundary strength of a clear phrase edge (a long note or rest, an upbeat, a 2/4-bar position). */
const PHRASE_EDGE = 2;
/** Boundary strength that counts as a full phrase edge, like the start of the piece (stronger counts the same). */
const FULL_EDGE = 3;
/** Boundary strength of a phrase end anywhere (a long note or rest ends the measure), on the bar grid or not. */
const PHRASE_END = 1.5;
const LEN_COST = [0, 0.4, 0, 0.35, 0, 0.7, 0.3, 0.8, 0.1];

interface Segmenter {
  /** preferred fragment size (onsets) */
  target: number;
  valid(i: number, L: number): boolean;
  size(i: number, L: number): number;
}

/** Splits measures [from, to] at phrase boundaries (dynamic programming). Null if impossible. */
function phraseFill(seg: Segmenter, bounds: BoundaryInfo[], from: number, to: number): [number, number][] | null {
  const n = to - from + 1;
  const best = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let L = 1; L <= 8 && j - L >= 0; L++) {
      const i = j - L;
      if (!Number.isFinite(best[i]) || !seg.valid(from + i, L)) continue;
      const size = seg.size(from + i, L);
      const sizeCost = size === 0 ? 1 : 2.5 * ((size - seg.target) / seg.target) ** 2;
      const lenCost = LEN_COST[Math.min(L, 8)] ?? 1;
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
function silentMeasures(cache: FragmentCache, M: number, first: number): Uint8Array {
  const silent = new Uint8Array(M);
  for (let k = first; k < M; ) {
    if (cache.size(k, 1) > 0) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < M && cache.size(e + 1, 1) === 0) e++;
    if (k === first || e === M - 1 || e - k + 1 >= 2) for (let x = k; x <= e; x++) silent[x] = 1;
    k = e + 1;
  }
  return silent;
}

/** Cuts one hand's part into fragments that line up with its repetitions. */
function handRanges(score: Score, cache: FragmentCache, bounds: BoundaryInfo[], threshold: number): HandRange[] {
  const M = bounds.length;
  const maxL = Math.min(8, M);
  // a pickup measure is the upbeat of the first fragment, not a measure of its own
  const first = firstFullMeasure(score);
  const silent = silentMeasures(cache, M, first);
  const hardPrefix = prefixCount(M, (k) => bounds[k].hard);
  const silentPrefix = prefixCount(M, (k) => silent[k] === 1);
  const seg: Segmenter = {
    target: HAND_TARGET,
    valid: (i, L) =>
      i >= first && i + L <= M && hardPrefix[i + L - 1] - hardPrefix[i] === 0 && silentPrefix[i + L] - silentPrefix[i] === 0,
    size: (i, L) => cache.size(i, L),
  };
  const startStrength = (i: number) => (i === first ? FULL_EDGE : bounds[i - 1].strength);
  // a boundary at least as strong as the start of the piece is a full phrase edge; stronger ones (the
  // end of the piece, repeat signs) must not make up for a partner that ends in the middle of a phrase
  const edge = (strength: number) => Math.min(strength, FULL_EDGE);
  const minSize = Math.max(MIN_NOTES, Math.round(HAND_TARGET * 0.4));
  const maxSize = Math.round(HAND_TARGET * 2.2);

  // 1. repeating pairs of learnable size
  type Pair = { i: number; j: number; L: number; Lj: number; m: WindowMatch; si: number; sj: number; value: number };
  const pairs: Pair[] = [];
  for (let L = 1; L <= maxL; L++) {
    for (let i = first; i + L <= M; i++) {
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
        // a shifted copy with the same rhythm counts at the pattern threshold only between whole phrases
        // (strong boundaries at both ends of both fragments); elsewhere common rhythms match by chance
        const phrases =
          Math.min(startStrength(i), startStrength(j), bounds[i + L - 1].strength, bounds[j + L - 1].strength) >= PHRASE_EDGE;
        const m = bestMatch(A, B, threshold, phrases);
        if (m.sim < threshold) continue;
        pairs.push({ i, j, L, Lj: L, m, si, sj, value: 0 });
      }
    }
  }
  // the same phrase with whole measures inserted or left out (a phrase extended by a measure, a measure
  // dropped): only between whole phrases — a long note or rest before and at the end of both, where the
  // measures line up. (The end of an extended phrase is off the 2- and 4-bar grid: a phrase end is enough.)
  const phraseEdges = (i: number, L: number) => Math.min(startStrength(i), bounds[i + L - 1].strength) >= PHRASE_END;
  for (let L = 3; L <= maxL; L++) {
    for (let i = first; i + L <= M; i++) {
      if (!seg.valid(i, L) || !phraseEdges(i, L)) continue;
      const si = seg.size(i, L);
      if (si < minSize || si > maxSize) continue;
      const A = cache.events(i, L);
      for (let Lj = Math.max(3, L - 2); Lj <= Math.min(maxL, L + 2); Lj++) {
        if (Lj === L || Math.abs(Lj - L) > allowedIndels(L, Lj)) continue;
        for (let j = i + L; j + Lj <= M; j++) {
          if (!seg.valid(j, Lj) || !phraseEdges(j, Lj)) continue;
          const sj = seg.size(j, Lj);
          if (sj < minSize || sj > maxSize) continue;
          const B = cache.events(j, Lj);
          if ((2 * Math.min(A.length, B.length)) / (A.length + B.length) < threshold) continue;
          const m = alignMatch(A, L, B, Lj, threshold, undefined, true);
          if (m.sim < threshold) continue;
          pairs.push({ i, j, L, Lj, m, si, sj, value: 0 });
        }
      }
    }
  }
  // how many places a fragment comes back in: a motif that recurs often explains more of the piece than
  // a long stretch repeated once
  const support = new Map<string, number>();
  for (const p of pairs) {
    support.set(`${p.i}|${p.L}`, (support.get(`${p.i}|${p.L}`) ?? 0) + 1);
    support.set(`${p.j}|${p.Lj}`, (support.get(`${p.j}|${p.Lj}`) ?? 0) + 1);
  }
  for (const p of pairs) {
    const { i, j, L, Lj, m, si, sj } = p;
    const fit = 1 - Math.min(1, Math.abs((si + sj) / 2 - HAND_TARGET) / HAND_TARGET);
    const phrase = edge(startStrength(i)) + edge(startStrength(j)) + edge(bounds[i + L - 1].strength) + edge(bounds[j + Lj - 1].strength);
    const exact = m.sim > 0.999 && m.t === 0 && m.steps === 0 ? 0.5 : 0;
    // irregular lengths (3, 5, 7 measures) are rarely phrases
    const irregular = 0.75 * ((LEN_COST[Math.min(L, 8)] ?? 1) + (LEN_COST[Math.min(Lj, 8)] ?? 1));
    const recurs = ((support.get(`${i}|${L}`) ?? 1) + (support.get(`${j}|${Lj}`) ?? 1)) / 2;
    const often = 0.4 * Math.min(4, recurs - 1);
    p.value = ((L + Lj) / 2) * m.sim * fit + 0.5 * phrase + exact - irregular + often;
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
    if (freeOrSame(p.i, p.L) && freeOrSame(p.j, p.Lj)) {
      take(p.i, p.L);
      take(p.j, p.Lj);
    }
  }

  // 3. silences stay out; the gaps between anchors are split at phrase boundaries
  const out: HandRange[] = [];
  let k = first;
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
    const filled = phraseFill(seg, bounds, k, end);
    if (filled) out.push(...filled.map(([a, b]) => ({ a, b })));
    else out.push(...fixedRanges(bounds.slice(k, end + 1), 4).map(([a, b]) => ({ a: a + k, b: b + k })));
    k = end + 1;
  }
  return out;
}

/** The first full measure (a pickup measure is the upbeat of the first fragment). */
export function firstFullMeasure(score: Score): number {
  return score.measures[0]?.implicit && score.measures.length > 1 ? 1 : 0;
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
  // offset -1: the upbeat before the first barline
  const minOff = Math.min(0, ...base.map((e) => e.off), ...other.map((e) => e.off));
  const perMeasure: BlockDiff['measures'] = Array.from({ length: measures - minOff }, (_, k) => ({
    offset: k + minOff,
    changed: 0,
    missing: 0,
    rhythm: 0,
  }));
  const at = (off: number) => perMeasure[off - minOff];
  // measures inserted or left out (alignMatch): the measure of this block each measure of the base corresponds to
  const otherOf = new Map<number, number>();
  if (m.map) {
    m.map.forEach((baseOff, k) => {
      if (k === 0) return;
      if (at(k - 1)) at(k - 1).base = baseOff;
      if (baseOff !== null) otherOf.set(baseOff, k - 1);
    });
  }
  const dropped = new Map<number, number[]>((m.dropped ?? []).map((o) => [o, []]));
  other.forEach((e, k) => {
    if (!matchedOther.has(k)) {
      changed.push(e.id);
      if (at(e.off)) at(e.off).changed++;
    }
  });
  for (const [, k, quality] of m.pairs) {
    if (quality < 1) {
      rhythm.push(other[k].id);
      if (at(other[k].off)) at(other[k].off).rhythm++;
    }
  }
  base.forEach((e, k) => {
    if (!matchedBase.has(k)) {
      baseUnmatched.push(e.id);
      const left = dropped.get(e.off);
      if (left) left.push(e.id);
      else {
        const off = m.map && e.off >= 0 ? otherOf.get(e.off) : e.off;
        if (off !== undefined && at(off)) at(off).missing++;
      }
    }
  });
  const diff: BlockDiff = { changed, rhythm, baseUnmatched, measures: perMeasure };
  if (dropped.size) diff.dropped = [...dropped.entries()].map(([offset, notes]) => ({ offset, notes }));
  return diff;
}

export interface PatternStructure {
  /** fragments of both hands: first the right hand's in order, then the left hand's */
  blocks: Block[];
  families: PatternFamily[];
}

/** Number of full measures of a fragment (its upbeat not counted). */
const coreLen = (b: Block) => b.endMeasure - (b.coreStart ?? b.startMeasure) + 1;

/**
 * Families of a hand's fragments (in order): each fragment joins the family whose first appearance it resembles
 * most, or starts a new one. The base to learn first is chosen afterwards (see chooseBase).
 */
interface Grouping {
  /** family of each fragment, numbered in order of first appearance */
  family: number[];
}

function groupFragments(cache: FragmentCache, frags: HandRange[], threshold: number): Grouping {
  const family: number[] = [];
  const bases: number[] = [];
  for (let k = 0; k < frags.length; k++) {
    const L = frags[k].b - frags[k].a + 1;
    const notes = cache.events(frags[k].a, L);
    let best = -1;
    let bestM: WindowMatch | null = null;
    if (notes.length >= MIN_NOTES) {
      for (let f = 0; f < bases.length; f++) {
        const base = frags[bases[f]];
        const Lb = base.b - base.a + 1;
        if (Lb !== L && Math.abs(Lb - L) > allowedIndels(Lb, L)) continue;
        const ev = cache.events(base.a, Lb);
        if (ev.length < MIN_NOTES) continue;
        const m = fragmentMatch(ev, Lb, notes, L, threshold, true);
        if (m.sim >= threshold && (!bestM || m.sim > bestM.sim)) {
          bestM = m;
          best = f;
        }
      }
    }
    if (best < 0 || !bestM) {
      bases.push(k);
      family.push(bases.length - 1);
    } else family.push(best);
  }
  return { family };
}

/**
 * The base of a pattern family — what is learned first, the other appearances being shown as its variations:
 * the appearance the others differ from least (fewest notes to relearn or drop over all of them, a changed
 * length counting half), which need not be the first one; of equal ones the earliest. Every appearance must
 * resemble the base at the threshold, as it resembles the first one (the family was grouped around it), so the
 * families stay as they are. `events`: the appearances in order; returns the position of the base among them.
 */
export function chooseBase(events: WEvent[][], threshold: number, lengths: number[] = events.map(() => 1)): number {
  const n = events.length;
  if (n < 3) return 0; // two appearances differ from each other equally
  const cost = (i: number) => {
    let total = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const m = fragmentMatch(events[i], lengths[i], events[j], lengths[j], threshold, true);
      if (m.sim < threshold - 1e-9) return Infinity;
      total += ((1 - m.sim) * (events[i].length + events[j].length)) / 2;
    }
    return total;
  };
  let best = 0;
  let bestCost = cost(0);
  for (let i = 1; i < n; i++) {
    const c = cost(i);
    if (c < bestCost - 1e-6) {
      best = i;
      bestCost = c;
    }
  }
  return best;
}

/** Longest fragment (in measures) that two companion patterns may form together. */
const COMPANION_MAX_LEN = 8;

/**
 * Two patterns of a hand that always come together — every appearance of one is followed right away by
 * an appearance of the other, and the other never appears without it — are one pattern cut in two.
 * (The anchors cut it when a half alone repeats more exactly or also resembles another passage, or the
 * whole is longer than the preferred size.) They are joined when the seam between them is weaker than
 * the edges of the whole (no phrase ends there) and the whole is still learnable in one go.
 */
export function joinCompanions(
  cache: FragmentCache,
  frags: HandRange[],
  bounds: BoundaryInfo[],
  threshold: number,
  first: number,
): { frags: HandRange[]; groups: Grouping } {
  const maxSize = Math.round(HAND_TARGET * 2.2);
  // strength of the boundary after measure k (before the first full measure: the start of the piece)
  const after = (k: number) => (k < first ? FULL_EDGE : Math.min(bounds[k].strength, FULL_EDGE));
  for (let pass = 0; ; pass++) {
    const groups = groupFragments(cache, frags, threshold);
    if (pass === 8) return { frags, groups };
    const { family } = groups;
    const where = new Map<number, number[]>();
    family.forEach((f, k) => where.set(f, [...(where.get(f) ?? []), k]));
    // family of the fragment right after fragment k (-1: a gap or the end)
    const next = (k: number) => (k + 1 < frags.length && frags[k + 1].a === frags[k].b + 1 ? family[k + 1] : -1);
    let join: number[] | null = null;
    let weakest = Infinity;
    for (const [f, ks] of where) {
      if (ks.length < 2) continue;
      const g = next(ks[0]);
      if (g < 0 || g === f || !ks.every((k) => next(k) === g) || where.get(g)!.length !== ks.length) continue;
      let seam = 0;
      let start = 0;
      let end = 0;
      let fits = true;
      for (const k of ks) {
        const a = frags[k].a;
        const b = frags[k + 1].b;
        if (bounds[frags[k].b].hard || b - a + 1 > COMPANION_MAX_LEN || cache.size(a, b - a + 1) > maxSize) fits = false;
        seam += bounds[frags[k].b].strength / ks.length;
        start += after(a - 1) / ks.length;
        end += after(b) / ks.length;
      }
      if (!fits || seam >= PHRASE_EDGE || seam >= Math.min(start, end)) continue;
      if (seam < weakest) {
        weakest = seam;
        join = ks;
      }
    }
    if (!join) return { frags, groups };
    const joined = new Set(join);
    const out: HandRange[] = [];
    for (let k = 0; k < frags.length; k++) {
      if (joined.has(k)) {
        out.push({ a: frags[k].a, b: frags[k + 1].b });
        k++;
      } else out.push(frags[k]);
    }
    frags = out;
  }
}

/**
 * A fragment of fewer than MIN_NOTES onsets (a lone final note or chord) is not a pattern to learn: it
 * joins the fragment before it, or the one after it if that is not possible.
 */
function absorbTiny(cache: FragmentCache, frags: HandRange[], bounds: BoundaryInfo[]): HandRange[] {
  const maxSize = Math.round(HAND_TARGET * 2.2);
  const size = (r: HandRange) => cache.size(r.a, r.b - r.a + 1);
  // fragment a right before fragment b can take it in
  const joinable = (a: HandRange, b: HandRange) =>
    b.a === a.b + 1 && !bounds[a.b].hard && b.b - a.a + 1 <= COMPANION_MAX_LEN && cache.size(a.a, b.b - a.a + 1) <= maxSize;
  const out = [...frags];
  for (let k = 0; k < out.length; k++) {
    if (size(out[k]) >= MIN_NOTES) continue;
    if (k > 0 && joinable(out[k - 1], out[k])) {
      out.splice(k - 1, 2, { a: out[k - 1].a, b: out[k].b });
      k--;
    } else if (k + 1 < out.length && joinable(out[k], out[k + 1])) {
      out.splice(k, 2, { a: out[k].a, b: out[k + 1].b });
    }
  }
  return out;
}

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
  const cache = new FragmentCache(score, hand);
  if (!score.notes.some((n) => n.hand === hand && !n.grace)) return;
  const first = firstFullMeasure(score);
  // Where fragments begin is decided by fragments that are really alike: below the default threshold
  // (a fifth of the notes, say) passages in one key match by chance. A looser threshold only groups the
  // fragments into fewer patterns.
  const cut = Math.max(threshold, DEFAULT_THRESHOLD);
  const ranges: HandRange[] =
    mode === 'auto'
      ? handRanges(score, cache, bounds, cut)
      : fixedRanges(bounds.slice(first), mode).map(([a, b]) => ({ a: a + first, b: b + first, rest: cache.size(a + first, b - a + 1) === 0 }));
  const parts = ranges.filter((r) => !r.rest && cache.size(r.a, r.b - r.a + 1) > 0);
  const joined = mode === 'auto' ? joinCompanions(cache, absorbTiny(cache, parts, bounds), bounds, cut, first) : null;
  const frags = joined ? joined.frags : parts;
  const groups = joined && cut === threshold ? joined.groups : groupFragments(cache, frags, threshold);

  const mine: Block[] = [];
  for (const r of frags) {
    // the fragment starts with the upbeat into its first measure and ends where the next upbeat starts
    const start = cache.startOf(r.a);
    const b: Block = {
      index: blocks.length,
      hand,
      startMeasure: measureAt(score, start),
      endMeasure: r.b,
      start,
      end: cache.startOf(r.b + 1),
      coreStart: r.a,
      family: -1,
      label: '',
      role: 'base',
      similarity: 1,
      transpose: 0,
    };
    blocks.push(b);
    mine.push(b);
  }

  const ev = (b: Block) => cache.events(b.coreStart ?? b.startMeasure, coreLen(b));
  // families in order of first appearance; the base of each is the appearance the others differ from least
  const members: number[][] = [];
  groups.family.forEach((f, k) => (members[f] ??= []).push(k));
  const handFamilies: PatternFamily[] = members.map((ks, i) => {
    const f: PatternFamily = {
      index: families.length,
      hand,
      letter: patternLetter(hand, i),
      base: mine[ks[chooseBase(ks.map((k) => ev(mine[k])), threshold, ks.map((k) => coreLen(mine[k])))]].index,
      blocks: ks.map((k) => mine[k].index),
    };
    families.push(f);
    return f;
  });
  const variantCount = new Map<number, number>();
  for (let k = 0; k < mine.length; k++) {
    const b = mine[k];
    const f = handFamilies[groups.family[k]];
    b.family = f.index;
    if (b.index === f.base) {
      b.label = f.letter;
      continue;
    }
    const base = blocks[f.base];
    const notes = ev(b);
    // the same match as when the family was grouped, now with the chosen base
    const bestM = fragmentMatch(ev(base), coreLen(base), notes, coreLen(b), threshold, true);
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
    for (const idx of f.blocks) {
      const v = blocks[idx];
      if (idx >= b.index) break;
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
      Math.abs(mine[end + 1].start - mine[end].end) < EPS
    ) {
      end++;
      mine[end].sequenceOf = first.index;
    }
    if (end > k) first.sequenceEnd = mine[end].index;
  }
}

/** Splits each hand's part into fragments and groups them into pattern families. */
export function analyzePatterns(score: Score, mode: BlockSizeMode = 'auto', threshold = DEFAULT_THRESHOLD): PatternStructure {
  const blocks: Block[] = [];
  const families: PatternFamily[] = [];
  if (score.measures.length === 0) return { blocks, families };
  const bounds = measureBoundaries(score);
  for (const hand of HANDS) analyzeHand(score, hand, mode, threshold, bounds, blocks, families);
  return { blocks, families };
}

/** A note of a pattern and the same note in another appearance of it (possibly from another note). */
export interface NotePair {
  from: number;
  to: number;
  /** the appearance is transposed (a sequence, another octave) */
  shifted: boolean;
}

/** The notes that correspond in two fragments of a hand, given the shift of `b` relative to `a`. */
function correspondingNotes(cache: FragmentCache, a: Block, b: Block, shifted: boolean, exactOnly: boolean): NotePair[] {
  const La = coreLen(a);
  const Lb = coreLen(b);
  const evA = cache.events(a.coreStart ?? a.startMeasure, La);
  const evB = cache.events(b.coreStart ?? b.startMeasure, Lb);
  const shift = { shift: b.steps || b.transpose, diatonic: !!b.steps };
  const m =
    La !== Lb
      ? alignMatch(evA, La, evB, Lb, 0, shift)
      : b.steps
        ? matchWindows(evA, evB, b.steps, true)
        : matchWindows(evA, evB, b.transpose);
  return m.pairs.filter(([, , q]) => !exactOnly || q === 1).map(([x, y]) => ({ from: evA[x].id, to: evB[y].id, shifted }));
}

/**
 * Notes of every appearance of a pattern that correspond to notes of its base (same place, pitch moved by
 * the appearance's shift, same length) — used to give every appearance of a pattern the same fingering.
 * Repeats of a variation correspond to that variation (see repeatNotePairs).
 */
export function equalNotePairs(score: Score, blocks: Block[], families: PatternFamily[]): NotePair[] {
  const caches = new Map<Hand, FragmentCache>();
  const out: NotePair[] = [];
  for (const f of families) {
    let cache = caches.get(f.hand);
    if (!cache) caches.set(f.hand, (cache = new FragmentCache(score, f.hand)));
    const base = blocks[f.base];
    for (const k of f.blocks) {
      const b = blocks[k];
      if (k === f.base) continue;
      // a repeat of a variation carries its shift relative to that variation
      if (b.role === 'repeat' && b.repeatOf !== undefined && b.repeatOf !== f.base) continue;
      out.push(...correspondingNotes(cache, base, b, b.transpose !== 0 || !!b.steps, true));
    }
  }
  return out;
}

/** Notes of each repeat of a variation and the same notes of that variation. */
export function repeatNotePairs(score: Score, blocks: Block[]): NotePair[] {
  const caches = new Map<Hand, FragmentCache>();
  const out: NotePair[] = [];
  for (const b of blocks) {
    if (b.role !== 'repeat' || b.repeatOf === undefined) continue;
    const src = blocks[b.repeatOf];
    if (src.role !== 'variation') continue;
    let cache = caches.get(b.hand);
    if (!cache) caches.set(b.hand, (cache = new FragmentCache(score, b.hand)));
    out.push(...correspondingNotes(cache, src, b, b.transpose !== 0 || !!b.steps, false));
  }
  return out;
}

/** A stretch played with both hands; identical stretches are learned once (`repeatOf`). */
export interface Chunk {
  /** first measure drawn (the measure of the upbeat, if any) */
  startMeasure: number;
  /** first full measure */
  coreStart: number;
  endMeasure: number;
  /** span in quarters: from the upbeat of either hand to where the next chunk's upbeat starts */
  start: number;
  end: number;
  /** index of an earlier chunk with exactly the same notes in both hands */
  repeatOf?: number;
}

/**
 * Chunks for playing with both hands: boundaries where both hands' fragments end are preferred,
 * cutting through a fragment is avoided. A chunk starts with the upbeat of either hand. Empty if the
 * piece is for one hand.
 */
export function togetherChunks(score: Score, blocks: Block[], bounds: BoundaryInfo[] = measureBoundaries(score)): Chunk[] {
  const M = bounds.length;
  if (!M || HANDS.some((h) => !blocks.some((b) => b.hand === h))) return [];
  // strength of the barline after measure k: + where a hand's fragment ends, − where one goes on
  const adjusted = bounds.map((bd, k) => {
    let strength = bd.strength;
    for (const h of HANDS) {
      const inside = blocks.some((b) => b.hand === h && (b.coreStart ?? b.startMeasure) <= k && b.endMeasure > k);
      strength += inside ? -1.5 : 1.5;
    }
    return { ...bd, strength };
  });
  const cache = new FragmentCache(score);
  const first = firstFullMeasure(score);
  const hardPrefix = prefixCount(M, (k) => bounds[k].hard);
  const seg: Segmenter = {
    target: TOGETHER_TARGET,
    valid: (i, L) => i >= first && i + L <= M && hardPrefix[i + L - 1] - hardPrefix[i] === 0,
    size: (i, L) => cache.size(i, L),
  };
  const ranges =
    phraseFill(seg, adjusted, first, M - 1) ?? fixedRanges(bounds.slice(first), 4).map(([a, b]) => [a + first, b + first] as [number, number]);
  const out: Chunk[] = [];
  for (const [a, b] of ranges) {
    const start = cache.startOf(a);
    const c: Chunk = { startMeasure: measureAt(score, start), coreStart: a, endMeasure: b, start, end: cache.startOf(b + 1) };
    const L = b - a + 1;
    const ev = cache.events(a, L);
    if (ev.length) {
      const same = out.findIndex(
        (o) => o.repeatOf === undefined && o.endMeasure - o.coreStart + 1 === L && matchWindows(cache.events(o.coreStart, L), ev, 0).sim > 0.999,
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
  type Unit = { startMeasure: number; coreStart: number; endMeasure: number; start: number; end: number };
  // what is joined in the assembly steps: chunks, or the fragments of the only hand
  const units: Unit[] = twoHands
    ? chunks
    : blocks.map((b) => ({ startMeasure: b.startMeasure, coreStart: b.coreStart ?? b.startMeasure, endMeasure: b.endMeasure, start: b.start, end: b.end }));
  const assembled = new Set<string>();
  const assemble = (a: Unit, b: Unit, whole: boolean, part: number) => {
    const key = `${a.start}-${b.end}`;
    if (assembled.has(key)) return;
    assembled.add(key);
    steps.push({
      kind: 'assemble',
      startMeasure: a.startMeasure,
      coreStart: a.coreStart,
      endMeasure: b.endMeasure,
      start: a.start,
      end: b.end,
      whole,
      part,
    });
  };

  parts.forEach(([pa, pb], p) => {
    for (const hand of HANDS) {
      for (const f of families) {
        if (f.hand !== hand) continue;
        // the base is learned in the part where the pattern first appears, also when the base itself comes later
        const firstPart = Math.min(...f.blocks.map((k) => partOf(blocks[k].coreStart ?? blocks[k].startMeasure)));
        if (firstPart === p) steps.push({ kind: 'pattern', block: f.base, part: p });
        for (const k of f.blocks) {
          const b = blocks[k];
          if (b.role === 'variation' && partOf(b.coreStart ?? b.startMeasure) === p) steps.push({ kind: 'variation', block: k, part: p });
        }
      }
    }
    if (twoHands) {
      for (const c of chunks) {
        if (c.repeatOf === undefined && partOf(c.coreStart) === p) {
          steps.push({ kind: 'together', startMeasure: c.startMeasure, coreStart: c.coreStart, endMeasure: c.endMeasure, start: c.start, end: c.end, part: p });
        }
      }
    }
    // join the chunks of the part: groups of about 8 measures, then the whole part
    const inPart = units.filter((u) => partOf(u.coreStart) === p);
    if (inPart.length < 2) return;
    const groups: { from: Unit; to: Unit; count: number }[] = [];
    let cur: { from: Unit; to: Unit; count: number } | null = null;
    for (const u of inPart) {
      if (!cur) cur = { from: u, to: u, count: 1 };
      else {
        cur.to = u;
        cur.count++;
      }
      if (cur.to.endMeasure - cur.from.coreStart + 1 >= 8 || bounds[u.endMeasure]?.hard) {
        groups.push(cur);
        cur = null;
      }
    }
    if (cur) {
      // a short tail joins the previous group
      const last = groups[groups.length - 1];
      if (last && cur.to.endMeasure - cur.from.coreStart + 1 < 4) {
        last.to = cur.to;
        last.count += cur.count;
      } else groups.push(cur);
    }
    const multi = groups.filter((g) => g.count > 1);
    const firstUnit = inPart[0];
    const lastUnit = inPart[inPart.length - 1];
    const partWhole = firstUnit.coreStart <= Math.max(pa, firstFullMeasure(score)) && lastUnit.endMeasure === pb;
    const coversPart = multi.length === 1 && multi[0].from === firstUnit && multi[0].to === lastUnit;
    if (!coversPart && pb - pa + 1 > SHORT_PART) for (const g of multi) assemble(g.from, g.to, false, p);
    if (parts.length > 1 && partWhole) assemble(firstUnit, lastUnit, false, p);
  });
  if (units.length > 1) {
    const whole: Unit = {
      startMeasure: 0,
      coreStart: firstFullMeasure(score),
      endMeasure: M - 1,
      start: 0,
      end: barlineAt(score, M),
    };
    assemble(whole, whole, true, Math.max(0, parts.length - 1));
  }
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
