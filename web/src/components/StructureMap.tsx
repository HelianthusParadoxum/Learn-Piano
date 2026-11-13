import type { Block, PatternFamily, Score } from '../lib/model';
import { blockMeasures, similarityText, structureSummary } from '../lib/patternText';
import { familyColor } from './ScoreView';

/** The piece as a sequence of pattern instances: A A′ B A′ … (click a fragment to open its step). */
export function StructureMap(props: {
  score: Score;
  blocks: Block[];
  families: PatternFamily[];
  highlight?: ReadonlySet<number>;
  onBlock: (blockIndex: number) => void;
  showSummary?: boolean;
}) {
  const { score, blocks, families, highlight, onBlock, showSummary } = props;
  const sum = structureSummary(score, blocks, families);
  return (
    <div className="structure">
      <div className="structure-bar" role="list" aria-label="Структура пьесы">
        {blocks.map((b) => {
          const len = b.endMeasure - b.startMeasure + 1;
          const what = b.role === 'base' ? 'паттерн' : b.role === 'variation' ? `вариация, совпадает с ${families[b.family].letter} на ${similarityText(score, b)}` : 'повтор';
          return (
            <button
              key={b.index}
              role="listitem"
              className={`structure-seg role-${b.role} ${highlight?.has(b.index) ? 'active' : ''}`}
              style={{ flexGrow: len, flexBasis: 0, ['--block-color' as string]: familyColor(b.family) }}
              onClick={() => onBlock(b.index)}
              title={`${b.label} — ${what}; ${blockMeasures(score, b)}`}
            >
              <span className="seg-label">{b.label}</span>
              <span className="seg-measures">{score.measures[b.startMeasure].number}–{score.measures[b.endMeasure].number}</span>
            </button>
          );
        })}
      </div>
      {showSummary && (
        <div className="structure-summary">
          Пьеса: <b>{blocks.map((b) => b.label).join(' ')}</b> · паттернов: {sum.patterns}
          {sum.variations ? `, вариаций: ${sum.variations}` : ''}.{' '}
          {sum.learn < sum.total ? (
            <>
              Нового материала — <b>{sum.learn} из {sum.total} тактов</b>, остальное повторяется.
            </>
          ) : (
            <>Повторов почти нет — пьеса разучивается фрагмент за фрагментом.</>
          )}
        </div>
      )}
    </div>
  );
}
