import type { Block, Hand, PatternFamily, Score } from '../lib/model';
import { blockMeasures, HAND_NAME, plural, shiftText, structureSummary } from '../lib/patternText';
import { barlineAt } from '../lib/upbeat';
import { familyColor } from './ScoreView';

const HANDS: Hand[] = ['R', 'L'];

function describe(b: Block, families: PatternFamily[]): string {
  if (b.role === 'base') return 'паттерн';
  if (b.role === 'variation') return `вариация ${families[b.family].letter}, совпадает на ${Math.round(b.similarity * 100)}%`;
  if (b.transpose || b.steps) return `тот же рисунок ${shiftText(b)}`;
  return 'точный повтор';
}

/**
 * Each hand's part as a sequence of pattern instances — right hand A A′ B A′, left hand a b a b — on a
 * common measure axis. Click a fragment to open the step where it is learned.
 */
export function StructureMap(props: {
  score: Score;
  blocks: Block[];
  families: PatternFamily[];
  highlight?: ReadonlySet<number>;
  onBlock: (blockIndex: number) => void;
  showSummary?: boolean;
}) {
  const { score, blocks, families, highlight, onBlock, showSummary } = props;
  // positions in time: a fragment that starts with an upbeat begins before its first barline
  const total = Math.max(1e-6, barlineAt(score, score.measures.length));
  const summary = structureSummary(blocks, families);
  const rows = HANDS.filter((h) => blocks.some((b) => b.hand === h));
  return (
    <div className="structure">
      {rows.map((hand) => (
        <div key={hand} className={`structure-row hand-${hand}`}>
          <span className="structure-hand">{hand === 'R' ? 'Правая' : 'Левая'}</span>
          <div className="structure-bar" role="list" aria-label={`Структура: ${HAND_NAME[hand].toLowerCase()}`}>
            {blocks
              .filter((b) => b.hand === hand)
              .map((b) => {
                const share = (b.end - b.start) / total;
                const size = share < 0.022 ? 'tiny' : share < 0.045 ? 'narrow' : '';
                return (
                <button
                  key={b.index}
                  role="listitem"
                  className={`structure-seg role-${b.role} ${size} ${highlight?.has(b.index) ? 'active' : ''}`}
                  style={{
                    left: `${(b.start / total) * 100}%`,
                    width: `${share * 100}%`,
                    ['--block-color' as string]: familyColor(b.family),
                  }}
                  onClick={() => onBlock(b.index)}
                  title={`${b.label} — ${describe(b, families)}; ${blockMeasures(score, b)}`}
                >
                  <span className="seg-label">{b.label}</span>
                  {!size && (
                    <span className="seg-measures">
                      {score.measures[b.coreStart ?? b.startMeasure].number}–{score.measures[b.endMeasure].number}
                    </span>
                  )}
                </button>
                );
              })}
          </div>
        </div>
      ))}
      {showSummary && (
        <div className="structure-summary">
          {summary.map((h) => (
            <div key={h.hand}>
              <b className={`t-${h.hand}`}>{HAND_NAME[h.hand]}:</b> {h.patterns} {plural(h.patterns, 'паттерн', 'паттерна', 'паттернов')}
              {h.variations ? `, вариаций: ${h.variations}` : ''}
              {h.learn < h.measures ? (
                <>
                  {' '}
                  · нового материала <b>{h.learn} из {h.measures} тактов</b>
                </>
              ) : (
                ' · повторов почти нет'
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
