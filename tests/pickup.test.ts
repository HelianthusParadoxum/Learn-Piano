import { describe, expect, it } from 'vitest';
import { parseScore } from '../web/src/lib/musicxml';
import { segmentBlocks } from '../web/src/lib/segment';

/** Builds a 2/4 piece: pickup eighth, then a repeat sign, then `bars` dense measures (8 sixteenths per hand). */
function pieceWithPickup(bars: number) {
  const note = (step: string, oct: number, dur: number, staff: number, type: string) =>
    `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${staff}</voice><type>${type}</type><staff>${staff}</staff></note>`;
  let measures = `<measure number="0" implicit="yes"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>${note('G', 4, 2, 1, 'eighth')}<backup><duration>2</duration></backup>${note('G', 2, 2, 2, 'eighth')}</measure>`;
  for (let b = 1; b <= bars; b++) {
    const left = b === 1 ? '<barline location="left"><repeat direction="forward"/></barline>' : '';
    let rh = '';
    let lh = '';
    for (let k = 0; k < 8; k++) {
      rh += note('CDEFGABC'[k], 5, 1, 1, '16th');
      lh += note('CDEFGABC'[k], 3, 1, 2, '16th');
    }
    measures += `<measure number="${b}">${left}${rh}<backup><duration>8</duration></backup>${lh}</measure>`;
  }
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
}

describe('pickup measures and dense short bars', () => {
  it('merges the pickup into the first block even when a repeat sign follows it', () => {
    const score = parseScore(pieceWithPickup(16));
    expect(score.measures[0].implicit).toBe(true);
    const blocks = segmentBlocks(score, 'auto');
    expect(blocks[0].startMeasure).toBe(0);
    expect(blocks[0].endMeasure).toBeGreaterThanOrEqual(1);
    // dense 2/4 music should not degrade into one block per measure
    expect(blocks.length).toBeLessThanOrEqual(10);
    for (const mode of [1, 2, 4] as const) {
      const fixed = segmentBlocks(score, mode);
      expect(fixed[0].endMeasure).toBeGreaterThanOrEqual(1);
    }
  });
});
