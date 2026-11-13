/** End-to-end processing of a MusicXML document into a learning guide. */
import { analyzeSpan, type BlockAnalysis, type Span } from './analysis';
import { computeFingering, markFingerMoves } from './fingering';
import { DEFAULT_THRESHOLD, EPS, type Block, type GuideStep, type Hand, type PatternFamily, type PieceSettings, type Score } from './model';
import { parseScore, serializeXml, withFingerings } from './musicxml';
import { analyzePatterns, buildSteps, equalNotePairs, type Chunk } from './patterns';

export interface Guide {
  score: Score;
  /** fragments of each hand, labelled with their pattern (right hand A, A′, B…; left hand a, a′, b…) */
  blocks: Block[];
  families: PatternFamily[];
  /** learning order: each hand's patterns and variations, then both hands together */
  steps: GuideStep[];
  /** parts of the piece learned one after another ([first, last] measure) */
  parts: [number, number][];
  /** stretches played with both hands */
  chunks: Chunk[];
  /** one analysis per step */
  analyses: BlockAnalysis[];
  /** MusicXML with fingering numbers and move marks ("→3"), ready for rendering. */
  renderXml: string;
  /** MusicXML with plain fingering numbers, for other programs. */
  exportXml: string;
}

/** The hand a step is about (null: both hands). */
export function stepHand(blocks: Block[], step: GuideStep): Hand | null {
  return step.kind === 'pattern' || step.kind === 'variation' ? blocks[step.block].hand : null;
}

/** The last block a pattern / variation step covers (a sequence is learned in one go). */
export function stepLastBlock(blocks: Block[], step: GuideStep): Block | null {
  if (step.kind !== 'pattern' && step.kind !== 'variation') return null;
  const b = blocks[step.block];
  return b.sequenceEnd !== undefined ? blocks[b.sequenceEnd] : b;
}

/** What a step plays: [start, end) in quarters; the measures to draw are startMeasure…endMeasure. */
export function stepSpan(_score: Score, blocks: Block[], step: GuideStep): Span {
  if (step.kind === 'pattern' || step.kind === 'variation') {
    const a = blocks[step.block];
    const b = stepLastBlock(blocks, step)!;
    return { startMeasure: a.startMeasure, endMeasure: b.endMeasure, start: a.start, end: b.end, coreStart: a.coreStart };
  }
  return { startMeasure: step.startMeasure, endMeasure: step.endMeasure, start: step.start, end: step.end, coreStart: step.coreStart };
}

/** Fragments a step is about: the block (with its sequence), or every fragment inside a two-hand stretch. */
export function blocksOfStep(blocks: Block[], step: GuideStep): Set<number> {
  if (step.kind === 'pattern' || step.kind === 'variation') {
    const last = stepLastBlock(blocks, step)!;
    const out = new Set<number>();
    for (let k = step.block; k <= last.index; k++) out.add(k);
    return out;
  }
  return new Set(blocks.filter((b) => b.end > step.start + EPS && b.start < step.end - EPS).map((b) => b.index));
}

/** Stable key of a step (for "learned" marks). */
export function stepKey(score: Score, blocks: Block[], step: GuideStep): string {
  const s = stepSpan(score, blocks, step);
  const prefix = step.kind === 'pattern' || step.kind === 'variation' ? blocks[step.block].hand : step.kind === 'together' ? 't' : 'a';
  return `${prefix}:${s.coreStart ?? s.startMeasure}-${s.endMeasure}`;
}

export function buildGuide(score: Score, settings: PieceSettings, overrides: Record<string, number> = {}): Guide {
  const { blocks, families } = analyzePatterns(score, settings.blockSize, settings.threshold ?? DEFAULT_THRESHOLD);
  const fingerOpts = { handSize: settings.handSize, tempo: score.tempoMap[0]?.bpm };
  computeFingering(score.notes, { ...fingerOpts, overrides });
  // the same notes in every appearance of a pattern get the same fingers as in its first appearance
  const patternFingers: Record<string, number> = {};
  for (const [baseId, id] of equalNotePairs(score, blocks, families)) {
    const f = score.notes[baseId].finger;
    if (f && score.notes[id].finger !== f) patternFingers[score.notes[id].key] = f;
  }
  if (Object.keys(patternFingers).length) computeFingering(score.notes, { ...fingerOpts, overrides, patternFingers });
  markFingerMoves(score.notes);
  const { steps, parts, chunks } = buildSteps(score, blocks, families);
  const analyses = steps.map((st, i) => analyzeSpan(score, stepSpan(score, blocks, st), st.kind, i === 0, stepHand(blocks, st) ?? undefined));
  const renderXml = serializeXml(withFingerings(score.doc, score.notes, true));
  const exportXml = serializeXml(withFingerings(score.doc, score.notes));
  return { score, blocks, families, steps, parts, chunks, analyses, renderXml, exportXml };
}

export function guideFromXml(
  xml: string,
  settings: PieceSettings,
  overrides: Record<string, number> = {},
  fallbackTitle = '',
): Guide {
  return buildGuide(parseScore(xml, fallbackTitle), settings, overrides);
}
