import { describe, expect, it } from 'vitest';
import { fingerLabel, markFingerMoves } from '../web/src/lib/fingering';
import type { NoteEvent } from '../web/src/lib/model';
import { DEFAULT_SETTINGS } from '../web/src/lib/model';
import { buildGuide } from '../web/src/lib/piece';
import { loadExample } from './helpers';

const note = (id: number, onset: number, midi: number, finger: number, hand: 'R' | 'L' = 'R') =>
  ({ id, onset, midi, finger, hand, grace: false }) as unknown as NoteEvent;

describe('finger move marks', () => {
  it('marks a finger that presses another key than the last time it was used', () => {
    // C D E F G with the thumb passing under at F, then back down to C
    const notes = [
      note(0, 0, 60, 1),
      note(1, 1, 62, 2),
      note(2, 2, 64, 3),
      note(3, 3, 65, 1), // thumb: C → F
      note(4, 4, 67, 2), // 2: D → G
      note(5, 5, 65, 1), // thumb back on F: same key
      note(6, 6, 64, 3), // 3: E again: same key
      note(7, 7, 60, 1), // thumb: F → C
    ];
    markFingerMoves(notes);
    expect(notes.map((n) => n.fingerMove ?? 0)).toEqual([0, 0, 0, 1, 1, 0, 0, -1]);
    expect(notes.map(fingerLabel)).toEqual(['1', '2', '3', '1→', '2→', '1', '3', '1←']);
  });

  it('tracks each hand separately', () => {
    const notes = [note(0, 0, 60, 1, 'R'), note(1, 0, 48, 1, 'L'), note(2, 1, 62, 1, 'R'), note(3, 1, 48, 1, 'L')];
    markFingerMoves(notes);
    expect(notes.map((n) => n.fingerMove ?? 0)).toEqual([0, 0, 1, 0]);
  });

  it('puts the marks into the rendered notation only', () => {
    const g = buildGuide(loadExample('c-major-scale.musicxml'), DEFAULT_SETTINGS);
    const moved = g.score.notes.filter((n) => n.fingerMove);
    expect(moved.length).toBeGreaterThan(0);
    expect(g.renderXml).toMatch(/<fingering[^>]*>\d[→←]<\/fingering>/);
    expect(g.exportXml).not.toMatch(/[→←]/);
  });
});

describe('finger move marks on a semitone', () => {
  it('marks a finger that goes from A to G♯ (white key to the black key next to it)', () => {
    // bar 3 ends with A4 on finger 2; bar 4 is the chord E♯4 + G♯4 on fingers 1 and 2
    const notes = [note(0, 0, 66, 1), note(1, 0, 74, 5), note(2, 3, 69, 2), note(3, 4, 65, 1), note(4, 4, 68, 2)];
    markFingerMoves(notes);
    expect(notes.map(fingerLabel)).toEqual(['1', '5', '2', '1←', '2←']);
    // the same key again: no mark
    const again = [note(0, 0, 69, 2), note(1, 1, 69, 2)];
    markFingerMoves(again);
    expect(again.map(fingerLabel)).toEqual(['2', '2']);
  });
});
