import { describe, expect, it } from 'vitest';
import { computeFingering, markFingerMoves } from '../web/src/lib/fingering';
import { loadExample } from './helpers';

type Ref = Record<number, string>; // measure index -> fingers (notes sorted by onset, then pitch); '?' = any

function compare(name: string, hand: 'R' | 'L', ref: Ref) {
  const score = loadExample(name);
  computeFingering(score.notes, { tempo: score.tempoMap[0].bpm });
  let ok = 0;
  let total = 0;
  const diffs: string[] = [];
  for (const [mStr, exp] of Object.entries(ref)) {
    const m = Number(mStr);
    const got = score.notes
      .filter((n) => n.hand === hand && n.measureIndex === m)
      .sort((a, b) => a.onset - b.onset || a.midi - b.midi)
      .map((n) => n.finger)
      .join('');
    let mOk = true;
    for (let i = 0; i < exp.length; i++) {
      if (exp[i] === '?') continue;
      total++;
      if (exp[i] === got[i]) ok++;
      else mOk = false;
    }
    if (!mOk) diffs.push(`m${m + 1}: expected ${exp} got ${got}`);
  }
  return { ratio: ok / total, diffs };
}

const REFS: [string, 'R' | 'L', Ref, number][] = [
  ['c-major-scale.musicxml', 'R', { 0: '12312345', 1: '4321321', 4: '12312345', 5: '4321321' }, 1],
  ['c-major-scale.musicxml', 'L', { 2: '54321321', 3: '2312345', 4: '54321321', 5: '2312345' }, 1],
  ['ode-to-joy.musicxml', 'R', {
    0: '3345', 1: '5432', 2: '1123', 3: '322', 4: '3345', 5: '5432', 6: '1123', 7: '211',
    8: '2231', 9: '23431', 10: '23432', 11: '121', 12: '3345', 13: '5432', 14: '1123', 15: '211',
  }, 1],
  ['ode-to-joy.musicxml', 'L', {
    0: '51', 1: '51', 2: '51', 3: '51', 4: '51', 5: '51', 6: '51', 8: '51', 9: '51', 10: '51', 12: '51', 13: '51', 14: '51',
  }, 1],
  ['minuet-in-g.musicxml', 'R', {
    0: '51234', 1: '511', 2: '31234', 3: '511', 4: '45432', 5: '34321', 6: '21231', 7: '2',
    8: '51234', 9: '511', 10: '31234', 11: '511', 12: '45432', 13: '34321',
  }, 1],
  ['minuet-in-g.musicxml', 'L', { 0: '5314', 1: '3', 2: '2', 3: '3', 4: '4', 5: '5', 6: '135' }, 1],
  ['twinkle.musicxml', 'R', {
    0: '1144', 1: '554', 2: '4433', 3: '221', 4: '5544', 5: '332', 6: '5544', 7: '332', 8: '1144', 9: '554', 10: '4433', 11: '221',
  }, 1],
];

describe('fingering agreement with textbook fingerings', () => {
  for (const [name, hand, ref, min] of REFS) {
    it(`${name} ${hand}`, () => {
      const { ratio, diffs } = compare(name, hand, ref);
      if (diffs.length) console.log(name, hand, ratio.toFixed(2), '\n  ' + diffs.join('\n  '));
      expect(ratio).toBeGreaterThanOrEqual(min);
    });
  }
});

describe('no hand shift before it is needed', () => {
  it('keeps bar 11 of Ode to Joy in the five-finger position and reaches the low G with the thumb', () => {
    const score = loadExample('ode-to-joy.musicxml');
    computeFingering(score.notes, { tempo: score.tempoMap[0].bpm });
    markFingerMoves(score.notes);
    const bar = (k: number) => score.notes.filter((n) => n.hand === 'R' && n.measureIndex === k - 1).sort((a, b) => a.onset - b.onset);
    // D E F E D fits the hand: no finger moves to another key
    expect(bar(11).map((n) => n.finger)).toEqual([2, 3, 4, 3, 2]);
    expect(bar(11).some((n) => n.fingerMove)).toBe(false);
    // C D and the low G: the thumb reaches down from the hand that stays on D
    expect(bar(12).map((n) => n.finger)).toEqual([1, 2, 1]);
    // and the next phrase starts in the same position again
    expect(bar(13).some((n) => n.fingerMove)).toBe(false);
  });
});
