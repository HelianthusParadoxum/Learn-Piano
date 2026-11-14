import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_THRESHOLD, type Hand } from '../web/src/lib/model';
import { parseScore } from '../web/src/lib/musicxml';
import { diffLines, structureSummary } from '../web/src/lib/patternText';
import { analyzePatterns, bestMatch, buildSteps, equalNotePairs, FragmentCache, joinCompanions, matchWindows, stepOfBlock } from '../web/src/lib/patterns';
import { measureBoundaries } from '../web/src/lib/segment';
import { buildGuide } from '../web/src/lib/piece';
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
  it('finds A′ A B A in the right hand and one left-hand pattern in Ode to Joy (threshold 50 %)', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.5);
    const { of, labels, families } = describeStructure('ode-to-joy.musicxml');
    // the base is the phrase that comes back (bars 5–8 and 13–16); the first phrase differs from it in its
    // last bar (a half cadence), so it is the variation, though it comes first
    expect(labels('R')).toEqual(['A′', 'A', 'B', 'A']);
    // the left hand: bars 9–16 are a variation of bars 1–8 (about 63 % of the notes match)
    expect(labels('L')).toEqual(['a', 'a′']);
    const R = of('R');
    expect(R.map((b) => b.role)).toEqual(['variation', 'base', 'base', 'repeat']);
    expect(R[3].repeatOf).toBe(R[1].index);
    expect(families.find((f) => f.letter === 'A')!.base).toBe(R[1].index);
    // A′ differs from A only in its last measure
    const changedMeasures = R[0].diff!.measures.filter((m) => m.changed + m.missing + m.rhythm > 0).map((m) => m.offset);
    expect(changedMeasures).toEqual([3]);
    expect(families.filter((f) => f.hand === 'R')).toHaveLength(2);
    expect(families.filter((f) => f.hand === 'L')).toHaveLength(1);
  });

  it('a stricter threshold gives more patterns', () => {
    const strict = describeStructure('ode-to-joy.musicxml', 0.8);
    expect(strict.labels('R')).toEqual(['A′', 'A', 'B', 'A']);
    expect(strict.labels('L')).toEqual(['a′', 'a', 'b', 'a']);
    const minuet = describeStructure('minuet-in-g.musicxml', 0.8);
    expect(minuet.families.filter((f) => f.hand === 'R').length).toBeGreaterThan(
      describeStructure('minuet-in-g.musicxml').families.filter((f) => f.hand === 'R').length,
    );
  });

  it('a looser threshold, down to 20 %, only merges patterns: the fragments stay where they are', () => {
    for (const name of ['ode-to-joy.musicxml', 'minuet-in-g.musicxml', 'twinkle.musicxml', 'upbeat-song.musicxml']) {
      const base = describeStructure(name);
      let patterns = base.families.length;
      for (const threshold of [0.4, 0.3, 0.2]) {
        const loose = describeStructure(name, threshold);
        expect(loose.blocks.map((b) => [b.hand, b.start, b.end])).toEqual(base.blocks.map((b) => [b.hand, b.start, b.end]));
        expect(loose.families.length).toBeLessThanOrEqual(patterns);
        // a variation matches its base at least by the threshold
        expect(loose.blocks.filter((b) => b.role === 'variation').every((b) => b.similarity >= threshold - 1e-9)).toBe(true);
        patterns = loose.families.length;
      }
    }
    // the left hand of Twinkle: bars 5–8 share about a third of their notes with bars 1–4
    expect(describeStructure('twinkle.musicxml', 0.3).labels('L')).toEqual(['a', 'a′', 'a']);
    expect(describeStructure('minuet-in-g.musicxml', 0.2).labels('L')).toEqual(['a', 'a′']);
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
    // A is learned from bars 5–8, then the first phrase as its variation
    const first = steps[0];
    expect(first.kind === 'pattern' && blocks[first.block].coreStart).toBe(4);
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
    expect(target.kind === 'pattern' && blocks[target.block].label).toBe('A');
  });

  it('describes the differences of a variation for its hand only', () => {
    const { s, blocks, families, of } = describeStructure('ode-to-joy.musicxml');
    const lines = diffLines(s, blocks, families, of('R')[0]);
    expect(lines).toEqual(['Такт 4 (4-й такт паттерна): в A — ре, до, до; здесь — ми, ре, ре.']);
    const summary = structureSummary(blocks, families);
    expect(summary.map((h) => [h.hand, h.labels, h.patterns])).toEqual([
      ['R', 'A′ A B A', 2],
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

  it('carries a finger chosen in the pattern over to its transposed appearances', () => {
    const s = parseScore(xml);
    const g0 = buildGuide(s, DEFAULT_SETTINGS);
    const R = g0.blocks.filter((b) => b.hand === 'R');
    const notesOf = (b: (typeof R)[number]) =>
      g0.score.notes.filter((n) => n.hand === 'R' && n.onset >= b.start - 1e-6 && n.onset < b.end - 1e-6).sort((x, y) => x.onset - y.onset);
    // the first note of the first full bar of A (E5) and the same place in A′ a step higher (F5)
    const baseNote = notesOf(R[0])[3];
    const copyNote = notesOf(R[1])[3];
    expect([baseNote.step, copyNote.step]).toEqual(['E', 'F']);
    const finger = baseNote.finger === 4 ? 3 : 4;
    const g1 = buildGuide(s, DEFAULT_SETTINGS, { [baseNote.key]: finger });
    const after = (id: number) => g1.score.notes[id];
    expect(after(baseNote.id).finger).toBe(finger);
    expect(after(copyNote.id).finger).toBe(finger);
    expect(after(copyNote.id).fingerSource).toBe('pattern');
    // a finger chosen for the copy itself stays
    const own = finger === 4 ? 3 : 4;
    const g2 = buildGuide(s, DEFAULT_SETTINGS, { [baseNote.key]: finger, [copyNote.key]: own });
    expect(g2.score.notes[copyNote.id].finger).toBe(own);
  });
});

/** Own melodies in 4/4: a bar is "G5:2 A5:1 …" (a note and its length in eighths); the left hand holds C3 / G2. */
const TYPES: Record<number, string> = { 1: 'eighth', 2: 'quarter', 4: 'half', 8: 'whole' };
const xmlNote = (p: string, dur: number, staff = 1) =>
  p.startsWith('R')
    ? `<note><rest/><duration>${dur}</duration><voice>${staff}</voice><type>${TYPES[dur]}</type><staff>${staff}</staff></note>`
    : `<note><pitch><step>${p[0]}</step><octave>${p[1]}</octave></pitch><duration>${dur}</duration><voice>${staff}</voice><type>${TYPES[dur]}</type><staff>${staff}</staff></note>`;
const xmlBar = (notes: string) =>
  notes
    .split(' ')
    .map((t) => xmlNote(t.slice(0, 2), Number(t.slice(3))))
    .join('');
const ATTRS =
  '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>';
const scoreOf = (bars: string[]) =>
  parseScore(
    `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">${bars
      .map((b, i) => `<measure number="${i + 1}">${i === 0 ? ATTRS : ''}${xmlBar(b)}<backup><duration>8</duration></backup>${xmlNote(i % 2 ? 'G2' : 'C3', 8, 2)}</measure>`)
      .join('')}</part></score-partwise>`,
  );
const rightHand = (bars: string[]) => analyzePatterns(scoreOf(bars)).blocks.filter((b) => b.hand === 'R');

describe('a phrase whose halves always come together', () => {
  // own melody, 4/4: a four-bar phrase of running eighths comes back three times between other phrases.
  // Each half alone is closer to the preferred fragment size, so the anchors cut the phrase in two; but
  // the halves always come together and no phrase ends between them, so they are one pattern.
  const first = ['C5:2 E5:2 G5:2 E5:2', 'F5:2 D5:2 B4:4', 'C5:2 E5:2 A5:2 G5:2', 'E5:8'];
  const second = ['E5:2 D5:2 C5:2 D5:2', 'E5:2 E5:2 E5:4', 'D5:2 D5:2 E5:2 D5:2', 'C5:8'];
  const third = ['G4:2 C5:2 E5:2 C5:2', 'D5:4 G4:4', 'A4:2 B4:2 C5:2 D5:2', 'C5:8'];
  const running = [
    'G5:2 A5:1 G5:1 F5:1 E5:1 D5:1 E5:1',
    'F5:2 G5:1 F5:1 E5:1 D5:1 C5:1 D5:1',
    'E5:2 C5:1 D5:1 E5:1 F5:1 G5:1 A5:1',
    'G5:2 F5:1 E5:1 D5:1 C5:1 B4:1 D5:1',
  ];
  // the running phrase in bars 5–8, 13–16 and 21–24; the song ends with its first phrase
  const song = (phrase: string[]) => [...first, ...phrase, ...second, ...phrase, ...third, ...phrase, ...first];

  it('joins them into one pattern', () => {
    const R = rightHand(song(running));
    const phrase = R.filter((b) => [4, 12, 20].includes(b.coreStart!));
    expect(phrase.map((b) => [b.coreStart, b.endMeasure])).toEqual([
      [4, 7],
      [12, 15],
      [20, 23],
    ]);
    expect(new Set(phrase.map((b) => b.family)).size).toBe(1);
    expect(phrase.map((b) => b.role)).toEqual(['base', 'repeat', 'repeat']);
  });

  it('keeps them apart when a phrase ends between them or one half also comes alone', () => {
    // the song cut into its phrases, the running phrase into halves
    const halves = [
      [0, 3],
      [4, 5],
      [6, 7],
      [8, 11],
      [12, 13],
      [14, 15],
      [16, 19],
      [20, 21],
      [22, 23],
      [24, 27],
    ].map(([a, b]) => ({ a, b }));
    const join = (bars: string[], frags = halves) => {
      const s = scoreOf(bars);
      return joinCompanions(new FragmentCache(s, 'R'), frags, measureBoundaries(s), DEFAULT_THRESHOLD, 0).frags;
    };
    expect(join(song(running)).filter((f) => [4, 12, 20].includes(f.a))).toEqual([
      { a: 4, b: 7 },
      { a: 12, b: 15 },
      { a: 20, b: 23 },
    ]);
    // the first half ends on a long note: a question and an answer, two phrases
    expect(join(song([running[0], 'F5:2 G5:1 F5:1 E5:4', running[2], running[3]]))).toEqual(halves);
    // the second half comes once more on its own (bars 9–10 instead of the start of the second phrase)
    const alone = halves.flatMap((f) => (f.a === 8 ? [{ a: 8, b: 9 }, { a: 10, b: 11 }] : [f]));
    const bars = song(running);
    bars.splice(8, 2, running[2], running[3]);
    expect(join(bars, alone)).toEqual(alone);
  });
});

describe('the end of the piece', () => {
  // own melody, 4/4: X Y, then P; X with another continuation (Z), P again and the final note
  const X = ['E5:2 G5:2 C6:2 G5:2', 'A5:2 F5:2 D5:4'];
  const Y = ['C5:2 D5:2 E5:2 F5:2', 'G5:2 E5:2 C5:4'];
  const Z = ['F5:2 E5:2 D5:2 C5:2', 'G5:2 E5:2 C5:4'];
  const P = ['G4:2 A4:2 B4:2 G4:2', 'C5:1 B4:1 A4:1 B4:1 C5:4'];
  const bars = [...X, ...Y, ...P, ...X, ...Z, ...P, 'C5:8'];

  it('does not let a fragment that ends the piece pull its partner into the next phrase', () => {
    // P with the bar after it (bars 5–7) matches P with the final note (bars 11–13). The final barline is
    // the strongest boundary of the piece, but it must not make up for bar 7 ending in the middle of a
    // phrase: bar 7 starts X again, the same pattern as bar 1
    const R = rightHand(bars);
    const at = (bar: number) => R.find((b) => b.coreStart === bar - 1);
    expect(at(5)?.endMeasure).toBe(5);
    expect(at(7)?.family).toBe(at(1)?.family);
  });

  it('does not leave the final note as a pattern of its own', () => {
    const R = rightHand(bars);
    const last = R[R.length - 1];
    expect(last.endMeasure).toBe(12);
    expect(last.coreStart).toBeLessThan(12);
  });
});

describe('the base of a pattern', () => {
  // own melody, 4/4: a phrase X comes three times; the first time with another ending (a half cadence)
  const X = ['C5:2 E5:2 G5:2 E5:2', 'F5:2 D5:2 B4:4', 'C5:2 E5:2 A5:2 G5:2', 'C5:8'];
  const firstX = ['C5:2 E5:2 G5:2 E5:2', 'F5:2 D5:2 B4:4', 'C5:2 E5:2 A5:2 G5:2', 'D5:8'];
  const Y = ['E5:2 D5:2 C5:2 D5:2', 'E5:2 E5:2 E5:4', 'D5:2 D5:2 E5:2 D5:2', 'G4:8'];
  const Z = ['A4:4 F4:4', 'G4:4 E4:4', 'F4:4 D4:4', 'C4:8'];
  const kinds = (bars: string[]) => {
    const s = scoreOf(bars);
    const { blocks, families } = analyzePatterns(s);
    const { steps, parts } = buildSteps(s, blocks, families);
    return { s, blocks, families, steps, parts };
  };

  it('is the appearance the others differ from least, also when it comes later', () => {
    const { blocks, families, steps } = kinds([...firstX, ...Y, ...X, ...Z, ...X]);
    const R = blocks.filter((b) => b.hand === 'R');
    expect(R.map((b) => [b.label, b.coreStart])).toEqual([
      ['A′', 0],
      ['B', 4],
      ['A', 8],
      ['C', 12],
      ['A', 16],
    ]);
    expect(R[0].role).toBe('variation');
    expect(R[4]).toMatchObject({ role: 'repeat', repeatOf: R[2].index });
    // the guide teaches the base first, then the first phrase as its variation
    const first = steps.slice(0, 2).map((st) => (st.kind === 'pattern' || st.kind === 'variation' ? [st.kind, blocks[st.block].coreStart] : st.kind));
    expect(first).toEqual([
      ['pattern', 8],
      ['variation', 0],
    ]);
    expect(families.find((f) => f.letter === 'A')!.base).toBe(R[2].index);
  });

  it('stays the first appearance when the others are no closer to the rest', () => {
    // two appearances differ from each other equally; with X X′ X the first X is as good as the last
    expect(rightHand([...X, ...Y, ...firstX, ...Z]).map((b) => b.label)).toEqual(['A', 'B', 'A′', 'C']);
    expect(rightHand([...X, ...Y, ...firstX, ...Z, ...X]).map((b) => b.label)).toEqual(['A', 'B', 'A′', 'C', 'A']);
  });

  it('is learned in the part where its pattern first appears, before any of its variations', () => {
    // 28 bars: learned in two parts; X comes back twice in the second part
    const { blocks, families, steps, parts } = kinds([...firstX, ...Y, ...Z, ...X, ...Y, ...X, ...Z]);
    expect(parts.length).toBe(2);
    const partOf = (m: number) => parts.findIndex(([a, b]) => m >= a && m <= b);
    const A = families.find((f) => f.hand === 'R' && f.letter === 'A')!;
    expect(partOf(blocks[A.base].coreStart!)).toBe(1);
    for (const f of families) {
      const at = steps.findIndex((st) => st.kind === 'pattern' && st.block === f.base);
      const step = steps[at];
      expect(step.part).toBe(Math.min(...f.blocks.map((k) => partOf(blocks[k].coreStart!))));
      for (const [i, st] of steps.entries()) if (st.kind === 'variation' && blocks[st.block].family === f.index) expect(i).toBeGreaterThan(at);
    }
  });
});

describe('a variation with whole measures inserted or left out', () => {
  // own melody, 4/4: phrase X, a phrase Y, X again with a measure inserted or left out, a phrase Z, X
  const X = ['C5:2 E5:2 G5:2 E5:2', 'F5:2 D5:2 B4:4', 'C5:2 E5:2 A5:2 G5:2', 'C5:8'];
  const Y = ['E5:2 D5:2 C5:2 D5:2', 'E5:2 E5:2 E5:4', 'D5:2 D5:2 E5:2 D5:2', 'G4:8'];
  const Z = ['G4:2 A4:2 B4:2 G4:2', 'A4:4 F4:4', 'E4:2 F4:2 G4:2 E4:2', 'D4:8'];
  const analyse = (bars: string[]) => {
    const s = scoreOf(bars);
    const { blocks, families } = analyzePatterns(s);
    const R = blocks.filter((b) => b.hand === 'R');
    return { s, blocks, families, R, spans: R.map((b) => [b.label, (b.coreStart ?? b.startMeasure) + 1, b.endMeasure + 1]) };
  };

  it('notes added or removed inside the measures make a variation', () => {
    const added = ['C5:2 E5:1 F5:1 G5:2 E5:2', 'F5:2 D5:2 B4:2 A4:1 B4:1', 'C5:2 E5:2 A5:1 B5:1 G5:2', 'C5:8'];
    const removed = ['C5:4 G5:2 E5:2', 'F5:2 D5:2 B4:4', 'C5:2 R:2 A5:2 G5:2', 'C5:8'];
    for (const v of [added, removed]) expect(analyse([...X, ...Y, ...v, ...Z, ...X]).spans.map((x) => x[0])).toEqual(['A', 'B', 'A′', 'C', 'A']);
  });

  it('a measure inserted: the whole phrase is a variation, the inserted measure is new', () => {
    const inserted = [X[0], X[1], 'E5:2 C5:2 A4:4', X[2], X[3]];
    const { s, blocks, families, R, spans } = analyse([...X, ...Y, ...inserted, ...Z, ...X]);
    expect(spans).toEqual([
      ['A', 1, 4],
      ['B', 5, 8],
      ['A′', 9, 13],
      ['C', 14, 17],
      ['A', 18, 21],
    ]);
    expect(R[2].diff!.measures.map((m) => m.base)).toEqual([0, 1, null, 2, 3]);
    expect(diffLines(s, blocks, families, R[2])).toEqual(['Такт 11 (3-й такт паттерна): добавлен целиком, в A такого такта нет — ми, до, ля.']);
    // the fingers of the base reach the measures after the inserted one
    const pairs = equalNotePairs(s, blocks, families);
    expect(pairs.some((p) => s.notes[p.from].measureIndex === 3 && s.notes[p.to].measureIndex === 12)).toBe(true);
  });

  it('a measure left out: the shorter phrase is a variation, the measure is reported missing', () => {
    const shorter = [X[0], X[1], X[3]];
    const { s, blocks, families, R, spans } = analyse([...X, ...Y, ...shorter, ...Z, ...X]);
    expect(spans).toEqual([
      ['A', 1, 4],
      ['B', 5, 8],
      ['A′', 9, 11],
      ['C', 12, 15],
      ['A', 16, 19],
    ]);
    expect(R[2].diff!.dropped!.map((d) => d.offset)).toEqual([2]);
    expect(diffLines(s, blocks, families, R[2])).toEqual(['После такта 10 пропущен 3-й такт A (такт 3): до, ми, ля, соль.']);
  });

  it('an appearance with an extra measure can be the variation of a shorter base', () => {
    const inserted = [X[0], X[1], 'E5:2 C5:2 A4:4', X[2], X[3]];
    const { spans, R, families } = analyse([...inserted, ...Y, ...X, ...Z, ...X]);
    expect(spans.map((x) => x[0])).toEqual(['A′', 'B', 'A', 'C', 'A']);
    expect(families.find((f) => f.letter === 'A')!.base).toBe(R[2].index);
  });

  it('a neighbouring measure is not taken for an inserted one', () => {
    // with X and its variation of the same length, X + the first measure of Z must not become a five-measure phrase
    const variant = [...X.slice(0, 3), 'D5:8'];
    expect(analyse([...X, ...Y, ...variant, ...Z]).spans).toEqual([
      ['A', 1, 4],
      ['B', 5, 8],
      ['A′', 9, 12],
      ['C', 13, 16],
    ]);
  });
});
