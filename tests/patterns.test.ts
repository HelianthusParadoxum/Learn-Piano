import { describe, expect, it } from 'vitest';
import type { Hand } from '../web/src/lib/model';
import { parseScore } from '../web/src/lib/musicxml';
import { diffLines, structureSummary } from '../web/src/lib/patternText';
import { analyzePatterns, bestMatch, buildSteps, FragmentCache, stepOfBlock } from '../web/src/lib/patterns';
import { loadExample, loadFile } from './helpers';

function describeStructure(name: string, threshold = 0.8) {
  const s = name.endsWith('.mxl') ? loadFile(name) : loadExample(name);
  const { blocks, families } = analyzePatterns(s, 'auto', threshold);
  const of = (hand: Hand) => blocks.filter((b) => b.hand === hand);
  const labels = (hand: Hand) => of(hand).map((b) => b.label);
  const seq = (hand: Hand) =>
    of(hand)
      .map((b) => `${b.label}[${s.measures[b.startMeasure].number}-${s.measures[b.endMeasure].number}]${b.role === 'variation' ? `~${Math.round(b.similarity * 100)}%` : b.role === 'repeat' ? '=' : ''}`)
      .join(' ');
  return { s, blocks, families, of, labels, seq };
}

describe('pattern analysis, separately for each hand', () => {
  it('finds A A′ B A′ in the right hand and a a′ b a′ in the left hand of Ode to Joy', () => {
    const { of, labels, families } = describeStructure('ode-to-joy.musicxml');
    expect(labels('R')).toEqual(['A', 'A′', 'B', 'A′']);
    expect(labels('L')).toEqual(['a', 'a′', 'b', 'a′']);
    const R = of('R');
    expect(R[1].role).toBe('variation');
    expect(R[3].role).toBe('repeat');
    // A′ differs from A only in its last measure
    const changedMeasures = R[1].diff!.measures.filter((m) => m.changed + m.missing + m.rhythm > 0).map((m) => m.offset);
    expect(changedMeasures).toEqual([3]);
    expect(families.filter((f) => f.hand === 'R')).toHaveLength(2);
    expect(families.filter((f) => f.hand === 'L')).toHaveLength(2);
  });

  it('recognises a melody repeated over a new accompaniment as the same right-hand pattern', () => {
    const minuet = describeStructure('minuet-in-g.musicxml');
    // bars 9–12 repeat bars 1–4 in the right hand exactly; the left hand is different there
    const R = minuet.of('R');
    const again = R.find((b) => b.startMeasure === 8)!;
    expect(again.label).toBe('A');
    expect(again.role).toBe('repeat');
    expect(minuet.labels('R').filter((l) => l === 'A')).toHaveLength(2);
    // the left hand is analysed on its own
    expect(minuet.of('L').every((b) => b.label === b.label.toLowerCase())).toBe(true);

    const twinkle = describeStructure('twinkle.musicxml');
    expect(twinkle.labels('R')).toEqual(['A', 'B', 'B', 'A']);
    expect(twinkle.of('R').map((b) => b.role)).toEqual(['base', 'base', 'repeat', 'repeat']);
    expect(twinkle.labels('L')).toEqual(['a', 'b', 'a']);
  });

  it('orders the guide: right hand, left hand, then both hands together, then the whole piece', () => {
    const { s, blocks, families } = describeStructure('ode-to-joy.musicxml');
    const { steps, chunks, parts } = buildSteps(s, blocks, families);
    expect(parts).toEqual([[0, 15]]);
    const kinds = steps.map((st) => (st.kind === 'pattern' || st.kind === 'variation' ? `${st.kind}:${blocks[st.block].label}` : st.kind));
    expect(kinds.slice(0, 6)).toEqual(['pattern:A', 'variation:A′', 'pattern:B', 'pattern:a', 'variation:a′', 'pattern:b']);
    expect(kinds).toContain('together');
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'assemble', whole: true });
    // chunks for both hands cover the piece; identical chunks are learned once
    expect(chunks[0].startMeasure).toBe(0);
    expect(chunks[chunks.length - 1].endMeasure).toBe(15);
    const togetherSteps = steps.filter((st) => st.kind === 'together');
    expect(togetherSteps.length).toBe(chunks.filter((c) => c.repeatOf === undefined).length);
    // a repeat leads to the step where its pattern is learned
    const repeat = blocks.find((b) => b.hand === 'R' && b.role === 'repeat')!;
    const target = steps[stepOfBlock(steps, blocks, repeat.index)];
    expect(target.kind === 'variation' && blocks[target.block].label).toBe('A′');
  });

  it('describes the differences of a variation for its hand only', () => {
    const { s, blocks, families, of } = describeStructure('ode-to-joy.musicxml');
    const lines = diffLines(s, blocks, families, of('R')[1]);
    expect(lines).toEqual(['Такт 8 (4-й такт паттерна): в A — ми, ре, ре; здесь — ре, до, до.']);
    const summary = structureSummary(blocks, families);
    expect(summary.map((h) => [h.hand, h.labels, h.patterns])).toEqual([
      ['R', 'A A′ B A′', 2],
      ['L', 'a a′ b a′', 2],
    ]);
    expect(summary[0].learn).toBeLessThan(summary[0].measures);
  });

  it('treats a figure repeated from other notes as one pattern (a sequence)', () => {
    // right hand: a two-bar figure, then the same figure a step lower and two steps lower, then a cadence
    const note = (step: string, oct: number, dur: number, staff: number, type: string) =>
      `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${staff}</voice><type>${type}</type><staff>${staff}</staff></note>`;
    const scale = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const at = (deg: number) => ({ step: scale[((deg % 7) + 7) % 7], oct: 4 + Math.floor(deg / 7) });
    const figure = [7, 9, 11, 9, 7, 8, 9, 4]; // c d e d c d e g  (scale degrees from C4)
    let xml = '';
    for (let m = 0; m < 8; m++) {
      const attrs =
        m === 0
          ? '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
          : '';
      let rh = '';
      if (m < 6) {
        const shift = -Math.floor(m / 2);
        for (let k = 0; k < 4; k++) {
          const p = at(figure[(m % 2) * 4 + k] + shift);
          rh += note(p.step, p.oct, 2, 1, 'quarter');
        }
      } else rh = m === 6 ? note('D', 5, 4, 1, 'half') + note('B', 4, 4, 1, 'half') : note('C', 5, 8, 1, 'whole');
      const lh = note(m % 2 ? 'G' : 'C', 3, 8, 2, 'whole');
      xml += `<measure number="${m + 1}">${attrs}${rh}<backup><duration>8</duration></backup>${lh}</measure>`;
    }
    const s = parseScore(
      `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${xml}</part></score-partwise>`,
    );
    const { blocks } = analyzePatterns(s, 'auto');
    const R = blocks.filter((b) => b.hand === 'R');
    const shifted = R.filter((b) => b.role === 'repeat' && b.steps);
    expect(shifted.length).toBeGreaterThanOrEqual(1);
    expect(shifted.every((b) => b.label === R[0].label)).toBe(true);
    // the copies right after the figure are learned together with it
    expect(R[0].sequenceEnd).toBe(shifted[shifted.length - 1].index);
  });

  it('compares fragments of one hand, with transposition', () => {
    const s = loadExample('c-major-scale.musicxml');
    const right = new FragmentCache(s, 'R');
    // bars 5–6 repeat the right-hand scale of bars 1–2 exactly
    expect(bestMatch(right.events(0, 2), right.events(4, 2)).sim).toBeGreaterThan(0.999);
    // the left hand is not part of right-hand fragments
    expect(right.events(2, 2)).toHaveLength(0);
  });

  it.skipIf(!process.env.FIXTURES)('real scores', () => {
    for (const f of ['joplin_maple_leaf_rag.mxl', 'mozart_k545_movement1_exposition.mxl', 'schoenberg_opus19_movement2.mxl']) {
      const t0 = performance.now();
      const { seq, families } = describeStructure(process.env.FIXTURES + '/' + f);
      console.log(`${f}: ${families.length} patterns, ${(performance.now() - t0).toFixed(0)} ms\n   R: ${seq('R')}\n   L: ${seq('L')}`);
    }
  });
});
