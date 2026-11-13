import { describe, expect, it } from 'vitest';
import { belowThresholdText, diffLines, similarityText, steadyHandText } from '../web/src/lib/patternText';
import { analyzePatterns, bestMatch, buildSteps, FragmentCache } from '../web/src/lib/patterns';
import { loadExample, loadFile } from './helpers';

function describeStructure(name: string, threshold = 0.8) {
  const s = name.endsWith('.mxl') ? loadFile(name) : loadExample(name);
  const { blocks, families } = analyzePatterns(s, 'auto', threshold);
  const seq = blocks
    .map((b) => `${b.label}[${s.measures[b.startMeasure].number}-${s.measures[b.endMeasure].number}]${b.role === 'variation' ? `~${Math.round(b.similarity * 100)}%${b.transpose ? `t${b.transpose}` : ''}` : b.role === 'repeat' ? '=' : ''}`)
    .join(' ');
  return { s, blocks, families, seq };
}

describe('pattern analysis', () => {
  it('finds the A A′ B A′ structure of Ode to Joy', () => {
    const { blocks, seq } = describeStructure('ode-to-joy.musicxml');
    console.log('ode:', seq);
    expect(blocks.map((b) => b.label)).toEqual(['A', 'A′', 'B', 'A′']);
    expect(blocks[1].role).toBe('variation');
    expect(blocks[3].role).toBe('repeat');
    // A′ differs from A only in its last measure
    const changedMeasures = blocks[1].diff!.measures.filter((m) => m.changed + m.missing + m.rhythm > 0).map((m) => m.offset);
    expect(changedMeasures).toEqual([3]);
  });

  it('recognises repeats, melody repeats over a new bass, and immediate repeats', () => {
    const minuet = describeStructure('minuet-in-g.musicxml');
    console.log('minuet:', minuet.seq);
    expect(minuet.blocks.map((b) => b.label)).toEqual(['A', 'B', 'A′', 'C']);
    // bars 9–12: the right hand is the same as in bars 1–4, only the left hand differs
    expect(minuet.blocks[2].diff!.hands.R).toBe(1);
    expect(minuet.blocks[2].diff!.hands.L).toBeLessThan(0.8);
    // the texts explain why a fragment below the 80 % threshold is still a variation of A
    const a2 = minuet.blocks[2];
    expect(similarityText(minuet.s, a2)).toMatch(/^\d+% \(правая рука — 100%, левая — \d+%\)$/);
    expect(steadyHandText(minuet.s, minuet.families, a2)).toBe('Правая рука повторяет A точно — меняется только левая.');
    if (a2.similarity < 0.8) expect(belowThresholdText(minuet.s, minuet.families, a2, 0.8)).toContain('порога 80%');
    expect(belowThresholdText(minuet.s, minuet.families, a2, 0.7)).toBe('');
    const lines = diffLines(minuet.s, minuet.blocks, minuet.families, a2);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes('левая рука'))).toBe(true);

    const twinkle = describeStructure('twinkle.musicxml');
    console.log('twinkle:', twinkle.seq);
    expect(twinkle.blocks.map((b) => b.label)).toEqual(['A', 'B', 'B', 'A']);
    expect(twinkle.blocks.map((b) => b.role)).toEqual(['base', 'base', 'repeat', 'repeat']);

    const steps = buildSteps(minuet.s, minuet.blocks, minuet.families);
    expect(steps.slice(0, 4).map((st) => (st.kind === 'assemble' ? 'asm' : `${st.kind}:${minuet.blocks[st.block].label}`))).toEqual([
      'pattern:A',
      'variation:A′',
      'pattern:B',
      'pattern:C',
    ]);
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'assemble', whole: true });
  });

  it('measures similarity with transposition', () => {
    const s = loadExample('c-major-scale.musicxml');
    const cache = new FragmentCache(s);
    // the left-hand scale (bars 3–4) is the right-hand scale (bars 1–2) an octave lower in the other hand → no match
    const m = bestMatch(cache.events(0, 2), cache.events(2, 2));
    expect(m.sim).toBeLessThan(0.5);
  });

  it.skipIf(!process.env.FIXTURES)('real scores', () => {
    for (const f of ['joplin_maple_leaf_rag.mxl', 'mozart_k545_movement1_exposition.mxl', 'schoenberg_opus19_movement2.mxl']) {
      const t0 = performance.now();
      const { seq, blocks, families } = describeStructure(process.env.FIXTURES + '/' + f);
      console.log(`${f}: ${blocks.length} fragments, ${families.length} patterns, ${(performance.now() - t0).toFixed(0)} ms\n   ${seq}`);
    }
  });
});
