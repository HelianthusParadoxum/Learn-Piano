import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../web/src/lib/model';
import { diffLines } from '../web/src/lib/patternText';
import { analyzePatterns, buildSteps } from '../web/src/lib/patterns';
import { buildGuide, stepSpan } from '../web/src/lib/piece';
import { upbeatsOf } from '../web/src/lib/upbeat';
import { loadExample } from './helpers';

// «Песенка с затактом»: 4/4, a quarter-note pickup; every phrase starts on beat 4 of the measure before
// and ends on beat 3 of its last measure.
describe('fragments that start with an upbeat and end inside a measure', () => {
  const s = loadExample('upbeat-song.musicxml');

  it('finds the upbeats of the melody: the pickup and beat 4 before each phrase', () => {
    const up = upbeatsOf(s, 'R');
    expect(up.map((u, k) => (u ? k : -1)).filter((k) => k >= 0)).toEqual([1, 5, 9, 13]);
    expect(up[5]).toBe(1);
    // the left hand starts its phrases on the downbeat
    expect(upbeatsOf(s, 'L').every((u) => u === 0)).toBe(true);
  });

  it('cuts the melody at the upbeats, so the last phrase is an exact repeat of the first', () => {
    const { blocks } = analyzePatterns(s);
    const R = blocks.filter((b) => b.hand === 'R');
    expect(R.map((b) => b.label)).toEqual(['A', 'A′', 'B', 'A']);
    // pickup + bars 1–4 up to beat 4; then from beat 4 of bar 4, of bar 8, of bar 12
    expect(R.map((b) => b.start)).toEqual([0, 16, 32, 48]);
    expect(R.map((b) => b.end)).toEqual([16, 32, 48, 64]);
    expect(R.map((b) => b.coreStart)).toEqual([1, 5, 9, 13]);
    expect(R.map((b) => b.startMeasure)).toEqual([0, 4, 8, 12]);
    expect(R[3].role).toBe('repeat');
    // A′ differs from A only in its third bar; the upbeats are the same
    const changed = R[1].diff!.measures.filter((m) => m.changed + m.missing + m.rhythm > 0).map((m) => m.offset);
    expect(changed).toEqual([2]);
  });

  it('describes the differences of a variation with an upbeat', () => {
    const { blocks, families } = analyzePatterns(s);
    const R = blocks.filter((b) => b.hand === 'R');
    expect(diffLines(s, blocks, families, R[1])).toEqual(['Такт 7 (3-й такт паттерна): в A — ми, ми, ре, ре; здесь — ми, ре, до, си.']);
  });

  it('starts the chunks for both hands at the upbeat of the melody', () => {
    const { blocks, families } = analyzePatterns(s);
    const { chunks, steps } = buildSteps(s, blocks, families);
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 32],
      [32, 64],
    ]);
    const together = steps.filter((st) => st.kind === 'together');
    expect(together.map((st) => (st.kind === 'together' ? st.start : -1))).toEqual([0, 32]);
  });

  it('plays and analyses exactly the fragment, upbeat included', () => {
    const g = buildGuide(s, DEFAULT_SETTINGS);
    const variation = g.steps.findIndex((st) => st.kind === 'variation' && g.blocks[st.block].hand === 'R');
    const span = stepSpan(g.score, g.blocks, g.steps[variation]);
    expect([span.start, span.end, span.startMeasure, span.endMeasure, span.coreStart]).toEqual([16, 32, 4, 8, 5]);
    // 1 upbeat note + 3 × 4 quarters + the dotted half
    expect(g.analyses[variation].noteCount.R).toBe(14);
  });
});
