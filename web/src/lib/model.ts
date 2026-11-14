/** Core data model shared by the parser, fingering, segmentation, playback and UI. */

export type Hand = 'R' | 'L';

export interface TieContinuation {
  /** Index of the continuation <note> element in document order. */
  xmlIndex: number;
  measureIndex: number;
  onsetInMeasure: number;
  onset: number;
}

/** A finger's move to another key: the sign is the direction, 1 — up to a tone away, 2 — further. */
export type FingerMove = -2 | -1 | 1 | 2;

export interface NoteEvent {
  id: number;
  midi: number;
  step: string;
  alter: number;
  octave: number;
  /** Onset in quarter notes from the beginning of the piece. */
  onset: number;
  /** Sounding duration in quarter notes (tied notes are merged). */
  duration: number;
  measureIndex: number;
  onsetInMeasure: number;
  partIndex: number;
  /** 1-based staff number within the part. */
  staff: number;
  /** Global staff index across the whole score (0-based, OSMD order). */
  staffIndex: number;
  voice: string;
  hand: Hand | null;
  grace: boolean;
  velocity: number;
  /** Index of the <note> element in document order (for fingering injection). */
  xmlIndex: number;
  tieContinuations: TieContinuation[];
  /** Fingering written in the source file, if any. */
  scoreFinger?: number;
  /** Final finger used in the guide. */
  finger?: number;
  fingerSource?: 'auto' | 'score' | 'user' | 'pattern';
  /**
   * The finger presses another key than the last time it was used (in this hand): the sign is the
   * direction (+ further right, higher; − further left, lower), 1 a semitone or a tone away, 2 further.
   * Unset for the first use of a finger and for the same key.
   */
  fingerMove?: FingerMove;
  /** Stable key used to persist user fingering overrides. */
  key: string;
  dotted: boolean;
  tuplet: boolean;
  /** Accidental explicitly printed next to the note (sharp, flat, natural...). */
  accidental?: string;
}

export interface MeasureInfo {
  index: number;
  number: string;
  start: number;
  length: number;
  nominalLength: number;
  beats: number;
  beatType: number;
  fifths: number;
  implicit: boolean;
  repeatForward: boolean;
  repeatBackward: boolean;
  barStyleRight?: string;
  endingStart?: string;
  endingStop: boolean;
  rehearsal?: string;
  newSystem: boolean;
  newPage: boolean;
  timeChange: boolean;
  keyChange: boolean;
}

export interface StaffInfo {
  partIndex: number;
  staff: number;
  staffIndex: number;
  clef: string;
  hand: Hand | null;
  partName: string;
  noteCount: number;
  meanPitch: number;
}

export interface TempoPoint {
  onset: number;
  bpm: number;
}

export interface Score {
  title: string;
  composer: string;
  /** the file's copyright / license notice (<rights>), shown with the piece */
  rights?: string;
  measures: MeasureInfo[];
  notes: NoteEvent[];
  staves: StaffInfo[];
  tempoMap: TempoPoint[];
  /** True when the tempo came from the file, false when a default was assumed. */
  tempoFromFile: boolean;
  totalLength: number;
  partCount: number;
  /** Parsed source document (never mutated). */
  doc: XMLDocument;
}

/**
 * A fragment of one hand's part (a whole number of measures) and its place in that hand's pattern
 * structure. The right and the left hand are analysed separately.
 */
export interface Block {
  index: number;
  /** the hand whose notes this fragment is about */
  hand: Hand;
  /** measure where the fragment starts (the measure of its upbeat, if it has one) */
  startMeasure: number;
  /** last measure (the fragment may end before its end, where the next fragment's upbeat starts) */
  endMeasure: number;
  /** span in quarters: from the upbeat to where the next fragment's upbeat starts */
  start: number;
  end: number;
  /** first full measure; fragments are compared aligned at its barline */
  coreStart?: number;
  /** pattern family (index into the families list) */
  family: number;
  /** right hand: "A", "A′", "B"…; left hand: "a", "a′", "b"… — exact repeats carry the label of what they repeat */
  label: string;
  /**
   * base = first appearance of a pattern; variation = differs from the base; repeat = the same notes as
   * an earlier block, possibly from another note (`transpose` / `steps`)
   */
  role: 'base' | 'variation' | 'repeat';
  /** for repeats: the earlier identical block (the base or a variation) */
  repeatOf?: number;
  /** transposed copies directly after this block (a sequence) are learned with it: last block of the run */
  sequenceEnd?: number;
  /** member of a sequence: the block that starts the run */
  sequenceOf?: number;
  /** similarity to the family's base, 0..1 */
  similarity: number;
  /** transposition relative to the base, in semitones (0 for diatonic sequences, see `steps`) */
  transpose: number;
  /** transposition along the scale (diatonic sequence), in scale steps */
  steps?: number;
  /** differences from the base (variations and repeats of variations) */
  diff?: BlockDiff;
}

/** Note-level differences of a block from the base of its pattern family (notes of the block's hand). */
export interface BlockDiff {
  /** ids of notes in this block that have no counterpart in the base (new or changed pitch) */
  changed: number[];
  /** ids of notes in this block that match a base note but with a different length */
  rhythm: number[];
  /** ids of base notes that have no counterpart in this block */
  baseUnmatched: number[];
  /** per measure of the block (offset from its first measure) */
  measures: { offset: number; changed: number; missing: number; rhythm: number }[];
}

export interface PatternFamily {
  index: number;
  hand: Hand;
  letter: string;
  /** block index of the first appearance */
  base: number;
  /** all blocks of the family, in order */
  blocks: number[];
}

/**
 * One step of the guide. Every step belongs to a part of the piece (`part`, index into Guide.parts):
 * short pieces have one part, long ones are learned part by part.
 *  - pattern / variation: one hand learns a pattern or a variation of it;
 *  - together: both hands play a chunk for the first time;
 *  - assemble: chunks joined into a longer stretch (`whole` — the entire piece).
 * Two-hand steps span [start, end) in quarters: from an upbeat (in measure `startMeasure`, before the
 * first full measure `coreStart`) to where the next chunk's upbeat starts (in measure `endMeasure`).
 */
export type GuideStep =
  | { kind: 'pattern'; block: number; part: number }
  | { kind: 'variation'; block: number; part: number }
  | { kind: 'together'; startMeasure: number; coreStart: number; endMeasure: number; start: number; end: number; part: number }
  | { kind: 'assemble'; startMeasure: number; coreStart: number; endMeasure: number; start: number; end: number; whole: boolean; part: number };

export interface PieceSettings {
  blockSize: 'auto' | 1 | 2 | 4 | 8;
  handSize: 'small' | 'medium' | 'large';
  noteNames: 'solfege' | 'latin';
  /**
   * How similar two fragments of a hand must be to count as one pattern (0.2…0.9), when chosen in the
   * settings; otherwise DEFAULT_THRESHOLD. (An older `similarity` field holds the former default and is
   * ignored.)
   */
  threshold?: number;
}

/** Fragments of a hand that match by at least this share of notes are one pattern. */
export const DEFAULT_THRESHOLD = 0.5;

export const DEFAULT_SETTINGS: PieceSettings = {
  blockSize: 'auto',
  handSize: 'medium',
  noteNames: 'solfege',
};

export const EPS = 1e-6;
