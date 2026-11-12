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
  fingerSource?: 'auto' | 'score' | 'user';
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

export interface Block {
  index: number;
  startMeasure: number;
  endMeasure: number;
  start: number;
  end: number;
  /** Index of an earlier block with identical content. */
  repeatOf?: number;
  /** Index of an earlier block with very similar content. */
  similarTo?: number;
  similarity?: number;
}

export interface PieceSettings {
  blockSize: 'auto' | 1 | 2 | 4 | 8;
  handSize: 'small' | 'medium' | 'large';
  noteNames: 'solfege' | 'latin';
}

export const DEFAULT_SETTINGS: PieceSettings = {
  blockSize: 'auto',
  handSize: 'medium',
  noteNames: 'solfege',
};

export const EPS = 1e-6;
