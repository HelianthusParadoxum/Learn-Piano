/** End-to-end processing of a MusicXML document into a learning guide. */
import { analyzeSpan, type BlockAnalysis, type Span } from './analysis';
import { computeFingering, isBlackKey, markFingerMoves } from './fingering';
import { DEFAULT_THRESHOLD, EPS, type Block, type GuideStep, type Hand, type PatternFamily, type PieceSettings, type Score } from './model';
import { parseScore, serializeXml, withFingerings } from './musicxml';
import { analyzePatterns, buildSteps, equalNotePairs, repeatNotePairs, type Chunk, type NotePair } from './patterns';

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
  /** MusicXML with fingering numbers and move marks ("3›", "3»"), ready for rendering. */
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

/** Pattern structure and learning order do not depend on fingers: kept per score and settings. */
const structures = new WeakMap<Score, Map<string, { blocks: Block[]; families: PatternFamily[]; plan: ReturnType<typeof buildSteps> }>>();
function structureOf(score: Score, settings: PieceSettings) {
  const key = `${settings.blockSize}|${settings.threshold ?? DEFAULT_THRESHOLD}`;
  let byKey = structures.get(score);
  if (!byKey) structures.set(score, (byKey = new Map()));
  let st = byKey.get(key);
  if (!st) {
    const { blocks, families } = analyzePatterns(score, settings.blockSize, settings.threshold ?? DEFAULT_THRESHOLD);
    st = { blocks, families, plan: buildSteps(score, blocks, families) };
    byKey.set(key, st);
  }
  return st;
}

export function buildGuide(score: Score, settings: PieceSettings, overrides: Record<string, number> = {}): Guide {
  const { blocks, families, plan } = structureOf(score, settings);
  const fingerOpts = { handSize: settings.handSize, tempo: score.tempoMap[0]?.bpm };
  computeFingering(score.notes, { ...fingerOpts, overrides });
  // every appearance of a pattern gets the fingers of its first appearance (yours or automatic) on the
  // notes they share — also when it sounds from another note; a repeat of a variation follows that
  // variation. A finger you choose for a note of an appearance itself still wins.
  const patternFingers: Record<string, number> = {};
  const copy = (pairs: NotePair[]) => {
    let changed = false;
    for (const { from, to, shifted } of pairs) {
      const f = score.notes[from].finger;
      const target = score.notes[to];
      if (!f || overrides[target.key] !== undefined) continue;
      // in a transposed copy the thumb must not be pushed onto a black key
      if (shifted && f === 1 && isBlackKey(target.midi)) continue;
      // pinned even where it already agrees: the next pass must not move it
      patternFingers[target.key] = f;
      if (target.finger !== f) changed = true;
    }
    return changed;
  };
  if (copy(equalNotePairs(score, blocks, families))) computeFingering(score.notes, { ...fingerOpts, overrides, patternFingers });
  if (copy(repeatNotePairs(score, blocks))) computeFingering(score.notes, { ...fingerOpts, overrides, patternFingers });
  markFingerMoves(score.notes);
  const { steps, parts, chunks } = plan;
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
