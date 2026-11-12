import { it } from 'vitest';
// Optional check on large real-world scores; set FIXTURES=/path/to/folder with the .mxl files.
import { computeFingering } from '../web/src/lib/fingering';
import { segmentBlocks } from '../web/src/lib/segment';
import { loadFile } from './helpers';
const FIX = process.env.FIXTURES || '';
it.skipIf(!process.env.FIXTURES)('corpus', () => {
  for (const f of ['mozart_k545_movement1_exposition.mxl', 'joplin_maple_leaf_rag.mxl', 'schoenberg_opus19_movement2.mxl']) {
    const t0 = performance.now();
    const s = loadFile(FIX + '/' + f);
    const t1 = performance.now();
    computeFingering(s.notes, { tempo: s.tempoMap[0].bpm });
    const t2 = performance.now();
    console.log(`${f}: ${s.measures.length} measures, ${s.notes.length} notes, staves=${JSON.stringify(s.staves.map(x => [x.clef, x.hand, x.noteCount]))} tempo=${JSON.stringify(s.tempoMap.slice(0,3))} parse=${(t1-t0).toFixed(0)}ms finger=${(t2-t1).toFixed(0)}ms title=${s.title}`);
    const blocks = segmentBlocks(s, 'auto');
    console.log('  blocks', blocks.length, ':', blocks.slice(0, 16).map((x) => `${s.measures[x.startMeasure].number}-${s.measures[x.endMeasure].number}${x.repeatOf !== undefined ? '=' + (x.repeatOf + 1) : ''}`).join(' '));
    for (const hand of ['R', 'L'] as const) {
      const lines = s.measures.slice(0, 6).map(m => s.notes.filter(n => n.hand === hand && n.measureIndex === m.index).map(n => `${n.step}${n.alter>0?'#':n.alter<0?'b':''}${n.octave}${n.grace?'g':''}:${n.finger}`).join(' '));
      console.log('  ', hand, lines.join(' | '));
    }
  }
});
