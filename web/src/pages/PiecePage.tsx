import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsDialog } from '../components/SettingsDialog';
import { pianoEngine } from '../lib/audio';
import { navigate, type Route } from '../lib/hooks';
import type { Block, PieceSettings, Score } from '../lib/model';
import { parseScore } from '../lib/musicxml';
import { keyName } from '../lib/noteNames';
import { buildGuide, type Guide } from '../lib/piece';
import { getPiece, savePiece, type PieceRecord } from '../lib/storage';
import { FullScoreView } from '../views/FullScoreView';
import { GuideView } from '../views/GuideView';

export const blockKey = (b: Block) => `${b.startMeasure}-${b.endMeasure}`;

export function PiecePage({ route }: { route: Route }) {
  const [rec, setRec] = useState<PieceRecord | null | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // start downloading the piano samples right away so that the first "play" is instant
  useEffect(() => {
    const t = setTimeout(() => void pianoEngine.load(), 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let alive = true;
    getPiece(route.pieceId!).then((r) => alive && setRec(r ?? null));
    return () => {
      alive = false;
    };
  }, [route.pieceId]);

  const parsed = useMemo((): { score: Score | null; error: string } => {
    if (!rec) return { score: null, error: '' };
    try {
      return { score: parseScore(rec.musicXml, rec.title), error: '' };
    } catch (e) {
      return { score: null, error: String((e as Error).message || e) };
    }
  }, [rec?.musicXml]); // eslint-disable-line react-hooks/exhaustive-deps

  const guide: Guide | null = useMemo(() => {
    if (!parsed.score || !rec) return null;
    return buildGuide(parsed.score, rec.settings, rec.overrides);
  }, [parsed.score, rec?.settings, rec?.overrides]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback((patch: Partial<PieceRecord>) => {
    setRec((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void savePiece(next);
      return next;
    });
  }, []);

  // keep library metadata in sync
  useEffect(() => {
    if (rec && guide && rec.blockCount !== guide.blocks.length) update({ blockCount: guide.blocks.length });
  }, [guide, rec, update]);

  const learned = useMemo(() => {
    const set = new Set<number>();
    if (rec && guide) for (const b of guide.blocks) if (rec.learned.includes(blockKey(b))) set.add(b.index);
    return set;
  }, [rec, guide]);

  if (rec === undefined) return <div className="page-msg">Загрузка…</div>;
  if (rec === null) {
    return (
      <div className="page-msg">
        Пьеса не найдена. <a href="#home">Вернуться к списку</a>
      </div>
    );
  }
  if (parsed.error || !guide) {
    return (
      <div className="page-msg error">
        Не удалось прочитать ноты: {parsed.error}. <a href="#home">Назад</a>
      </div>
    );
  }

  const { score, blocks } = guide;
  const tab = route.tab ?? 'guide';
  const step = Math.min(Math.max(1, route.step ?? 1), blocks.length);
  const firstMeasure = score.measures[0];
  const toggleLearned = (b: Block) => {
    const k = blockKey(b);
    update({ learned: rec.learned.includes(k) ? rec.learned.filter((x) => x !== k) : [...rec.learned, k] });
  };
  const setOverride = (key: string, finger: number | null) => {
    const overrides = { ...rec.overrides };
    if (finger === null) delete overrides[key];
    else overrides[key] = finger;
    update({ overrides });
  };

  return (
    <div className="piece-page">
      <div className="piece-header">
        <div className="piece-header-main">
          <a href="#home" className="back-link">← Мои пьесы</a>
          <h1 className="piece-h1">{rec.title}</h1>
          <div className="piece-sub">
            {rec.composer && <span>{rec.composer}</span>}
            <span className="chip">{keyName(firstMeasure.fifths).split(' / ')[0]}</span>
            <span className="chip">
              {firstMeasure.beats}/{firstMeasure.beatType}
            </span>
            <span className="chip">♩ = {Math.round(score.tempoMap[0].bpm)}{score.tempoFromFile ? '' : ' (по умолчанию)'}</span>
            <span className="chip">{score.measures.length} тактов</span>
            <span className="chip">{blocks.length} блоков</span>
          </div>
        </div>
        <div className="piece-header-side">
          <div className="overall-progress" title="Выученные блоки">
            <div className="overall-label">
              Выучено {learned.size} из {blocks.length}
            </div>
            <div className="progress-track small">
              <div className="progress-fill green" style={{ width: `${(learned.size / Math.max(1, blocks.length)) * 100}%` }} />
            </div>
          </div>
          <button className="btn ghost" onClick={() => setSettingsOpen(true)} title="Настройки">
            ⚙ Настройки
          </button>
        </div>
      </div>

      {rec.recognizer === 'claude' && (
        <div className="alert info">
          Ноты распознал Claude по изображению страниц. Сверьте их с оригиналом (вкладка «Оригинал»), особенно знаки
          альтерации и ритм. Если нашли ошибку — исправьте MusicXML в MuseScore («Настройки» → экспорт) и загрузите заново.
        </div>
      )}

      <div className="tabs" role="tablist">
        <button
          role="tab"
          className={tab === 'guide' ? 'active' : ''}
          onClick={() => navigate({ page: 'piece', pieceId: rec.id, tab: 'guide', step })}
        >
          Гайд по блокам
        </button>
        <button
          role="tab"
          className={tab === 'score' ? 'active' : ''}
          onClick={() => navigate({ page: 'piece', pieceId: rec.id, tab: 'score' })}
        >
          Вся пьеса
        </button>
        {(rec.pdf || rec.pages?.length) && (
          <button
            role="tab"
            className={tab === 'pdf' ? 'active' : ''}
            onClick={() => navigate({ page: 'piece', pieceId: rec.id, tab: 'pdf' })}
          >
            Оригинал
          </button>
        )}
      </div>

      {tab === 'guide' && (
        <GuideView
          pieceId={rec.id}
          guide={guide}
          step={step}
          learned={learned}
          settings={rec.settings}
          onStep={(s) => {
            navigate({ page: 'piece', pieceId: rec.id, tab: 'guide', step: s });
            if (rec.lastBlock !== s - 1) update({ lastBlock: s - 1 });
          }}
          onToggleLearned={toggleLearned}
          onOverride={setOverride}
          overrides={rec.overrides}
        />
      )}
      {tab === 'score' && (
        <FullScoreView
          guide={guide}
          learned={learned}
          lastBlock={rec.lastBlock ?? 0}
          onOpenBlock={(i) => {
            update({ lastBlock: i });
            navigate({ page: 'piece', pieceId: rec.id, tab: 'guide', step: i + 1 });
            window.scrollTo({ top: 0 });
          }}
        />
      )}
      {tab === 'pdf' && rec.pages?.length ? <PagesView pages={rec.pages} /> : null}
      {tab === 'pdf' && !rec.pages?.length && rec.pdf && <PdfView blob={rec.pdf} />}

      {settingsOpen && (
        <SettingsDialog
          rec={rec}
          guide={guide}
          onClose={() => setSettingsOpen(false)}
          onChange={(settings: PieceSettings) => update({ settings })}
          onResetOverrides={() => update({ overrides: {} })}
          onRename={(title) => update({ title })}
        />
      )}
    </div>
  );
}

function PagesView({ pages }: { pages: Blob[] }) {
  const urls = useMemo(() => pages.map((p) => URL.createObjectURL(p)), [pages]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return (
    <div className="pdf-view pages">
      {urls.map((u, i) => (
        <img key={u} src={u} alt={`Страница ${i + 1}`} />
      ))}
    </div>
  );
}

function PdfView({ blob }: { blob: Blob }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="pdf-view">
      {blob.type.startsWith('image/') ? <img src={url} alt="Исходный скан нот" /> : <iframe src={url} title="Исходный PDF" />}
    </div>
  );
}
