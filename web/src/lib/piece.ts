/** End-to-end processing of a MusicXML document into a learning guide. */
import { analyzeBlock, type BlockAnalysis } from './analysis';
import { computeFingering } from './fingering';
import type { Block, PieceSettings, Score } from './model';
import { parseScore, serializeXml, withFingerings } from './musicxml';
import { segmentBlocks } from './segment';

export interface Guide {
  score: Score;
  blocks: Block[];
  analyses: BlockAnalysis[];
  /** MusicXML with fingering numbers, ready for rendering. */
  renderXml: string;
}

export function buildGuide(
  score: Score,
  settings: PieceSettings,
  overrides: Record<string, number> = {},
): Guide {
  computeFingering(score.notes, {
    handSize: settings.handSize,
    overrides,
    tempo: score.tempoMap[0]?.bpm,
  });
  const blocks = segmentBlocks(score, settings.blockSize);
  const analyses = blocks.map((b) => analyzeBlock(score, blocks, b));
  const renderXml = serializeXml(withFingerings(score.doc, score.notes));
  return { score, blocks, analyses, renderXml };
}

export function guideFromXml(
  xml: string,
  settings: PieceSettings,
  overrides: Record<string, number> = {},
  fallbackTitle = '',
): Guide {
  return buildGuide(parseScore(xml, fallbackTitle), settings, overrides);
}
