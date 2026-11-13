import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../web/src/lib/model';
import { analyzePatterns } from '../web/src/lib/patterns';
import { buildGuide } from '../web/src/lib/piece';
import { loadExample } from './helpers';

describe('segmentation', () => {
  it('covers all measures without gaps in every mode', () => {
    for (const f of ['ode-to-joy.musicxml', 'minuet-in-g.musicxml', 'c-major-scale.musicxml', 'twinkle.musicxml']) {
      const s = loadExample(f);
      for (const mode of ['auto', 1, 2, 4, 8] as const) {
        const { blocks, families } = analyzePatterns(s, mode);
        let next = 0;
        for (const b of blocks) {
          expect(b.startMeasure).toBe(next);
          expect(b.endMeasure).toBeGreaterThanOrEqual(b.startMeasure);
          expect(families[b.family].blocks).toContain(b.index);
          next = b.endMeasure + 1;
        }
        expect(next).toBe(s.measures.length);
      }
    }
  });

  it('builds a full guide: steps, analyses and fingering in the rendered score', () => {
    const g = buildGuide(loadExample('minuet-in-g.musicxml'), DEFAULT_SETTINGS);
    expect(g.renderXml).toContain('<fingering');
    expect(g.analyses).toHaveLength(g.steps.length);
    expect(g.steps[0]).toMatchObject({ kind: 'pattern' });
    for (const a of g.analyses) expect(a.plan.length).toBeGreaterThan(2);
  });

  it('gives every appearance of a pattern the same fingering', () => {
    const g = buildGuide(loadExample('ode-to-joy.musicxml'), DEFAULT_SETTINGS);
    const [a, a1] = g.blocks;
    const fingers = (b: typeof a) =>
      g.score.notes
        .filter((n) => n.hand === 'R' && n.measureIndex >= b.startMeasure && n.measureIndex < b.startMeasure + 3)
        .map((n) => n.finger)
        .join('');
    expect(fingers(a1)).toBe(fingers(a));
  });
});
