/**
 * Upbeats (anacruses). A phrase often starts before the barline: with the pickup measure at the beginning
 * of a piece, or with a few short notes at the end of the previous measure after the previous phrase has
 * ended on a long note or a rest. A fragment then begins with its upbeat, and the fragment before it ends
 * where the upbeat starts — in the middle of a measure.
 */
import { EPS, type Hand, type NoteEvent, type Score } from './model';

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** Position of barline k in quarters (k = M is the end of the piece). */
export function barlineAt(score: Score, k: number): number {
  const { measures } = score;
  if (k <= 0) return measures[0]?.start ?? 0;
  if (k >= measures.length) {
    const last = measures[measures.length - 1];
    return last ? last.start + last.length : 0;
  }
  return measures[k].start;
}

/**
 * For each barline k (0…M; barline k starts measure k, barline M ends the piece): how long, in quarters,
 * the upbeat into measure k is for this hand — the end of measure k-1 that belongs to the phrase starting
 * at the barline. 0 = no upbeat.
 *
 * The notes of a pickup measure are the upbeat of the first full measure. Elsewhere an upbeat is a group
 * of notes at the end of a measure (at most half of it) that
 *  - follows a break: the time since the previous note is at least a beat and at least twice the longest
 *    step inside the group (a long note or a rest before it);
 *  - sounds up to the barline and leads into a note on the downbeat;
 *  - and either comes after a rest (a breath between phrases) or is as long as the hand's own pickup at
 *    the start of the piece (a piece that starts with an upbeat usually starts its phrases the same way).
 * "A long note and two short ones" alone is not enough: inside a phrase it is everywhere.
 */
export function upbeatsOf(score: Score, hand: Hand): number[] {
  const { measures } = score;
  const M = measures.length;
  const up = new Array<number>(M + 1).fill(0);
  if (M < 2) return up;
  const byMeasure: NoteEvent[][] = measures.map(() => []);
  for (const n of score.notes) if (n.hand === hand && !n.grace) byMeasure[n.measureIndex]?.push(n);
  const onsets = Array.from(new Set(score.notes.filter((n) => n.hand === hand && !n.grace).map((n) => round(n.onset)))).sort(
    (a, b) => a - b,
  );
  const pickup = !!measures[0].implicit;
  const pickupLen = pickup && byMeasure[0].length ? measures[0].length : 0;
  if (pickupLen) up[1] = pickupLen;

  for (let k = pickup ? 2 : 1; k < M; k++) {
    const p = measures[k - 1];
    const barline = measures[k].start;
    const notes = byMeasure[k - 1];
    const next = byMeasure[k];
    if (!notes.length || !next.length) continue;
    // the upbeat leads into a note on the downbeat
    if (Math.min(...next.map((n) => n.onset)) > barline + EPS) continue;
    const beat = p.length / Math.max(1, p.beats);
    let best = 0;
    let bestScore = 0;
    for (let x = 0; x < onsets.length; x++) {
      const t = onsets[x];
      if (t <= p.start + EPS || t >= barline - EPS) continue;
      const u = barline - t;
      if (u > 0.5 * p.length + EPS) continue;
      const prevIOI = x > 0 ? t - onsets[x - 1] : Infinity;
      let maxStep = 0;
      let prev = t;
      for (let y = x + 1; y < onsets.length && onsets[y] < barline - EPS; y++) {
        maxStep = Math.max(maxStep, onsets[y] - prev);
        prev = onsets[y];
      }
      maxStep = Math.max(maxStep, barline - prev);
      if (prevIOI < beat - EPS || prevIOI < 2 * maxStep - EPS) continue;
      const samePickup = pickupLen > 0 && Math.abs(u - pickupLen) < EPS;
      const before = notes.filter((n) => n.onset < t - EPS);
      const prevEnd = before.length ? Math.max(...before.map((n) => n.onset + n.duration)) : -Infinity;
      const afterRest = t - prevEnd >= 0.5 * beat - EPS;
      if (!samePickup && !afterRest) continue;
      const group = notes.filter((n) => n.onset >= t - EPS);
      // the group sounds up to the barline (not a figure followed by a rest)
      if (barline - Math.max(...group.map((n) => n.onset + n.duration)) > 0.25 + EPS) continue;
      // no note of the hand is held through the start of the upbeat
      if (notes.some((n) => n.onset < t - EPS && n.onset + n.duration > t + 0.25)) continue;
      const score = Math.min(prevIOI / maxStep, 8) + (samePickup ? 2 : 0) + (afterRest ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    up[k] = round(best);
  }
  return up;
}

/** Upbeats of a hand, or of both hands (the earlier start wins), cached per score. */
const cache = new WeakMap<Score, Record<'R' | 'L' | 'both', number[]>>();
export function upbeats(score: Score, hand: Hand | null): number[] {
  let c = cache.get(score);
  if (!c) {
    const R = upbeatsOf(score, 'R');
    const L = upbeatsOf(score, 'L');
    c = { R, L, both: R.map((r, k) => Math.max(r, L[k])) };
    cache.set(score, c);
  }
  return hand ? c[hand] : c.both;
}

/** Start of a fragment whose first full measure is k: the barline minus its upbeat. */
export function fragmentStart(score: Score, up: number[], k: number): number {
  return barlineAt(score, k) - (up[k] ?? 0);
}

/** Measure that contains a position (in quarters). */
export function measureAt(score: Score, q: number): number {
  const { measures } = score;
  let idx = 0;
  for (const m of measures) if (m.start <= q + EPS) idx = m.index;
  return idx;
}
