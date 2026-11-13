import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Hand } from '../web/src/lib/model';
import { analyzePatterns } from '../web/src/lib/patterns';
import { buildGuide, stepKey, stepSpan } from '../web/src/lib/piece';
import { loadExample } from './helpers';

describe('segmentation', () => {
  it('covers every note of a hand with its fragments, in order and without overlaps, in every mode', () => {
    for (const f of ['ode-to-joy.musicxml', 'minuet-in-g.musicxml', 'c-major-scale.musicxml', 'twinkle.musicxml']) {
      const s = loadExample(f);
      for (const mode of ['auto', 1, 2, 4, 8] as const) {
        const { blocks, families } = analyzePatterns(s, mode);
        for (const hand of ['R', 'L'] as Hand[]) {
          const mine = blocks.filter((b) => b.hand === hand);
          let prevEnd = -1;
          for (const b of mine) {
            // a fragment may start with an upbeat inside the previous measure, right where the previous one ends
            expect(b.start).toBeGreaterThanOrEqual(prevEnd - 1e-6);
            expect(b.end).toBeGreaterThan(b.start);
            expect(b.endMeasure).toBeGreaterThanOrEqual(b.coreStart ?? b.startMeasure);
            expect(families[b.family].blocks).toContain(b.index);
            expect(families[b.family].hand).toBe(hand);
            prevEnd = b.end;
          }
          for (const n of s.notes) {
            if (n.hand !== hand || n.grace) continue;
            expect(mine.some((b) => n.onset >= b.start - 1e-6 && n.onset < b.end - 1e-6)).toBe(true);
          }
        }
      }
    }
  });

  it('builds a full guide: steps, analyses and fingering in the rendered score', () => {
    const g = buildGuide(loadExample('minuet-in-g.musicxml'), DEFAULT_SETTINGS);
    expect(g.renderXml).toContain('<fingering');
    expect(g.analyses).toHaveLength(g.steps.length);
    expect(g.steps[0]).toMatchObject({ kind: 'pattern' });
    for (const a of g.analyses) expect(a.plan.length).toBeGreaterThan(2);
    // a step for one hand is analysed for that hand only
    const leftStep = g.steps.findIndex((st) => st.kind === 'pattern' && g.blocks[st.block].hand === 'L');
    expect(g.analyses[leftStep].noteCount.R).toBe(0);
    expect(g.analyses[leftStep].noteCount.L).toBeGreaterThan(0);
    // keys of steps are unique, spans are inside the piece
    const keys = g.steps.map((st) => stepKey(g.score, g.blocks, st));
    expect(new Set(keys).size).toBe(keys.length);
    for (const st of g.steps) {
      const sp = stepSpan(g.score, g.blocks, st);
      expect(sp.startMeasure).toBeGreaterThanOrEqual(0);
      expect(sp.endMeasure).toBeLessThan(g.score.measures.length);
    }
  });

  it('gives every appearance of a pattern the same fingering', () => {
    const g = buildGuide(loadExample('ode-to-joy.musicxml'), DEFAULT_SETTINGS);
    const [a, a1] = g.blocks.filter((b) => b.hand === 'R');
    const fingers = (b: typeof a) =>
      g.score.notes
        .filter((n) => n.hand === 'R' && n.measureIndex >= b.startMeasure && n.measureIndex < b.startMeasure + 3)
        .map((n) => n.finger)
        .join('');
    expect(fingers(a1)).toBe(fingers(a));
  });
});
