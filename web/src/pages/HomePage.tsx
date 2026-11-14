import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { getHealth, getJob, getJobResult, submitPdf, type JobStatus, type ServerHealth } from '../lib/api';
import { navigate } from '../lib/hooks';
import { musicXmlFromBytes, parseScore } from '../lib/musicxml';
import { claudeOmrAvailable, recognizeWithClaude, type OmrProgress } from '../lib/omr/claudeOmr';
import { IS_ARTIFACT } from '../lib/platform';
import { deletePiece, listPieces, newPieceRecord, savePiece, storageIsPersistent, type PieceRecord } from '../lib/storage';
import { plural } from '../lib/patternText';
import etudes from '../examples/etudes.json';

/** Example pieces are bundled as separate chunks (loaded only when opened). */
const EXAMPLE_LOADERS = import.meta.glob('../examples/*.musicxml', { query: '?raw', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;

const EXAMPLES = [
  { file: 'ode-to-joy.musicxml', title: 'Ода к радости', composer: 'Л. ван Бетховен', level: 'для начинающих' },
  { file: 'twinkle.musicxml', title: 'Ах, скажу я вам, мама (Twinkle)', composer: 'Народная песня', level: 'аккорды в левой руке' },
  { file: 'minuet-in-g.musicxml', title: 'Менуэт соль мажор', composer: 'К. Петцольд', level: 'первые пьесы' },
  { file: 'c-major-scale.musicxml', title: 'Гамма до мажор', composer: 'Упражнение', level: 'подкладывание пальцев' },
  { file: 'upbeat-song.musicxml', title: 'Песенка с затактом', composer: 'Учебная пьеса', level: 'фразы с затакта' },
];

interface JobView {
  fileName: string;
  phase: 'upload' | 'recognize' | 'claude' | 'import' | 'error';
  status?: JobStatus;
  claude?: OmrProgress & { pageStartedAt: number };
  error?: string;
  startedAt: number;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

export function HomePage() {
  const [pieces, setPieces] = useState<PieceRecord[] | null>(null);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [claudeOmr, setClaudeOmr] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [, setTick] = useState(0);
  const alive = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listPieces()
      .then(setPieces)
      .catch(() => setPieces([]));
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    if (IS_ARTIFACT) void claudeOmrAvailable().then((ok) => alive.current && setClaudeOmr(ok));
    else getHealth().then((h) => alive.current && setHealth(h));
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  async function importXml(
    xml: string,
    meta: {
      sourceName: string;
      sourceType: PieceRecord['sourceType'];
      pdf?: Blob;
      pages?: Blob[];
      recognizer?: PieceRecord['recognizer'];
      warnings?: string[];
      suffix?: string;
    },
  ) {
    const score = parseScore(xml, baseName(meta.sourceName));
    if (!score.notes.length) throw new Error('В нотах не найдено ни одной ноты. Возможно, файл распознан неудачно.');
    const rec = newPieceRecord({
      title: score.title + (meta.suffix ?? ''),
      composer: score.composer,
      musicXml: xml,
      sourceName: meta.sourceName,
      sourceType: meta.sourceType,
      pdf: meta.pdf,
      pages: meta.pages,
      recognizer: meta.recognizer,
      warnings: meta.warnings?.length ? meta.warnings : undefined,
    });
    rec.measureCount = score.measures.length - (score.measures[0]?.implicit && score.measures.length > 1 ? 1 : 0);
    await savePiece(rec);
    return rec;
  }

  async function handleFile(file: File) {
    setError('');
    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
    const isImage = /\.(png|jpe?g|tiff?)$/.test(lower) || /^image\/(png|jpeg|tiff)$/.test(file.type);
    const isXml = /\.(musicxml|xml|mxl)$/.test(lower);
    try {
      if (isXml) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const rec = await importXml(musicXmlFromBytes(bytes, file.name), { sourceName: file.name, sourceType: 'musicxml' });
        navigate({ page: 'piece', pieceId: rec.id, tab: 'score' });
      } else if (isPdf || isImage) {
        if (IS_ARTIFACT) await recognizeByClaude(file, isPdf);
        else await recognizePdf(file);
      } else {
        setError('Поддерживаются PDF, сканы нот (PNG, JPG, TIFF), MusicXML (.musicxml, .xml) и сжатый MusicXML (.mxl).');
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  async function recognizePdf(file: File) {
    if (health && !health.omr) {
      setError(
        'Сервер распознавания PDF недоступен. Запустите приложение через Docker (см. README) или загрузите MusicXML.',
      );
      return;
    }
    const startedAt = Date.now();
    setJob({ fileName: file.name, phase: 'upload', startedAt });
    try {
      let st = await submitPdf(file);
      setJob({ fileName: file.name, phase: 'recognize', status: st, startedAt });
      while (alive.current && st.status !== 'done' && st.status !== 'error') {
        await new Promise((r) => setTimeout(r, 1200));
        st = await getJob(st.id);
        if (alive.current) setJob({ fileName: file.name, phase: 'recognize', status: st, startedAt });
      }
      if (!alive.current) return;
      if (st.status === 'error') throw new Error(st.error || 'Не удалось распознать ноты');
      setJob({ fileName: file.name, phase: 'import', status: st, startedAt });
      const results = st.results?.length ? st.results : [{ index: 0, name: 'score' }];
      let first: PieceRecord | null = null;
      for (const r of results) {
        const bytes = await getJobResult(st.id, r.index);
        const xml = musicXmlFromBytes(bytes, r.name);
        const rec = await importXml(xml, {
          sourceName: file.name,
          sourceType: 'pdf',
          pdf: file,
          suffix: results.length > 1 ? ` (часть ${r.index + 1})` : '',
        });
        first ??= rec;
      }
      setJob(null);
      if (first) navigate({ page: 'piece', pieceId: first.id, tab: 'score' });
    } catch (e) {
      if (alive.current) setJob({ fileName: file.name, phase: 'error', error: String((e as Error).message || e), startedAt });
    }
  }

  async function recognizeByClaude(file: File, isPdf: boolean) {
    if (claudeOmr === false) {
      setError('Распознавание через Claude недоступно в этом окне. Загрузите MusicXML или откройте пример.');
      return;
    }
    const ctl = new AbortController();
    abortRef.current = ctl;
    const startedAt = Date.now();
    let pageStartedAt = startedAt;
    let lastPage = 0;
    let lastDone = -1;
    setJob({ fileName: file.name, phase: 'claude', startedAt });
    try {
      const res = await recognizeWithClaude(
        file,
        (p) => {
          if (!alive.current) return;
          // the bar creeps on from the last page started, or the last lines read
          if (p.total ? p.done !== lastDone : p.page !== lastPage) {
            lastPage = p.page;
            lastDone = p.done ?? -1;
            pageStartedAt = Date.now();
          }
          setJob({ fileName: file.name, phase: 'claude', claude: { ...p, pageStartedAt }, startedAt });
        },
        ctl.signal,
      );
      if (!alive.current) return;
      setJob({ fileName: file.name, phase: 'import', startedAt });
      const rec = await importXml(res.xml, {
        sourceName: file.name,
        sourceType: isPdf ? 'pdf' : 'image',
        pages: res.pagePreviews,
        recognizer: 'claude',
        warnings: res.warnings,
      });
      setJob(null);
      navigate({ page: 'piece', pieceId: rec.id, tab: 'score' });
    } catch (e) {
      if (!alive.current) return;
      const code = (e as { code?: string }).code;
      if (code === 'cancelled') setJob(null);
      else setJob({ fileName: file.name, phase: 'error', error: String((e as Error).message || e), startedAt });
    } finally {
      abortRef.current = null;
    }
  }

  async function openExample(ex: { file: string }) {
    setError('');
    try {
      const existing = pieces?.find((p) => p.sourceType === 'example' && p.sourceName === ex.file);
      if (existing) {
        navigate({ page: 'piece', pieceId: existing.id, tab: 'score' });
        return;
      }
      const load = EXAMPLE_LOADERS[`../examples/${ex.file}`];
      if (!load) throw new Error('Пример не найден');
      const xml = await load();
      const rec = await importXml(xml, { sourceName: ex.file, sourceType: 'example' });
      navigate({ page: 'piece', pieceId: rec.id, tab: 'score' });
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  const [toDelete, setToDelete] = useState<PieceRecord | null>(null);
  async function remove(p: PieceRecord) {
    setToDelete(null);
    await deletePiece(p.id);
    refresh();
  }

  const elapsed = job ? Math.round((Date.now() - job.startedAt) / 1000) : 0;

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-text">
          <h1>Разучите пьесу по нотам — паттерн за паттерном</h1>
          <p>
            Загрузите PDF или фото нот. {IS_ARTIFACT ? 'Claude распознает ноты, а приложение' : 'Приложение распознает их,'}{' '}
            отдельно для правой и левой руки найдёт повторяющиеся паттерны и их вариации, подберёт аппликатуру и покажет на
            клавиатуре, как играть каждый фрагмент. В вариациях подсвечено только то, что отличается от уже выученного паттерна.
          </p>
          <ol className="hero-steps">
            <li><b>Загрузка</b> — PDF или MusicXML</li>
            <li><b>Вся пьеса</b> — структура «A A′ B…», прослушивание, переход к любому шагу</li>
            <li><b>Гайд</b> — паттерны каждой руки, затем обе руки вместе</li>
          </ol>
        </div>
        <div
          className={`dropzone ${dragOver ? 'over' : ''} ${job && job.phase !== 'error' ? 'busy' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files[0];
            if (f) void handleFile(f);
          }}
          onClick={() => !job || job.phase === 'error' ? inputRef.current?.click() : undefined}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.musicxml,.xml,.mxl,application/pdf,image/png,image/jpeg,image/tiff"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void handleFile(f);
            }}
          />
          {job && job.phase !== 'error' ? (
            <JobProgress job={job} elapsed={elapsed} />
          ) : (
            <>
              <div className="drop-icon" aria-hidden>
                <svg viewBox="0 0 48 48" width="52" height="52">
                  <path d="M14 6h14l10 10v24a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="#eef2ff" stroke="#4f46e5" strokeWidth="2" />
                  <path d="M28 6v10h10" fill="none" stroke="#4f46e5" strokeWidth="2" />
                  <circle cx="21" cy="32" r="3.2" fill="#4f46e5" />
                  <path d="M24 32V20l7 2" fill="none" stroke="#4f46e5" strokeWidth="2.2" />
                </svg>
              </div>
              <div className="drop-title">Перетащите сюда PDF с нотами</div>
              <div className="drop-sub">или нажмите, чтобы выбрать файл</div>
              <div className="drop-formats">PDF · скан PNG/JPG · MusicXML (.musicxml, .xml, .mxl)</div>
            </>
          )}
          {job?.phase === 'claude' && (
            <button
              className="btn small job-stop"
              onClick={(e) => {
                e.stopPropagation();
                abortRef.current?.abort();
              }}
            >
              Остановить
            </button>
          )}
          {job?.phase === 'error' && (
            <div className="job-error">
              <b>Не получилось распознать «{job.fileName}».</b>
              <div>{job.error}</div>
              <div className="muted">
                Совет: лучше всего распознаются чёткие PDF, напечатанные нотным редактором. Если у вас есть MusicXML
                (например, экспорт из MuseScore), загрузите его — он точнее.
              </div>
            </div>
          )}
        </div>
      </section>

      {IS_ARTIFACT ? <ClaudeStatus available={claudeOmr} /> : <ServerStatus health={health} />}
      {error && <div className="alert error">{error}</div>}
      {pieces !== null && !storageIsPersistent() && (
        <div className="alert warn">
          Этот браузер не даёт странице сохранять данные: пьесы будут доступны только до закрытия вкладки.
        </div>
      )}

      <section className="section">
        <h2>Мои пьесы</h2>
        {pieces === null ? (
          <div className="muted">Загрузка…</div>
        ) : pieces.length === 0 ? (
          <div className="empty">Здесь появятся загруженные пьесы. Начните с PDF или попробуйте пример ниже.</div>
        ) : (
          <div className="library">
            {pieces.map((p) => {
              const learned = p.learned.length;
              const total = p.blockCount ?? 0;
              return (
                <div key={p.id} className="piece-card" onClick={() => navigate({ page: 'piece', pieceId: p.id, tab: 'score' })}>
                  <div className="piece-card-top">
                    <span className={`source-tag ${p.sourceType}`}>
                      {p.sourceType === 'pdf' ? 'PDF' : p.sourceType === 'image' ? 'Фото' : p.sourceType === 'example' ? 'Пример' : 'MusicXML'}
                    </span>
                    <button
                      className="icon-btn"
                      title="Удалить"
                      onClick={(e) => {
                        e.stopPropagation();
                        setToDelete(p);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="piece-title">{p.title}</div>
                  <div className="piece-composer">{p.composer || ' '}</div>
                  <div className="piece-meta">
                    {p.measureCount ? `${p.measureCount} ${plural(p.measureCount, 'такт', 'такта', 'тактов')}` : ''}
                    {total ? ` · ${total} шагов` : ''}
                  </div>
                  {total > 0 && (
                    <div className="mini-progress" title={`Выучено шагов: ${learned} из ${total}`}>
                      <div style={{ width: `${Math.round((learned / total) * 100)}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {toDelete && (
        <ConfirmDialog
          title={`Удалить «${toDelete.title}»?`}
          text="Пьеса, ваша аппликатура и отметки о выученных шагах будут удалены из этого браузера."
          confirmLabel="Удалить"
          danger
          onConfirm={() => void remove(toDelete)}
          onCancel={() => setToDelete(null)}
        />
      )}

      <section className="section">
        <h2>Попробовать на примере</h2>
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex.file} className="example-card" onClick={() => void openExample(ex)}>
              <span className="example-title">{ex.title}</span>
              <span className="example-composer">{ex.composer}</span>
              <span className="example-level">{ex.level}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Этюды и пьесы с аппликатурой издания</h2>
        <p className="muted small">
          Ноты и пальцы — из старых изданий в наборе Mutopia Project: общественное достояние или свободная лицензия
          Creative Commons (указана у сборника). Пальцы, напечатанные в издании, приложение соблюдает, а для остальных
          нот подбирает сам. Пьесы Диабелли — партия ученика (primo) из ансамблей в четыре руки.
        </p>
        {ETUDES.map((c) => (
          <details key={c.id} className="etude-collection">
            <summary>
              <b>{c.composer}</b>. {c.title}
              <span className="muted">
                {' '}
                · {c.items.length} {plural(c.items.length, 'пьеса', 'пьесы', 'пьес')}
              </span>
            </summary>
            <div className="etude-list">
              {c.items.map((it) => (
                <button key={it.file} className="etude-item" onClick={() => void openExample(it)}>
                  <span className="etude-no">{it.label}</span>
                  <span className="etude-names">
                    <span className="etude-title">{it.title.replace(/^Упражнение № \d+$/, 'Упражнение')}</span>
                    {it.original && <span className="etude-original">{it.original}</span>}
                  </span>
                </button>
              ))}
            </div>
            <EtudeCredit c={c} />
          </details>
        ))}
      </section>
    </div>
  );
}

interface EtudeCollection {
  id: string;
  title: string;
  composer: string;
  edition: string;
  typeset: string;
  /** none: public domain; several: the pieces (labels) under each */
  licenses: { name: string; url: string; items: string[] }[];
  changes: string;
  items: { file: string; number: number; label: string; title: string; original: string }[];
}
const ETUDES = etudes.collections as EtudeCollection[];

/** Who typeset the notes and under which license (CC BY-SA asks to name them, the license and the changes). */
function EtudeCredit({ c }: { c: EtudeCollection }) {
  const link = (l: EtudeCollection['licenses'][number]) => (
    <a href={l.url} target="_blank" rel="noreferrer">
      {l.name}
    </a>
  );
  return (
    <div className="muted small etude-credit">
      {c.edition && <>Издание: {c.edition}. </>}
      Набор: {c.typeset}, Mutopia Project (
      <a href="https://www.mutopiaproject.org" target="_blank" rel="noreferrer">
        mutopiaproject.org
      </a>
      )
      {c.licenses.length === 0 && <> — общественное достояние.</>}
      {c.licenses.length === 1 && <>. Лицензия: {link(c.licenses[0])}.</>}
      {c.licenses.length > 1 && (
        <>
          . Лицензии:{' '}
          {c.licenses.map((l, i) => (
            <span key={l.name}>
              {i > 0 && ', '}
              {link(l)} ({l.items.join(', ')})
            </span>
          ))}
          .
        </>
      )}
      {c.changes && <> {c.changes}</>}
    </div>
  );
}

function ClaudeStatus({ available }: { available: boolean | null }) {
  if (available === null) return null;
  if (available) {
    return (
      <div className="server-status ok">
        ● PDF и фото нот распознаёт Claude прямо на этой странице (из вашего лимита Claude; при первом запуске попросит
        разрешение). Проверяйте результат по вкладке «Оригинал».
      </div>
    );
  }
  return (
    <div className="server-status warn">
      ● Распознавание PDF через Claude недоступно в этом окне. Откройте ссылку в claude.ai под своим аккаунтом или
      загрузите MusicXML (например, экспорт из MuseScore). Примеры ниже работают всегда.
    </div>
  );
}

function ServerStatus({ health }: { health: ServerHealth | null }) {
  if (!health) return null;
  if (health.omr) {
    return (
      <div className="server-status ok">
        ● Распознавание PDF работает{health.engine ? ` (${health.engine}${health.version ? ' ' + health.version : ''})` : ''}
      </div>
    );
  }
  return (
    <div className="server-status warn">
      ● Распознавание PDF сейчас недоступно{health.message ? `: ${health.message}` : ''}. MusicXML и примеры работают без
      сервера. Чтобы включить PDF, запустите приложение через Docker — инструкция в README.
    </div>
  );
}

const STAGE_RU: Record<string, string> = {
  queued: 'В очереди',
  upload: 'Загрузка файла',
  LOAD: 'Чтение страниц',
  BINARY: 'Подготовка изображения',
  SCALE: 'Определение масштаба',
  GRID: 'Поиск нотных станов',
  HEADERS: 'Ключи и размеры',
  STEM_SEEDS: 'Поиск штилей',
  BEAMS: 'Вязки',
  LEDGERS: 'Добавочные линейки',
  HEADS: 'Головки нот',
  STEMS: 'Штили',
  REDUCTION: 'Уточнение нот',
  CUE_BEAMS: 'Мелкие ноты',
  TEXTS: 'Текст',
  MEASURES: 'Такты',
  CHORDS: 'Аккорды',
  CURVES: 'Лиги',
  SYMBOLS: 'Знаки',
  LINKS: 'Связи',
  RHYTHMS: 'Ритм',
  PAGE: 'Сборка страницы',
  EXPORT: 'Экспорт MusicXML',
  import: 'Анализ: паттерны и аппликатура',
};

function ClaudeProgress({ job, elapsed }: { job: JobView; elapsed: number }) {
  const c = job.claude;
  let pct = 3;
  if (c?.stage === 'prepare') pct = 3 + (c.pages ? (c.page / c.pages) * 7 : 0);
  if (c?.stage === 'read') {
    if (c.total) {
      // lines read, and the calls running now creeping on while Claude thinks
      const inCall = 0.9 * (1 - Math.exp(-(Date.now() - c.pageStartedAt) / 60000));
      pct = 10 + 85 * Math.min(1, ((c.done ?? 0) + (c.running ?? 0) * inCall) / c.total);
    } else {
      const inPage = 0.92 * (1 - Math.exp(-(Date.now() - c.pageStartedAt) / 45000));
      pct = 10 + 85 * ((c.page - 1 + inPage) / Math.max(1, c.pages));
    }
  }
  if (c?.stage === 'build' || job.phase === 'import') pct = 97;
  return (
    <div className="job-progress" onClick={(e) => e.stopPropagation()}>
      <div className="job-title">Распознаю ноты: «{job.fileName}»</div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.round(pct)}%` }} />
      </div>
      <div className="job-stage">
        {job.phase === 'import' ? 'Анализ: паттерны и аппликатура' : c?.message ?? 'Подготовка…'}
        {c && c.measures > 0 ? ` · тактов: ${c.measures}` : ''}
      </div>
      <div className="muted small">
        Прошло {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}. Claude внимательно читает каждую строку
        нот — обычно 1–3 минуты на страницу.
      </div>
    </div>
  );
}

function JobProgress({ job, elapsed }: { job: JobView; elapsed: number }) {
  if (job.phase === 'claude' || (job.phase === 'import' && !job.status)) return <ClaudeProgress job={job} elapsed={elapsed} />;
  const st = job.status;
  // the server reports Audiveris steps; if its log is terse, keep the bar moving with a time-based estimate
  const timeBased = st?.status === 'running' ? 0.9 * (1 - Math.exp(-elapsed / 50)) : 0;
  const pct =
    job.phase === 'upload' ? 3 : job.phase === 'import' ? 98 : Math.max(5, Math.round(Math.max(st?.progress ?? 0, timeBased) * 100));
  const stageKey = job.phase === 'import' ? 'import' : job.phase === 'upload' ? 'upload' : st?.status === 'queued' ? 'queued' : st?.stage ?? '';
  const stage = STAGE_RU[stageKey] ?? stageKey;
  return (
    <div className="job-progress" onClick={(e) => e.stopPropagation()}>
      <div className="job-title">Распознаю ноты: «{job.fileName}»</div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="job-stage">
        {stage}
        {st?.message ? ` — ${st.message}` : ''}
        {st?.status === 'queued' && st.queuePosition ? ` (перед вами: ${st.queuePosition})` : ''}
      </div>
      <div className="muted small">
        Прошло {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}. Обычно уходит 20–60 секунд на страницу.
      </div>
    </div>
  );
}
