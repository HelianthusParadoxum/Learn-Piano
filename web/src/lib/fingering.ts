/**
 * Automatic piano fingering.
 *
 * The cost model is based on the ergonomic model of Parncutt, Sloboda, Clarke, Raekallio & Desain (1997)
 * ("An ergonomic model of keyboard fingering for melodic fragments"), with refinements in the spirit of
 * Jacobs (2001) and Al Kasimi, Nichols & Raphael (2007): chords, held notes, tempo-aware weak-finger
 * penalties and a hand-position stability term (beginners keep a five-finger position as long as possible).
 * A second-order Viterbi search finds the cheapest fingering for each hand over the whole piece.
 */
import { EPS, type Hand, type NoteEvent } from './model';

/** [MinPrac, MinComf, MinRel, MaxRel, MaxComf, MaxPrac] in semitones, right hand, finger pair (a<b). */
type Span = [number, number, number, number, number, number];

/** Sequential (melodic) spans, Parncutt et al. 1997, table 1. */
const SEQ_TABLE: Record<string, Span> = {
  '1-2': [-5, -3, 1, 5, 8, 10],
  '1-3': [-4, -2, 3, 7, 10, 12],
  '1-4': [-3, -1, 5, 9, 12, 14],
  '1-5': [-1, 1, 7, 10, 13, 15],
  '2-3': [1, 1, 1, 2, 3, 5],
  '2-4': [1, 1, 3, 4, 5, 7],
  '2-5': [2, 2, 5, 6, 8, 10],
  '3-4': [1, 1, 1, 2, 2, 4],
  '3-5': [1, 1, 3, 4, 5, 7],
  '4-5': [1, 1, 1, 2, 3, 5],
};

/** Simultaneous (chord) spans: the hand holds both keys, so relaxed ranges are tighter. */
const CHORD_TABLE: Record<string, Span> = {
  '1-2': [1, 1, 1, 4, 6, 9],
  '1-3': [2, 2, 3, 5, 7, 10],
  '1-4': [3, 3, 5, 7, 9, 12],
  '1-5': [5, 5, 7, 12, 13, 15],
  '2-3': [1, 1, 1, 2, 3, 4],
  '2-4': [2, 2, 3, 4, 5, 7],
  '2-5': [3, 3, 5, 7, 8, 10],
  '3-4': [1, 1, 1, 2, 3, 4],
  '3-5': [2, 2, 3, 4, 5, 7],
  '4-5': [1, 1, 1, 2, 3, 4],
};

const HAND_SCALE = { small: 0.85, medium: 1, large: 1.12 } as const;

/** Tunable weights of the model. */
export const WEIGHTS = {
  stretch: 2,
  smallSpanThumb: 1,
  smallSpanOther: 2.5,
  largeSpanThumb: 1,
  largeSpanOther: 2,
  impractical: 8,
  impracticalSlope: 3,
  weak4: 0.75,
  weak5: 0.5,
  threeToFour: 0.5,
  fourOnBlack: 1,
  thumbOnBlack: 1,
  thumbOnBlackContext: 2,
  fiveOnBlackContext: 2,
  thumbPassSameLevel: 1,
  thumbPassWhiteToBlack: 3,
  threeFourFive: 0.5,
  positionChangeHalf: 1,
  positionChangeFull: 2,
  positionChangeSize: 1,
  sameFingerLegato: 7,
  sameFingerFree: 1.5,
  repeatedNoteFingerChange: 1.5,
  shiftLegato: 0.3,
  shiftFree: 0.5,
  chordOuterFingers: 0.8,
  chordWeak: 0.15,
  heldBusyFinger: 30,
};

export interface FingeringOptions {
  handSize?: keyof typeof HAND_SCALE;
  /** note.key → finger, set by the user; strongest constraint. */
  overrides?: Record<string, number>;
  /** note.key → finger copied from the first appearance of the same pattern (same fingers in every repeat) */
  patternFingers?: Record<string, number>;
  /** Quarter-note tempo (used to decide whether the hand has time to move between notes). */
  tempo?: number;
  /** Use fingerings written in the score as constraints (default true). */
  useScoreFingerings?: boolean;
}

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlackKey = (midi: number) => BLACK.has(((midi % 12) + 12) % 12);

const WHITE_INDEX = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
/** Horizontal key position in white-key widths (black keys sit between their neighbours). */
export const keyPosition = (midi: number) => Math.floor(midi / 12) * 7 + WHITE_INDEX[((midi % 12) + 12) % 12];

function scaleTable(base: Record<string, Span>, k: number): Record<string, Span> {
  const out: Record<string, Span> = {};
  for (const [key, s] of Object.entries(base)) {
    // only stretches scale with the hand: positive maxima and (for thumb pairs) negative crossing minima
    const neg = (v: number) => (v < 0 ? v * k : v);
    const pos = (v: number) => (v > 0 ? v * k : v);
    out[key] = [neg(s[0]), neg(s[1]), s[2], pos(s[3]), pos(s[4]), pos(s[5])];
  }
  return out;
}

class CostModel {
  private seqTable: Record<string, Span>;
  private chordTable: Record<string, Span>;

  constructor(
    readonly hand: Hand,
    handSize: keyof typeof HAND_SCALE,
  ) {
    const k = HAND_SCALE[handSize];
    this.seqTable = scaleTable(SEQ_TABLE, k);
    this.chordTable = scaleTable(CHORD_TABLE, k);
  }

  span(fa: number, fb: number, chord = false): Span {
    return (chord ? this.chordTable : this.seqTable)[`${fa}-${fb}`];
  }

  /** Parncutt rules 1–3 (stretch, small-span, large-span) + impracticality, for fingers fa<fb, interval d. */
  spanCost(fa: number, fb: number, d: number, chord = false): number {
    const [minP, minC, minR, maxR, maxC, maxP] = this.span(fa, fb, chord);
    const thumb = fa === 1;
    let c = 0;
    if (d < minR) c += (thumb ? WEIGHTS.smallSpanThumb : WEIGHTS.smallSpanOther) * (minR - d);
    if (d > maxR) c += (thumb ? WEIGHTS.largeSpanThumb : WEIGHTS.largeSpanOther) * (d - maxR);
    if (d < minC) c += WEIGHTS.stretch * (minC - d);
    if (d > maxC) c += WEIGHTS.stretch * (d - maxC);
    if (d < minP) c += WEIGHTS.impractical + WEIGHTS.impracticalSlope * (minP - d);
    if (d > maxP) c += WEIGHTS.impractical + WEIGHTS.impracticalSlope * (d - maxP);
    return c;
  }

  /** Orients a note pair for the table: [fa, fb, d] with fa<fb and d = pitch(fb) - pitch(fa), mirrored for LH. */
  orient(m1: number, f1: number, m2: number, f2: number): [number, number, number] {
    let fa: number, fb: number, d: number;
    if (f1 < f2) {
      fa = f1;
      fb = f2;
      d = m2 - m1;
    } else {
      fa = f2;
      fb = f1;
      d = m1 - m2;
    }
    if (this.hand === 'L') d = -d;
    return [fa, fb, d];
  }

  /** Cost of two simultaneous notes (low < high in pitch) played with fingers fLow / fHigh. */
  chordPair(low: number, fLow: number, high: number, fHigh: number): number {
    const ordered = this.hand === 'R' ? fLow < fHigh : fLow > fHigh;
    if (!ordered || fLow === fHigh) return 40;
    return this.spanCost(Math.min(fLow, fHigh), Math.max(fLow, fHigh), high - low, true);
  }

  /** Horizontal cost between two consecutive single notes. */
  seq(m1: number, f1: number, m2: number, f2: number, legato: boolean): number {
    const d0 = m2 - m1;
    if (d0 === 0) return f1 === f2 ? 0 : WEIGHTS.repeatedNoteFingerChange;
    if (f1 === f2) {
      return legato ? WEIGHTS.sameFingerLegato + 0.3 * Math.abs(d0) : WEIGHTS.sameFingerFree + 0.1 * Math.abs(d0);
    }
    const [fa, fb, d] = this.orient(m1, f1, m2, f2);
    let c = this.spanCost(fa, fb, d);
    if (!legato) c = Math.min(c, 3 + 0.08 * Math.abs(d0));
    const b1 = isBlackKey(m1);
    const b2 = isBlackKey(m2);
    if (f1 === 3 && f2 === 4) c += WEIGHTS.threeToFour;
    if ((f1 === 3 && f2 === 4 && !b1 && b2) || (f1 === 4 && f2 === 3 && b1 && !b2)) c += WEIGHTS.fourOnBlack;
    if (f2 === 1 && b2 && !b1) c += WEIGHTS.thumbOnBlackContext;
    if (f1 === 1 && b1 && !b2) c += WEIGHTS.thumbOnBlackContext;
    if (f2 === 5 && b2 && !b1) c += WEIGHTS.fiveOnBlackContext;
    if (f1 === 5 && b1 && !b2) c += WEIGHTS.fiveOnBlackContext;
    if (fa === 1 && d < 0) {
      // thumb passing (thumb under / finger over)
      const n1Lower = m1 < m2;
      const lowerF = n1Lower ? f1 : f2;
      const upperF = n1Lower ? f2 : f1;
      const lowerB = n1Lower ? b1 : b2;
      const upperB = n1Lower ? b2 : b1;
      if (lowerB === upperB) c += WEIGHTS.thumbPassSameLevel;
      else if (!lowerB && lowerF !== 1 && upperB && upperF === 1) c += WEIGHTS.thumbPassWhiteToBlack;
    }
    return c;
  }

  /** Parncutt rules 4, 5, 7 for three consecutive single notes. */
  triple(m1: number, f1: number, m2: number, f2: number, m3: number, f3: number): number {
    let c = 0;
    if (f1 !== f2 && f2 !== f3 && f1 !== f3 && f1 + f2 + f3 === 12 && Math.min(f1, f2, f3) === 3) {
      c += WEIGHTS.threeFourFive;
    }
    if (f1 === f3) {
      const d = Math.abs(m3 - m1);
      if (d > 0) c += WEIGHTS.positionChangeHalf + 0.5 * d;
      return c;
    }
    const [fa, fb, d] = this.orient(m1, f1, m3, f3);
    const [minP, minC, , , maxC, maxP] = this.span(fa, fb);
    if (d > maxC || d < minC) {
      const between = (m2 - m1) * (m3 - m2) > 0;
      const full = f2 === 1 && between && (d > maxP || d < minP);
      c += full ? WEIGHTS.positionChangeFull : WEIGHTS.positionChangeHalf;
      c += WEIGHTS.positionChangeSize * (d > maxC ? d - maxC : minC - d);
    }
    return c;
  }

  /** Implied position of the thumb (white-key units) for a note played with finger f. */
  thumbPos(midi: number, f: number): number {
    return this.hand === 'R' ? keyPosition(midi) - (f - 1) : keyPosition(midi) + (f - 1);
  }
}

interface FEvent {
  onset: number;
  /** latest release time among the notes */
  end: number;
  notes: NoteEvent[];
  /** notes with the same pitch as one in `notes` (unison between voices) */
  dupes: Map<NoteEvent, NoteEvent>;
  states: number[][];
  unary: number[];
  /** implied thumb position per state */
  pos: number[];
  mono: boolean;
  /** 0.25..1, how fast the surrounding notes are (scales weak-finger penalties) */
  speed: number;
}

function combinations(k: number): number[][] {
  const out: number[][] = [];
  const rec = (startF: number, acc: number[]) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let f = startF; f <= 5; f++) {
      acc.push(f);
      rec(f + 1, acc);
      acc.pop();
    }
  };
  rec(1, []);
  return out;
}

const COMBOS = [0, 1, 2, 3, 4, 5].map((k) => (k === 0 ? [[]] : combinations(k)));

function buildEvents(notes: NoteEvent[], secPerQuarter: number): FEvent[] {
  const sorted = notes.slice().sort((a, b) => a.onset - b.onset || a.midi - b.midi);
  const events: FEvent[] = [];
  let i = 0;
  while (i < sorted.length) {
    const onset = sorted[i].onset;
    const group: NoteEvent[] = [];
    while (i < sorted.length && sorted[i].onset - onset < EPS * 10) group.push(sorted[i++]);
    const dupes = new Map<NoteEvent, NoteEvent>();
    const unique: NoteEvent[] = [];
    for (const n of group) {
      const same = unique.find((u) => u.midi === n.midi);
      if (same) dupes.set(n, same);
      else unique.push(n);
    }
    let chosen = unique;
    if (unique.length > 5) {
      const k = unique.length;
      const idx = Array.from(new Set([0, Math.round(k / 4), Math.round(k / 2), Math.round((3 * k) / 4), k - 1]));
      chosen = idx.map((j) => unique[j]);
    }
    const end = Math.max(...group.map((n) => n.onset + n.duration));
    events.push({
      onset,
      end,
      notes: chosen,
      dupes,
      states: [],
      unary: [],
      pos: [],
      mono: chosen.length === 1,
      speed: 1,
    });
  }
  // speed factor: weak fingers matter in fast passages, much less on long notes
  for (let j = 0; j < events.length; j++) {
    const prev = j > 0 ? events[j].onset - events[j - 1].onset : Infinity;
    const next = j + 1 < events.length ? events[j + 1].onset - events[j].onset : Infinity;
    const ioi = Math.min(prev, next) * secPerQuarter;
    events[j].speed = Number.isFinite(ioi) ? Math.min(1, Math.max(0.25, 0.4 / Math.max(ioi, 0.05))) : 0.5;
  }
  return events;
}

/** Computes fingers for all notes of one hand. Mutates note.finger / note.fingerSource. */
export function fingerHand(allNotes: NoteEvent[], hand: Hand, opts: FingeringOptions = {}): void {
  const notes = allNotes.filter((n) => n.hand === hand);
  for (const n of notes) {
    n.finger = undefined;
    n.fingerSource = undefined;
  }
  if (!notes.length) return;
  const model = new CostModel(hand, opts.handSize ?? 'medium');
  const overrides = opts.overrides ?? {};
  const patternFingers = opts.patternFingers ?? {};
  const useScore = opts.useScoreFingerings ?? true;
  const secPerQuarter = 60 / (opts.tempo ?? 90);
  const events = buildEvents(notes, secPerQuarter);

  // candidate states and unary costs
  for (const ev of events) {
    const k = ev.notes.length;
    let states = COMBOS[k].map((combo) => (hand === 'R' ? combo.slice() : combo.slice().reverse()));
    const forced = ev.notes.map((n) => overrides[n.key] ?? (useScore ? n.scoreFinger : undefined) ?? patternFingers[n.key]);
    if (forced.some((f) => f !== undefined)) {
      const filtered = states.filter((s) => s.every((f, j) => forced[j] === undefined || forced[j] === f));
      if (filtered.length) states = filtered;
    }
    ev.states = states;
    ev.unary = states.map((s) => unaryCost(model, ev, s));
    ev.pos = states.map((s) => s.reduce((acc, f, j) => acc + model.thumbPos(ev.notes[j].midi, f), 0) / k);
  }

  const n = events.length;
  const choice: number[] = new Array(n).fill(0);

  const legatoBetween = (a: FEvent, b: FEvent) => {
    const ioi = (b.onset - a.onset) * secPerQuarter;
    const gap = b.onset - a.end;
    return ioi < 0.9 && gap < 0.25;
  };

  if (n === 1) {
    choice[0] = argmin(events[0].unary);
  } else {
    // pairwise matrices
    const pair: Float64Array[] = new Array(n);
    const legato: boolean[] = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
      const A = events[i - 1];
      const B = events[i];
      legato[i] = legatoBetween(A, B);
      const shiftW = legato[i] ? WEIGHTS.shiftLegato : WEIGHTS.shiftFree;
      const m = new Float64Array(A.states.length * B.states.length);
      for (let p = 0; p < A.states.length; p++) {
        for (let q = 0; q < B.states.length; q++) {
          m[p * B.states.length + q] =
            transitionCost(model, A, A.states[p], B, B.states[q], legato[i]) + shiftW * Math.abs(A.pos[p] - B.pos[q]);
        }
      }
      pair[i] = m;
    }

    // second-order Viterbi: dp[p*|S_i|+q] = best cost ending with (state p at i-1, state q at i)
    let dpPrev = new Float64Array(events[0].states.length * events[1].states.length);
    const backs: Int32Array[] = new Array(n);
    {
      const S0 = events[0].states.length;
      const S1 = events[1].states.length;
      for (let p = 0; p < S0; p++)
        for (let q = 0; q < S1; q++)
          dpPrev[p * S1 + q] = events[0].unary[p] + events[1].unary[q] + pair[1][p * S1 + q];
    }
    for (let i = 2; i < n; i++) {
      const R = events[i - 2];
      const P = events[i - 1];
      const Q = events[i];
      const SR = R.states.length;
      const SP = P.states.length;
      const SQ = Q.states.length;
      const dp = new Float64Array(SP * SQ);
      const back = new Int32Array(SP * SQ);
      const needTriple = R.mono && P.mono && Q.mono && legato[i - 1] && legato[i];
      const needHeld = R.end > Q.onset + 0.01;
      for (let p = 0; p < SP; p++) {
        // best predecessor is independent of q when no triple / held cost is needed
        let bestR = -1;
        let bestV = Infinity;
        if (!needTriple && !needHeld) {
          for (let r = 0; r < SR; r++) {
            const v = dpPrev[r * SP + p];
            if (v < bestV) {
              bestV = v;
              bestR = r;
            }
          }
        }
        for (let q = 0; q < SQ; q++) {
          let best = bestV;
          let arg = bestR;
          if (needTriple || needHeld) {
            best = Infinity;
            arg = -1;
            for (let r = 0; r < SR; r++) {
              let v = dpPrev[r * SP + p];
              if (needTriple) {
                v += model.triple(
                  R.notes[0].midi, R.states[r][0], P.notes[0].midi, P.states[p][0], Q.notes[0].midi, Q.states[q][0],
                );
              }
              if (needHeld) v += heldCost(model, R, R.states[r], Q, Q.states[q]);
              if (v < best) {
                best = v;
                arg = r;
              }
            }
          }
          dp[p * SQ + q] = best + pair[i][p * SQ + q] + Q.unary[q];
          back[p * SQ + q] = arg;
        }
      }
      backs[i] = back;
      dpPrev = dp;
    }
    // termination
    const SPl = events[n - 2].states.length;
    const SQl = events[n - 1].states.length;
    let best = Infinity;
    let bp = 0;
    let bq = 0;
    for (let p = 0; p < SPl; p++)
      for (let q = 0; q < SQl; q++) {
        const v = dpPrev[p * SQl + q];
        if (v < best) {
          best = v;
          bp = p;
          bq = q;
        }
      }
    choice[n - 1] = bq;
    choice[n - 2] = bp;
    for (let i = n - 1; i >= 2; i--) {
      const SQ = events[i].states.length;
      choice[i - 2] = backs[i][choice[i - 1] * SQ + choice[i]];
    }
  }

  events.forEach((ev, i) => {
    const s = ev.states[choice[i]];
    ev.notes.forEach((note, j) => {
      note.finger = s[j];
      note.fingerSource =
        overrides[note.key] !== undefined
          ? 'user'
          : useScore && note.scoreFinger === s[j]
            ? 'score'
            : patternFingers[note.key] === s[j]
              ? 'pattern'
              : 'auto';
    });
    for (const [dupe, orig] of ev.dupes) {
      dupe.finger = orig.finger;
      dupe.fingerSource = orig.fingerSource;
    }
  });
}

function argmin(a: number[]): number {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] < a[best]) best = i;
  return best;
}

function unaryCost(model: CostModel, ev: FEvent, s: number[]): number {
  let c = 0;
  const k = ev.notes.length;
  for (let j = 0; j < k; j++) {
    const f = s[j];
    const black = isBlackKey(ev.notes[j].midi);
    if (k === 1) {
      if (f === 4) c += WEIGHTS.weak4 * ev.speed;
      if (f === 5) c += WEIGHTS.weak5 * ev.speed;
      if (f === 1 && black) c += WEIGHTS.thumbOnBlack;
    } else {
      if (f >= 4) c += WEIGHTS.chordWeak;
      if (f === 1 && black) c += WEIGHTS.thumbOnBlack * 0.5;
    }
  }
  for (let j = 0; j + 1 < k; j++) {
    c += model.chordPair(ev.notes[j].midi, s[j], ev.notes[j + 1].midi, s[j + 1]);
  }
  if (k >= 2) {
    const lowF = s[0];
    const highF = s[k - 1];
    const fa = Math.min(lowF, highF);
    const fb = Math.max(lowF, highF);
    const d = ev.notes[k - 1].midi - ev.notes[0].midi;
    if (k >= 3) {
      // the outer interval must also fit in the hand
      const [, , , , maxC, maxP] = model.span(fa, fb, true);
      if (d > maxP) c += WEIGHTS.impractical + WEIGHTS.impracticalSlope * (d - maxP);
      else if (d > maxC) c += d - maxC;
    }
    // wide chords (a fifth or more) are normally taken with the thumb and the fifth finger
    if (d >= 7 && !(fa === 1 && fb === 5)) c += WEIGHTS.chordOuterFingers;
  }
  return c;
}

function transitionCost(model: CostModel, A: FEvent, sA: number[], B: FEvent, sB: number[], legato: boolean): number {
  let total = 0;
  let count = 0;
  for (let a = 0; a < A.notes.length; a++) {
    for (let b = 0; b < B.notes.length; b++) {
      total += model.seq(A.notes[a].midi, sA[a], B.notes[b].midi, sB[b], legato);
      count++;
    }
  }
  let c = count ? total / count : 0;
  c += heldCost(model, A, sA, B, sB);
  return c;
}

/** Notes of `prev` still sounding when `cur` starts occupy their fingers and limit the hand span. */
function heldCost(model: CostModel, prev: FEvent, sPrev: number[], cur: FEvent, sCur: number[]): number {
  if (prev.end <= cur.onset + 0.01) return 0;
  let c = 0;
  for (let a = 0; a < prev.notes.length; a++) {
    const na = prev.notes[a];
    if (na.onset + na.duration <= cur.onset + 0.01) continue;
    const fa = sPrev[a];
    for (let b = 0; b < cur.notes.length; b++) {
      const nb = cur.notes[b];
      const fb = sCur[b];
      if (nb.midi === na.midi) continue;
      if (fb === fa) {
        c += WEIGHTS.heldBusyFinger;
        continue;
      }
      const [low, fl, high, fh] = na.midi < nb.midi ? [na.midi, fa, nb.midi, fb] : [nb.midi, fb, na.midi, fa];
      c += 0.7 * model.chordPair(low, fl, high, fh);
    }
  }
  return c;
}

/** Computes fingering for both hands. */
export function computeFingering(notes: NoteEvent[], opts: FingeringOptions = {}): void {
  fingerHand(notes, 'R', opts);
  fingerHand(notes, 'L', opts);
}
