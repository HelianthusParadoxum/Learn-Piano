/**
 * Fixing notes in the app (recognition errors): edits of the stored MusicXML.
 *
 * A note is found by its document-order index (`NoteEvent.xmlIndex`); its tied continuations change
 * with it. The pitch is what sounds (<pitch>); the printed accidental (<accidental>) is set the way a
 * reader expects it: a sign only where the key signature and earlier notes of the measure do not
 * already give the new pitch.
 */
import { EPS, type NoteEvent, type Score } from './model';
import { NOTE_CHILD_ORDER, parseXmlDocument, serializeXml } from './musicxml';

export type NoteEdit =
  /** one line or space up or down; the key signature (and earlier signs in the measure) apply */
  | { kind: 'step'; by: 1 | -1 }
  | { kind: 'octave'; by: 1 | -1 }
  /** flat, natural or sharp on the same line or space */
  | { kind: 'alter'; alter: -1 | 0 | 1 }
  /** remove the note: from a chord, or replace it by a rest of the same length */
  | { kind: 'delete' }
  /** add a chord note a third above */
  | { kind: 'addAbove' };

export interface Pitch {
  step: string;
  alter: number;
  octave: number;
}

export interface EditResult {
  xml: string;
  /** document index of the note to keep selected after the edit (null: the note is gone) */
  select: number | null;
  /** the new pitch of the edited (or added) note */
  pitch?: Pitch;
}

const STEPS = 'CDEFGAB';
const SHARPS = 'FCGDAEB';
const ACCIDENTAL_NAMES: Record<number, string> = { [-2]: 'flat-flat', [-1]: 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };

/** Alteration of a step given by the key signature (fifths > 0: sharps, < 0: flats). */
export function keyAlter(step: string, fifths: number): number {
  const i = SHARPS.indexOf(step);
  if (fifths > 0 && i < fifths) return 1;
  if (fifths < 0 && 6 - i < -fifths) return -1;
  return 0;
}

/** Alteration in force for a step and octave just before a note: the last sign in the measure, else the key. */
export function alterInForce(score: Score, note: NoteEvent, step: string, octave: number): number {
  const fifths = score.measures[note.measureIndex]?.fifths ?? 0;
  const earlier = score.notes
    .filter(
      (n) =>
        n !== note &&
        !n.grace &&
        n.measureIndex === note.measureIndex &&
        n.staffIndex === note.staffIndex &&
        n.step === step &&
        n.octave === octave &&
        n.onset < note.onset - EPS,
    )
    .sort((a, b) => a.onset - b.onset);
  return earlier.length ? earlier[earlier.length - 1].alter : keyAlter(step, fifths);
}

/** The pitch after an edit (for step, octave, alter and addAbove). */
export function editedPitch(score: Score, note: NoteEvent, edit: NoteEdit): Pitch | null {
  const idx = STEPS.indexOf(note.step);
  if (idx < 0) return null;
  const move = (by: number): Pitch => {
    const pos = note.octave * 7 + idx + by;
    const step = STEPS[((pos % 7) + 7) % 7];
    const octave = Math.floor(pos / 7);
    return { step, octave, alter: alterInForce(score, note, step, octave) };
  };
  switch (edit.kind) {
    case 'step':
      return move(edit.by);
    case 'octave':
      return { step: note.step, alter: note.alter, octave: note.octave + edit.by };
    case 'alter':
      return { step: note.step, alter: edit.alter, octave: note.octave };
    case 'addAbove':
      return move(2);
    default:
      return null;
  }
}

/** The printed sign a pitch needs at the place of a note (null: none). */
function accidentalFor(score: Score, note: NoteEvent, p: Pitch): string | null {
  return p.alter === alterInForce(score, note, p.step, p.octave) ? null : ACCIDENTAL_NAMES[p.alter] ?? null;
}

function kids(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}
function kid(el: Element, tag: string): Element | undefined {
  return kids(el, tag)[0];
}
function make(doc: XMLDocument, near: Element, tag: string): Element {
  return doc.createElementNS(near.namespaceURI, tag);
}
/** Inserts a child of <note> at its place in the MusicXML element order. */
function insertInOrder(note: Element, el: Element) {
  const order = NOTE_CHILD_ORDER.indexOf(el.tagName);
  const after = Array.from(note.children).find((c) => NOTE_CHILD_ORDER.indexOf(c.tagName) > order);
  note.insertBefore(el, after ?? null);
}
function removeAll(el: Element, ...tags: string[]) {
  for (const t of tags) for (const c of kids(el, t)) el.removeChild(c);
}

function setPitch(doc: XMLDocument, note: Element, p: Pitch, accidental: string | null) {
  const pitch = kid(note, 'pitch');
  if (!pitch) return;
  let step = kid(pitch, 'step');
  if (!step) pitch.insertBefore((step = make(doc, pitch, 'step')), pitch.firstChild);
  step.textContent = p.step;
  let alter = kid(pitch, 'alter');
  let octave = kid(pitch, 'octave');
  if (!octave) pitch.appendChild((octave = make(doc, pitch, 'octave')));
  if (p.alter) {
    if (!alter) pitch.insertBefore((alter = make(doc, pitch, 'alter')), octave);
    alter.textContent = String(p.alter);
  } else if (alter) pitch.removeChild(alter);
  octave.textContent = String(p.octave);
  let acc = kid(note, 'accidental');
  if (accidental) {
    if (!acc) insertInOrder(note, (acc = make(doc, note, 'accidental')));
    acc.textContent = accidental;
  } else if (acc) note.removeChild(acc);
}

/** The next <note> of the same chord group, or null (another element or the end of the measure). */
function nextNote(el: Element): Element | null {
  let s = el.nextElementSibling;
  while (s && s.tagName !== 'note') {
    if (s.tagName === 'backup' || s.tagName === 'forward') return null;
    s = s.nextElementSibling;
  }
  return s;
}
const inChord = (el: Element | null) => !!el && !!kid(el, 'chord');

/** Removes one <note>: out of a chord, or turned into a rest of the same length. */
function deleteNote(doc: XMLDocument, el: Element) {
  if (inChord(el)) {
    el.parentNode?.removeChild(el);
    return;
  }
  const next = nextNote(el);
  if (inChord(next)) {
    // the next chord note takes the lead (and the beams)
    removeAll(next!, 'chord');
    if (!kid(next!, 'beam')) for (const b of kids(el, 'beam')) insertInOrder(next!, b.cloneNode(true) as Element);
    el.parentNode?.removeChild(el);
    return;
  }
  const pitch = kid(el, 'pitch');
  if (!pitch) return;
  el.replaceChild(make(doc, el, 'rest'), pitch);
  removeAll(el, 'tie', 'accidental', 'stem', 'notehead', 'notations', 'lyric');
}

/** Applies an edit to a note of the MusicXML document (and to its tied continuations). */
export function applyNoteEdit(xml: string, score: Score, note: NoteEvent, edit: NoteEdit): EditResult {
  const doc = parseXmlDocument(xml);
  const els = Array.from(doc.getElementsByTagName('note'));
  const el = els[note.xmlIndex];
  if (!el || !kid(el, 'pitch')) throw new Error('Нота не найдена в MusicXML');
  const tied = note.tieContinuations.map((c) => els[c.xmlIndex]).filter((x): x is Element => !!x);

  if (edit.kind === 'delete') {
    for (const t of tied) deleteNote(doc, t);
    deleteNote(doc, el);
    return { xml: serializeXml(doc), select: null };
  }

  const p = editedPitch(score, note, edit);
  if (!p) throw new Error('Нельзя изменить эту ноту');
  if (edit.kind === 'addAbove') {
    const add = el.cloneNode(true) as Element;
    removeAll(add, 'chord', 'tie', 'accidental', 'stem', 'beam', 'notations', 'lyric');
    insertInOrder(add, make(doc, add, 'chord'));
    setPitch(doc, add, p, accidentalFor(score, note, p));
    // after the last note of the chord
    let last = el;
    for (let n = nextNote(el); inChord(n); n = nextNote(n!)) last = n!;
    last.parentNode!.insertBefore(add, last.nextSibling);
    return { xml: serializeXml(doc), select: Array.from(doc.getElementsByTagName('note')).indexOf(add), pitch: p };
  }

  setPitch(doc, el, p, accidentalFor(score, note, p));
  // tied continuations sound the same and need no sign
  for (const t of tied) setPitch(doc, t, p, null);
  return { xml: serializeXml(doc), select: note.xmlIndex, pitch: p };
}

/** Key of a note's finger choice after its pitch changed (the key ends with the MIDI number). */
export function rekeyOverride(key: string, midi: number): string {
  return key.replace(/:(\d+)(g?)$/, `:${midi}$2`);
}
