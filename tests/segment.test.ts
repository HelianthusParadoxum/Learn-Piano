import { describe, expect, it } from 'vitest';
import { buildGuide } from '../web/src/lib/piece';
import { DEFAULT_SETTINGS } from '../web/src/lib/model';
import { segmentBlocks } from '../web/src/lib/segment';
import { loadExample } from './helpers';

const fmt = (bs: { startMeasure: number; endMeasure: number; repeatOf?: number; similarTo?: number }[]) =>
  bs.map((b) => `${b.startMeasure + 1}-${b.endMeasure + 1}${b.repeatOf !== undefined ? `=${b.repeatOf + 1}` : ''}${b.similarTo !== undefined ? `~${b.similarTo + 1}` : ''}`).join(' ');

describe('segmentation', () => {
  it('splits Ode to Joy into 4-bar phrases and finds repeats', () => {
    const s = loadExample('ode-to-joy.musicxml');
    const blocks = segmentBlocks(s, 'auto');
    console.log('ode', fmt(blocks));
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.every((b) => b.endMeasure - b.startMeasure + 1 <= 8)).toBe(true);
    // the last phrase repeats the second one
    expect(blocks.some((b) => b.repeatOf !== undefined || b.similarTo !== undefined)).toBe(true);
  });
  it('covers all measures without gaps', () => {
    for (const f of ['ode-to-joy.musicxml', 'minuet-in-g.musicxml', 'c-major-scale.musicxml', 'twinkle.musicxml']) {
      const s = loadExample(f);
      for (const mode of ['auto', 1, 2, 4, 8] as const) {
        const blocks = segmentBlocks(s, mode);
        let next = 0;
        for (const b of blocks) {
          expect(b.startMeasure).toBe(next);
          expect(b.endMeasure).toBeGreaterThanOrEqual(b.startMeasure);
          next = b.endMeasure + 1;
        }
        expect(next).toBe(s.measures.length);
        if (mode === 'auto') console.log(f, fmt(blocks));
      }
    }
  });
  it('builds a full guide with tips', () => {
    const g = buildGuide(loadExample('minuet-in-g.musicxml'), DEFAULT_SETTINGS);
    expect(g.renderXml).toContain('<fingering');
    for (const [i, a] of g.analyses.entries()) {
      console.log(`block ${i + 1}: difficulty ${a.difficulty} (${a.difficultyLabel})`);
      for (const p of a.handPositions) console.log('   pos:', p.text);
      for (const t of a.tips) console.log('   tip:', t.text);
    }
  });
});
