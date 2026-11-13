import { describe, expect, it } from 'vitest';
import type { NoteEvent, Score } from '../web/src/lib/model';
import { parseScore } from '../web/src/lib/musicxml';
import { applyNoteEdit, keyAlter, rekeyOverride, type NoteEdit } from '../web/src/lib/noteEdit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const example = (name: string) => readFileSync(resolve(__dirname, '../web/src/examples', name), 'utf8');
const notesAt = (s: Score, hand: 'R' | 'L', measure: number) =>
  s.notes.filter((n) => n.hand === hand && n.measureIndex === measure && !n.grace).sort((a, b) => a.onset - b.onset || a.midi - b.midi);
const name = (n: NoteEvent) => `${n.step}${n.alter > 0 ? '#' : n.alter < 0 ? 'b' : ''}${n.octave}`;

function edit(xml: string, pick: (s: Score) => NoteEvent, e: NoteEdit) {
  const s = parseScore(xml);
  const r = applyNoteEdit(xml, s, pick(s), e);
  return { ...r, score: parseScore(r.xml) };
}

describe('editing notes of a piece', () => {
  const ode = example('ode-to-joy.musicxml');

  it('moves a note one line or space up or down along the key, and by an octave', () => {
    const up = edit(ode, (s) => notesAt(s, 'R', 0)[0], { kind: 'step', by: 1 });
    expect(notesAt(up.score, 'R', 0).map(name)).toEqual(['F4', 'E4', 'F4', 'G4']);
    expect(up.select).not.toBeNull();
    const down = edit(ode, (s) => notesAt(s, 'R', 0)[0], { kind: 'step', by: -1 });
    expect(notesAt(down.score, 'R', 0).map(name)[0]).toBe('D4');
    const oct = edit(ode, (s) => notesAt(s, 'R', 0)[0], { kind: 'octave', by: 1 });
    expect(notesAt(oct.score, 'R', 0).map(name)[0]).toBe('E5');
    // nothing else changes: same number of notes, same rhythm
    expect(up.score.notes.length).toBe(parseScore(ode).notes.length);
  });

  it('sets a sharp, flat or natural and prints the sign only where it is needed', () => {
    const sharp = edit(ode, (s) => notesAt(s, 'R', 0)[2], { kind: 'alter', alter: 1 });
    const fs = notesAt(sharp.score, 'R', 0)[2];
    expect(name(fs)).toBe('F#4');
    expect(fs.accidental).toBe('sharp');
    expect(sharp.xml).toContain('<accidental>sharp</accidental>');
    // back to natural: the key gives F, no sign needed
    const back = applyNoteEdit(sharp.xml, sharp.score, fs, { kind: 'alter', alter: 0 });
    const f = notesAt(parseScore(back.xml), 'R', 0)[2];
    expect(name(f)).toBe('F4');
    expect(f.accidental).toBeUndefined();
  });

  it('follows the key signature: in A major one step up from F♯ is G♯', () => {
    expect(keyAlter('G', 3)).toBe(1);
    expect(keyAlter('D', 3)).toBe(0);
    expect(keyAlter('B', -1)).toBe(-1);
    expect(keyAlter('E', -1)).toBe(0);
  });

  it('deletes a chord note, a chord leader, or turns a single note into a rest', () => {
    const tw = example('twinkle.musicxml');
    const chord = (s: Score) => notesAt(s, 'L', 0);
    expect(chord(parseScore(tw)).map(name)).toEqual(['C3', 'E3', 'G3']);
    const middle = edit(tw, (s) => chord(s)[1], { kind: 'delete' });
    expect(chord(middle.score).map(name)).toEqual(['C3', 'G3']);
    expect(middle.select).toBeNull();
    // the first note of a chord: the next one takes the lead, the chord keeps its length
    const lead = parseScore(tw).notes.filter((n) => n.hand === 'L' && n.measureIndex === 0);
    const leader = lead.find((n) => n.xmlIndex === Math.min(...lead.map((x) => x.xmlIndex)))!;
    const r = applyNoteEdit(tw, parseScore(tw), leader, { kind: 'delete' });
    const after = chord(parseScore(r.xml));
    expect(after).toHaveLength(2);
    expect(after.every((n) => n.onset === 0 && n.duration === 4)).toBe(true);
    // a single note becomes a rest: the other notes keep their places
    const single = edit(ode, (s) => notesAt(s, 'R', 0)[1], { kind: 'delete' });
    expect(notesAt(single.score, 'R', 0).map((n) => `${name(n)}@${n.onset}`)).toEqual(['E4@0', 'F4@2', 'G4@3']);
  });

  it('adds a chord note a third above and selects it', () => {
    const add = edit(ode, (s) => notesAt(s, 'R', 0)[0], { kind: 'addAbove' });
    expect(notesAt(add.score, 'R', 0).map((n) => `${name(n)}@${n.onset}`)).toEqual(['E4@0', 'G4@0', 'E4@1', 'F4@2', 'G4@3']);
    const added = add.score.notes.find((n) => n.xmlIndex === add.select)!;
    expect(name(added)).toBe('G4');
  });

  it('changes a tied note together with its continuation', () => {
    const note = (step: string, oct: number, tie: string) =>
      `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>4</duration>${tie ? `<tie type="${tie}"/>` : ''}<voice>1</voice><type>half</type><staff>1</staff>${tie ? `<notations><tied type="${tie}"/></notations>` : ''}</note>`;
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${note('C', 5, '')}${note('E', 5, 'start')}</measure>
      <measure number="2">${note('E', 5, 'stop')}${note('D', 5, '')}</measure></part></score-partwise>`;
    const s = parseScore(xml);
    const tiedNote = s.notes.find((n) => n.tieContinuations.length)!;
    const r = applyNoteEdit(xml, s, tiedNote, { kind: 'step', by: -1 });
    const t = parseScore(r.xml);
    const changed = t.notes.find((n) => n.tieContinuations.length)!;
    expect(name(changed)).toBe('D5');
    expect(changed.duration).toBe(4);
  });

  it('keeps a finger choice when the pitch of its note changes', () => {
    expect(rekeyOverride('0:3:1:1:0:73', 72)).toBe('0:3:1:1:0:72');
    expect(rekeyOverride('0:3:1:1:500:61g', 62)).toBe('0:3:1:1:500:62g');
  });
});
