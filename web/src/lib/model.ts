/** Core data model shared by the parser, fingering, segmentation, playback and UI. */

export type Hand = 'R' | 'L';

export interface TieContinuation {
  /** Index of the continuation <note> element in document order. */
  xmlIndex: number;
  measureIndex: number;
  onsetInMeasure: number;
  onset: number;
}

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

/** A fragment of the piece (a whole number of measures) and its place in the pattern structure. */
export interface Block {
  index: number;
  startMeasure: number;
  endMeasure: number;
  start: number;
  end: number;
  /** first measure compared with other fragments (a leading pickup measure is left out) */
  coreStart?: number;
  /** pattern family (index into the families list) */
  family: number;
  /** "A", "A′", "B"… — exact repeats carry the label of what they repeat */
  label: string;
  /** base = first appearance of a pattern; variation = differs from the base; repeat = identical to an earlier block */
  role: 'base' | 'variation' | 'repeat';
  /** for repeats: the earlier identical block (the base or a variation) */
  repeatOf?: number;
  /** similarity to the family's base, 0..1 */
  similarity: number;
  /** transposition relative to the base, in semitones (0 for diatonic sequences, see `steps`) */
  transpose: number;
  /** transposition along the scale (diatonic sequence), in scale steps */
  steps?: number;
  /** differences from the base (variations and repeats of variations) */
  diff?: BlockDiff;
}

/** Note-level differences of a block from the base of its pattern family. */
export interface BlockDiff {
  /** ids of notes in this block that have no counterpart in the base (new or changed pitch) */
  changed: number[];
  /** ids of notes in this block that match a base note but with a different length */
  rhythm: number[];
  /** ids of base notes that have no counterpart in this block */
  baseUnmatched: number[];
  /** per measure of the block (offset from its first measure) */
  measures: { offset: number; changed: number; missing: number; rhythm: number }[];
  /** similarity of each hand to the base (1 = identical) */
  hands: Record<Hand, number>;
}

export interface PatternFamily {
  index: number;
  letter: string;
  /** block index of the first appearance */
  base: number;
  /** all blocks of the family, in order */
  blocks: number[];
}

export type GuideStep =
  | { kind: 'pattern'; block: number }
  | { kind: 'variation'; block: number }
  | { kind: 'assemble'; fromBlock: number; toBlock: number; whole: boolean };

export interface PieceSettings {
  blockSize: 'auto' | 1 | 2 | 4 | 8;
  handSize: 'small' | 'medium' | 'large';
  noteNames: 'solfege' | 'latin';
  /** how similar two fragments must be to count as one pattern (0.7, 0.8 or 0.9) */
  similarity?: number;
}

export const DEFAULT_SETTINGS: PieceSettings = {
  blockSize: 'auto',
  handSize: 'medium',
  noteNames: 'solfege',
  similarity: 0.8,
};

export const EPS = 1e-6;
