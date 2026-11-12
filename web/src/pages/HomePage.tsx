import { useCallback, useEffect, useRef, useState } from 'react';
import { getHealth, getJob, getJobResult, submitPdf, type JobStatus, type ServerHealth } from '../lib/api';
import { navigate } from '../lib/hooks';
import { musicXmlFromBytes, parseScore } from '../lib/musicxml';
import { deletePiece, listPieces, newPieceRecord, savePiece, type PieceRecord } from '../lib/storage';

const EXAMPLES = [
  { file: 'ode-to-joy.musicxml', title: 'Ода к радости', composer: 'Л. ван Бетховен', level: 'для начинающих' },
  { file: 'twinkle.musicxml', title: 'Ах, скажу я вам, мама (Twinkle)', composer: 'Народная песня', level: 'аккорды в левой руке' },
  { file: 'minuet-in-g.musicxml', title: 'Менуэт соль мажор', composer: 'К. Петцольд', level: 'первые пьесы' },
  { file: 'c-major-scale.musicxml', title: 'Гамма до мажор', composer: 'Упражнение', level: 'подкладывание пальцев' },
];

interface JobView {
  fileName: string;
  phase: 'upload' | 'recognize' | 'import' | 'error';
  status?: JobStatus;
  error?: string;
  startedAt: number;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

export function HomePage() {
  const [pieces, setPieces] = useState<PieceRecord[] | null>(null);
  const [health, setHealth] = useState<ServerHealth | null>(null);
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
    getHealth().then((h) => alive.current && setHealth(h));
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  async function importXml(xml: string, meta: { sourceName: string; sourceType: PieceRecord['sourceType']; pdf?: Blob; suffix?: string }) {
    const score = parseScore(xml, baseName(meta.sourceName));
    if (!score.notes.length) throw new Error('В нотах не найдено ни одной ноты. Возможно, файл распознан неудачно.');
    const rec = newPieceRecord({
      title: score.title + (meta.suffix ?? ''),
      composer: score.composer,
      musicXml: xml,
      sourceName: meta.sourceName,
      sourceType: meta.sourceType,
      pdf: meta.pdf,
    });
    rec.measureCount = score.measures.length;
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
        navigate({ page: 'piece', pieceId: rec.id, tab: 'guide', step: 1 });
      } else if (isPdf || isImage) {
        await recognizePdf(file);
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
      if (first) navigate({ page: 'piece', pieceId: first.id, tab: 'guide', step: 1 });
    } catch (e) {
      if (alive.current) setJob({ fileName: file.name, phase: 'error', error: String((e as Error).message || e), startedAt });
    }
  }

  async function openExample(ex: (typeof EXAMPLES)[number]) {
    setError('');
    try {
      const existing = pieces?.find((p) => p.sourceType === 'example' && p.sourceName === ex.file);
      if (existing) {
        navigate({ page: 'piece', pieceId: existing.id, tab: 'guide', step: 1 });
        return;
      }
      const xml = await fetch(`./examples/${ex.file}`).then((r) => {
        if (!r.ok) throw new Error('Пример не найден');
        return r.text();
      });
      const rec = await importXml(xml, { sourceName: ex.file, sourceType: 'example' });
      navigate({ page: 'piece', pieceId: rec.id, tab: 'guide', step: 1 });
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  async function remove(p: PieceRecord) {
    if (!confirm(`Удалить «${p.title}» из библиотеки?`)) return;
    await deletePiece(p.id);
    refresh();
  }

  const elapsed = job ? Math.round((Date.now() - job.startedAt) / 1000) : 0;

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-text">
          <h1>Разучите пьесу по нотам — блок за блоком</h1>
          <p>
            Загрузите PDF с нотами. Приложение распознает их, разделит пьесу на небольшие фразы, подберёт аппликатуру и
            покажет на клавиатуре, как играть каждый блок. Каждый блок можно прослушать в удобном темпе.
          </p>
          <ol className="hero-steps">
            <li><b>Загрузка</b> — PDF или MusicXML</li>
            <li><b>Гайд</b> — шаги по блокам с пальцами</li>
            <li><b>Вся пьеса</b> — карта блоков, переход к любому шагу</li>
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

      <ServerStatus health={health} />
      {error && <div className="alert error">{error}</div>}

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
                <div key={p.id} className="piece-card" onClick={() => navigate({ page: 'piece', pieceId: p.id, tab: 'guide', step: (p.lastBlock ?? 0) + 1 })}>
                  <div className="piece-card-top">
                    <span className={`source-tag ${p.sourceType}`}>
                      {p.sourceType === 'pdf' ? 'PDF' : p.sourceType === 'example' ? 'Пример' : 'MusicXML'}
                    </span>
                    <button
                      className="icon-btn"
                      title="Удалить"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(p);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="piece-title">{p.title}</div>
                  <div className="piece-composer">{p.composer || ' '}</div>
                  <div className="piece-meta">
                    {p.measureCount ? `${p.measureCount} тактов` : ''}
                    {total ? ` · ${total} блоков` : ''}
                  </div>
                  {total > 0 && (
                    <div className="mini-progress" title={`Выучено блоков: ${learned} из ${total}`}>
                      <div style={{ width: `${Math.round((learned / total) * 100)}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

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
  import: 'Анализ: блоки и аппликатура',
};

function JobProgress({ job, elapsed }: { job: JobView; elapsed: number }) {
  const st = job.status;
  const pct = job.phase === 'upload' ? 3 : job.phase === 'import' ? 98 : Math.max(5, Math.round((st?.progress ?? 0) * 100));
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
