import { describe, expect, it } from 'vitest';
import { computeFingering } from '../web/src/lib/fingering';
import { parseScore } from '../web/src/lib/musicxml';
import { parseToken, transcriptionToMusicXml } from '../web/src/lib/omr/notation';
import { loadExample } from './helpers';

describe('compact notation tokens', () => {
  it('parses notes, chords, rests, dots, triplets, ties and fingering', () => {
    expect(parseToken('C4:q')).toMatchObject({ rest: false, quarters: 1, type: 'quarter' });
    expect(parseToken('F#5:e.')).toMatchObject({ quarters: 0.75, dots: 1, pitches: [{ step: 'F', alter: 1, octave: 5 }] });
    expect(parseToken('Bb3+D4+F4:h')!.pitches.map((p) => p.alter)).toEqual([-1, 0, 0]);
    expect(parseToken('E5@3:eT')).toMatchObject({ triplet: true, pitches: [{ finger: 3 }] });
    expect(parseToken('E5:eT')!.quarters).toBeCloseTo(1 / 3);
    expect(parseToken('C5:h~')!.tie).toBe(true);
    expect(parseToken('r:8')).toMatchObject({ rest: true, quarters: 0.5 });
    expect(parseToken('r:m')).toMatchObject({ measureRest: true });
    expect(parseToken('c4:4')).toMatchObject({ pitches: [{ step: 'C', octave: 4 }] });
    expect(parseToken('H4:q')).toBeNull();
    expect(parseToken('C4')).toBeNull();
  });
});

describe('transcription → MusicXML', () => {
  it('rebuilds the Minuet exactly as the reference score', () => {
    const t = {
      title: 'Minuet', composer: 'Petzold', keyFifths: 1, time: '3/4', tempo: 112, staves: 2,
      measures: [
        { rh: 'D5:q G4:e A4:e B4:e C5:e', lh: 'G3+B3+D4:h A3:q' },
        { rh: 'D5:q G4:q G4:q', lh: 'B3:h.' },
        { rh: 'E5:q C5:e D5:e E5:e F#5:e', lh: 'C4:h.' },
        { rh: 'G5:q G4:q G4:q', lh: 'B3:h.' },
      ],
    };
    const res = transcriptionToMusicXml(t);
    expect(res.warnings).toEqual([]);
    const score = parseScore(res.xml);
    const ref = loadExample('minuet-in-g.musicxml');
    const sig = (s: typeof score) =>
      s.notes.filter((n) => n.measureIndex < 4).map((n) => `${n.onset.toFixed(3)}:${n.midi}:${n.duration.toFixed(3)}:${n.hand}`);
    expect(sig(score)).toEqual(sig(ref));
    expect(score.title).toBe('Minuet');
    expect(score.tempoMap[0].bpm).toBe(112);
    expect(score.measures[0].fifths).toBe(1);
  });

  it('handles pickups, ties across bars, two voices, triplets and printed fingering', () => {
    const res = transcriptionToMusicXml({
      keyFifths: 0, time: '4/4', staves: 2,
      measures: [
        { rh: 'G4:q', lh: 'r:q' },
        { rh: ['E5:h D5:h~', 'C5:q B4:q A4:h'], lh: 'C3:w' },
        { rh: 'D5:q C5@1:eT D5:eT E5:eT F5:h', lh: 'r:m' },
      ],
    });
    const s = parseScore(res.xml);
    expect(s.measures[0].implicit).toBe(true);
    expect(s.measures.map((m) => m.number)).toEqual(['0', '1', '2']);
    const d5 = s.notes.find((n) => n.midi === 74 && n.measureIndex === 1)!;
    expect(d5.duration).toBeCloseTo(3); // half tied to the next quarter
    expect(s.notes.filter((n) => n.measureIndex === 1 && n.hand === 'R')).toHaveLength(5);
    const trip = s.notes.filter((n) => n.tuplet);
    expect(trip).toHaveLength(3);
    expect(trip[1].onset - trip[0].onset).toBeCloseTo(1 / 3);
    expect(s.notes.find((n) => n.midi === 72 && n.measureIndex === 2)!.scoreFinger).toBe(1);
    computeFingering(s.notes, {});
    expect(s.notes.every((n) => n.finger)).toBe(true);
  });

  it('skips tokens it cannot read and reports them', () => {
    const res = transcriptionToMusicXml({ time: '3/4', measures: [{ rh: 'C4:q ??? E4:q', lh: 'C3:h.' }] });
    expect(res.warnings[0]).toMatch(/не понял/);
    expect(parseScore(res.xml).notes).toHaveLength(3);
  });
});
