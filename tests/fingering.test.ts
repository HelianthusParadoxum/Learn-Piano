import { describe, expect, it } from 'vitest';
import { computeFingering } from '../web/src/lib/fingering';
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
    8: '2231', 9: '23431', 10: '23432', 12: '3345', 13: '5432', 14: '1123', 15: '211',
  }, 0.9],
  ['ode-to-joy.musicxml', 'L', { 0: '51', 1: '51', 2: '51', 3: '51', 4: '51', 5: '51', 6: '51' }, 0.9],
  ['minuet-in-g.musicxml', 'R', {
    0: '51234', 1: '511', 2: '31234', 3: '511', 4: '45432', 5: '34321', 6: '21231', 7: '2',
    8: '51234', 9: '511', 10: '31234', 11: '511', 12: '45432', 13: '34321',
  }, 0.9],
  ['minuet-in-g.musicxml', 'L', { 0: '5314', 1: '3', 2: '2', 3: '3', 4: '4', 5: '5', 6: '135' }, 0.8],
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
