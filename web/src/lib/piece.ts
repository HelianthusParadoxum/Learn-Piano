/** End-to-end processing of a MusicXML document into a learning guide. */
import { analyzeSpan, type BlockAnalysis, type Span } from './analysis';
import { computeFingering } from './fingering';
import { DEFAULT_SETTINGS, type Block, type GuideStep, type PatternFamily, type PieceSettings, type Score } from './model';
import { parseScore, serializeXml, withFingerings } from './musicxml';
import { analyzePatterns, buildSteps, equalNotePairs } from './patterns';

export interface Guide {
  score: Score;
  /** fragments of the piece in order, labelled with their pattern (A, A′, B…) */
  blocks: Block[];
  families: PatternFamily[];
  /** learning order: patterns, their variations, then assembly */
  steps: GuideStep[];
  /** one analysis per step */
  analyses: BlockAnalysis[];
  /** MusicXML with fingering numbers, ready for rendering. */
  renderXml: string;
}

export function stepSpan(blocks: Block[], step: GuideStep): Span {
  const a = step.kind === 'assemble' ? blocks[step.fromBlock] : blocks[step.block];
  const b = step.kind === 'assemble' ? blocks[step.toBlock] : blocks[step.block];
  return { startMeasure: a.startMeasure, endMeasure: b.endMeasure, start: a.start, end: b.end };
}

/** Stable key of a step (for "learned" marks). */
export function stepKey(blocks: Block[], step: GuideStep): string {
  const s = stepSpan(blocks, step);
  return `${step.kind === 'assemble' ? 'a' : 'p'}:${s.startMeasure}-${s.endMeasure}`;
}

export function buildGuide(score: Score, settings: PieceSettings, overrides: Record<string, number> = {}): Guide {
  const { blocks, families } = analyzePatterns(score, settings.blockSize, settings.similarity ?? DEFAULT_SETTINGS.similarity!);
  const fingerOpts = { handSize: settings.handSize, tempo: score.tempoMap[0]?.bpm };
  computeFingering(score.notes, { ...fingerOpts, overrides });
  // the same notes in every appearance of a pattern get the same fingers as in its first appearance
  const patternFingers: Record<string, number> = {};
  for (const [baseId, id] of equalNotePairs(score, blocks, families)) {
    const f = score.notes[baseId].finger;
    if (f && score.notes[id].finger !== f) patternFingers[score.notes[id].key] = f;
  }
  if (Object.keys(patternFingers).length) computeFingering(score.notes, { ...fingerOpts, overrides, patternFingers });
  const steps = buildSteps(score, blocks, families);
  const analyses = steps.map((st, i) => analyzeSpan(score, stepSpan(blocks, st), st.kind, i === 0));
  const renderXml = serializeXml(withFingerings(score.doc, score.notes));
  return { score, blocks, families, steps, analyses, renderXml };
}

export function guideFromXml(
  xml: string,
  settings: PieceSettings,
  overrides: Record<string, number> = {},
  fallbackTitle = '',
): Guide {
  return buildGuide(parseScore(xml, fallbackTitle), settings, overrides);
}
