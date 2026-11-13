import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLD, type Hand } from '../web/src/lib/model';
import { parseScore } from '../web/src/lib/musicxml';
import { diffLines, structureSummary } from '../web/src/lib/patternText';
import { analyzePatterns, bestMatch, buildSteps, FragmentCache, matchWindows, stepOfBlock } from '../web/src/lib/patterns';
import { loadExample, loadFile } from './helpers';

function describeStructure(name: string, threshold = DEFAULT_THRESHOLD) {
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
  it('finds A A′ B A′ in the right hand and one left-hand pattern in Ode to Joy (threshold 50 %)', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.5);
    const { of, labels, families } = describeStructure('ode-to-joy.musicxml');
    expect(labels('R')).toEqual(['A', 'A′', 'B', 'A′']);
    // the left hand: bars 9–16 are a variation of bars 1–8 (about 63 % of the notes match)
    expect(labels('L')).toEqual(['a', 'a′']);
    const R = of('R');
    expect(R[1].role).toBe('variation');
    expect(R[3].role).toBe('repeat');
    // A′ differs from A only in its last measure
    const changedMeasures = R[1].diff!.measures.filter((m) => m.changed + m.missing + m.rhythm > 0).map((m) => m.offset);
    expect(changedMeasures).toEqual([3]);
    expect(families.filter((f) => f.hand === 'R')).toHaveLength(2);
    expect(families.filter((f) => f.hand === 'L')).toHaveLength(1);
  });

  it('a stricter threshold gives more patterns', () => {
    const strict = describeStructure('ode-to-joy.musicxml', 0.8);
    expect(strict.labels('R')).toEqual(['A', 'A′', 'B', 'A′']);
    expect(strict.labels('L')).toEqual(['a', 'a′', 'b', 'a′']);
    const minuet = describeStructure('minuet-in-g.musicxml', 0.8);
    expect(minuet.families.filter((f) => f.hand === 'R').length).toBeGreaterThan(
      describeStructure('minuet-in-g.musicxml').families.filter((f) => f.hand === 'R').length,
    );
  });

  it('recognises a melody repeated over a new accompaniment as the same right-hand pattern', () => {
    const minuet = describeStructure('minuet-in-g.musicxml');
    // bars 9–12 repeat bars 1–4 in the right hand exactly; the left hand is different there
    const R = minuet.of('R');
    const again = R.find((b) => b.startMeasure === 8)!;
    expect(again.label).toBe('A');
    expect(again.role).toBe('repeat');
    expect(minuet.labels('R')).toEqual(['A', 'B', 'A', 'B′']);
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
    expect(kinds.slice(0, 5)).toEqual(['pattern:A', 'variation:A′', 'pattern:B', 'pattern:a', 'variation:a′']);
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
      ['L', 'a a′', 1],
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

  it('accepts a match from another note only if it is strong and covers the whole fragment', () => {
    const s = loadExample('twinkle.musicxml');
    const right = new FragmentCache(s, 'R');
    // bars 5–8 contain bars 3–4 a step higher, but bars 5–6 have nothing in common with bars 1–2:
    // a step higher, half of the notes match …
    const shifted = matchWindows(right.events(0, 4), right.events(4, 4), 1, true);
    expect(shifted.sim).toBeGreaterThanOrEqual(0.5);
    // … but that is not "the whole figure from another note", so the shift is not used
    const best = bestMatch(right.events(0, 4), right.events(4, 4));
    expect(best.steps).toBe(0);
    expect(best.sim).toBeLessThan(0.5);
    // a weak shifted match is not accepted either
    expect(bestMatch(right.events(0, 4), right.events(4, 4), 0.99).steps).toBe(0);
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

describe('a phrase repeated a step higher with a changed middle', () => {
  // own melody: two-bar phrases with a three-eighth upbeat; the second phrase has the same rhythm, is
  // a scale step higher and goes elsewhere in its middle (about half of the notes match)
  const n = (p: string, dur: number, type: string, staff = 1) =>
    p === 'r'
      ? `<note><rest/><duration>${dur}</duration><voice>${staff}</voice><type>${type}</type><staff>${staff}</staff></note>`
      : `<note><pitch><step>${p[0]}</step><octave>${p[1]}</octave></pitch><duration>${dur}</duration><voice>${staff}</voice><type>${type}</type><staff>${staff}</staff></note>`;
  const q = (p: string) => n(p, 2, 'quarter');
  const e = (p: string) => n(p, 1, 'eighth');
  const up1 = [e('E4'), e('G4'), e('C5')];
  const up2 = [e('F4'), e('A4'), e('D5')];
  const phrase1 = [[q('E5'), e('E5'), q('D5'), e('D5'), e('C5'), e('A4')], [q('B4'), q('D5'), e('r')]];
  const phrase2 = [[q('F5'), e('F5'), q('G5'), e('F5'), e('E5'), e('D5')], [q('C5'), q('G5'), e('r')]];
  const bars = [
    [...up1],
    phrase1[0],
    [...phrase1[1], ...up2],
    phrase2[0],
    [...phrase2[1], ...up1],
    phrase1[0],
    [...phrase1[1], ...up2],
    phrase2[0],
    [q('C5'), q('G5'), n('r', 4, 'half')],
  ];
  const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">${bars
    .map((b, i) => {
      const len = i === 0 ? 3 : 8;
      const attrs =
        i === 0
          ? '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
          : '';
      const lh = i === 0 ? n('r', 3, 'quarter', 2) : n(i % 2 ? 'C3' : 'G2', 8, 'whole', 2);
      return `<measure number="${i}"${i === 0 ? ' implicit="yes"' : ''}>${attrs}${b.join('')}<backup><duration>${len}</duration></backup>${lh}</measure>`;
    })
    .join('')}</part></score-partwise>`;

  it('groups it with the first phrase as a transposed variation', () => {
    const s = parseScore(xml);
    const right = new FragmentCache(s, 'R');
    const a = right.events(1, 2);
    const b = right.events(3, 2);
    // the same rhythm, but only about half of the notes match a step higher
    const loose = bestMatch(a, b, 0.5, true);
    expect(loose.steps).toBe(1);
    expect(loose.sim).toBeGreaterThanOrEqual(0.5);
    expect(loose.sim).toBeLessThan(0.6);
    // without the same rhythm such a weak shifted match would not count
    expect(bestMatch(a, b, 0.5, false).steps).toBe(0);

    const { blocks } = analyzePatterns(s);
    const R = blocks.filter((x) => x.hand === 'R');
    expect(R.map((x) => x.label)).toEqual(['A', 'A′', 'A', 'A′']);
    expect(R[1].steps).toBe(1);
    expect(R[1].role).toBe('variation');
    // the differences are shown against the first phrase moved a step higher
    const { families } = analyzePatterns(s);
    const lines = diffLines(s, blocks, families, R[1]);
    expect(lines[0]).toContain('сдвинут на секунду вверх');
    expect(lines).toContain('Такт 3 (1-й такт паттерна): в A со сдвигом — фа, фа, ми, ми, ре, си; здесь — фа, фа, соль, фа, ми, ре.');
  });
});
