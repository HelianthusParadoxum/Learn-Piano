/**
 * Sheet-music recognition by Claude, for the artifact edition (no server).
 * Pages are rendered in the browser, cut into systems and sent to Claude through the artifact's
 * `sample` capability; Claude answers in the compact notation of ./notation.ts, which becomes MusicXML.
 */
import { useCapability } from '../platform';
import { transcriptionToMusicXml, type TranscribedMeasure, type Transcription } from './notation';
import { analyzePage, cropToBlob, isPdfFile, MAX_PAGES, pagePreview, renderDocument } from './pages';

interface SampleLimits {
  images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] };
}
interface SampleError {
  code: string;
  message: string;
  text?: string;
}
interface SampleFn {
  json<T>(input: string, options?: Record<string, unknown>): Promise<T>;
  limits(): Promise<SampleLimits>;
}

export interface OmrProgress {
  stage: 'prepare' | 'read' | 'build';
  page: number;
  pages: number;
  /** measures transcribed so far (approximate while Claude writes) */
  measures: number;
  message: string;
  /** systems (lines of music) read so far, of all systems, and calls running now */
  done?: number;
  total?: number;
  running?: number;
}

export interface OmrResult {
  xml: string;
  pagePreviews: Blob[];
  warnings: string[];
  measures: number;
}

export class OmrError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Is recognition through Claude possible in this view? (cheap: no usage, no prompt) */
export async function claudeOmrAvailable(): Promise<boolean> {
  const sample = await useCapability<SampleFn>('sample');
  if (!sample) return false;
  try {
    const limits = await sample.limits();
    return !!limits.images;
  } catch {
    return false;
  }
}

const NOTATION_RULES = `Write each measure as JSON: {"rh": "...", "lh": "..."} — "rh" is the upper (treble) staff, "lh" the lower (bass) staff of the piano system. For music on ONE staff per system use only "rh".
Inside "rh"/"lh": events in time order separated by spaces. Event = NOTES ":" DURATION.
- NOTES: a pitch in scientific notation (middle C = C4, the octave number changes at C): C4, F#5, Bb3; a chord: C4+E4+G4; a rest: r.
- Write the pitch that actually SOUNDS: apply the key signature, accidentals earlier in the same measure and on the same line/space, and naturals. Watch the clef of each staff (treble/bass) and clef changes.
- DURATION: w whole, h half, q quarter, e eighth, s 16th, t 32nd; add "." for a dotted value ("q."), ".." for double-dotted; add "T" for notes of a triplet ("eT eT eT" fills one quarter). "r:m" is a whole-measure rest.
- Append "~" to an event whose notes are tied to the next event ("C5:h~ C5:q").
- If a fingering number is printed for a note, append it to that pitch with "@": "E5@3:q".
- If one staff has two independent rhythms (stems up and stems down), give a list with one string per voice, each covering the whole measure (fill gaps with rests): "rh": ["E5:h D5:h", "C5:q B4:q A4:h"].
- Every voice must add up to the time signature, except a pickup (anacrusis) measure at the very start.
- Leave out grace notes, ornaments, dynamics, pedal marks and lyrics. Repeats: transcribe the measures once, as printed.
- If the key or time signature changes at a measure, add "key": <fifths> and/or "time": "6/8" to that measure.`;

function firstPrompt(pages: number, systems: number, hasHeader: boolean): string {
  return `You are an expert music copyist. Transcribe printed sheet music exactly, note by note, for a piano learning app.

The ${hasHeader ? `first image is the top of page 1 (title area); the next ${systems}` : `${systems}`} image(s) are consecutive systems (lines of music) of page 1 of ${pages}, in reading order.

${NOTATION_RULES}

Reply with only this JSON object:
{"title": "<title as printed, or empty>", "composer": "<composer as printed, or empty>", "keyFifths": <sharps as a positive number, flats as negative>, "time": "<first time signature, e.g. 3/4>", "tempo": <quarter-note BPM if a metronome mark is printed, else null>, "staves": <2 for piano grand staff, 1 for a single staff>, "measures": [ ...every measure of these systems, in order... ]}

Example of the format: {"title":"Minuet","composer":"","keyFifths":1,"time":"3/4","tempo":null,"staves":2,"measures":[{"rh":"D5:q G4:e A4:e B4:e C5:e","lh":"G3+B3+D4:h A3:q"},{"rh":"D5:q G4:q G4:q","lh":"B3:h."}]}`;
}

function nextPrompt(page: number, pages: number, from: number, systems: number, ctx: Context): string {
  const which = systems === 1 ? `system ${from} (a line of music)` : `systems ${from}–${from + systems - 1} (lines of music)`;
  return `You are an expert music copyist. Transcribe a part of a piece of printed sheet music exactly, note by note, for a piano learning app.

The ${systems} image(s) are ${which} of page ${page} of ${pages}, in reading order. The piece starts in the key signature ${ctx.key} (fifths: + sharps, − flats) and the time signature ${ctx.time}: read the key signature printed at the start of each system and any time signature printed in these images. Staves per system: ${ctx.staves}.

${NOTATION_RULES}

Reply with only this JSON object: {"measures": [ ...every measure of these systems, in order... ]}`;
}

interface Context {
  key: number;
  time: string;
  staves: number;
}

const ERROR_TEXT: Record<string, string> = {
  invalid_request: 'Страница отправила Claude запрос, который он не принимает. Это ошибка приложения.',
  transform_error: 'Страница не смогла подготовить запрос к Claude. Это ошибка приложения.',
  queue_overflow: 'Слишком много запросов к Claude сразу. Обновите страницу и попробуйте ещё раз.',
  not_granted: 'Нет разрешения обращаться к Claude из этой страницы. Разрешите доступ в появившемся окне или загрузите MusicXML.',
  sampling_disabled: 'Claude недоступен для этого аккаунта. Загрузите MusicXML.',
  not_declared: 'Распознавание через Claude отключено для этой страницы.',
  capability_disabled: 'Распознавание через Claude недоступно в этом окне.',
  capability_removed: 'Распознавание через Claude недоступно в этом окне.',
  images_unavailable: 'В этом окне нельзя отправлять изображения в Claude.',
  rate_limited: 'Слишком много запросов к Claude или исчерпан лимит использования. Попробуйте позже.',
  session_expired: 'Сессия Claude истекла — войдите снова и повторите.',
  image_rejected: 'Claude не принял изображение страницы. Попробуйте другой файл или скан лучшего качества.',
  refused: 'Claude отказался обрабатывать этот файл.',
  empty_completion: 'Claude вернул пустой ответ. Попробуйте ещё раз.',
  invalid_json: 'Ответ Claude оборвался или пришёл не в том формате. Попробуйте ещё раз — ответы немного различаются.',
  prompt_too_large: 'Страница слишком большая для одного запроса.',
  upstream_error: 'Сбой связи с Claude. Попробуйте ещё раз.',
  cancelled: 'Распознавание остановлено.',
};

function toOmrError(e: unknown): OmrError {
  if (e instanceof OmrError) return e;
  const se = e as Partial<SampleError>;
  if (se && typeof se.code === 'string') {
    // the code helps to tell what happened when a viewer reports it
    const text = ERROR_TEXT[se.code] ?? ERROR_TEXT.upstream_error;
    return new OmrError(se.code === 'cancelled' ? text : `${text} (код: ${se.code})`, se.code);
  }
  return new OmrError(String((e as Error)?.message || e), 'error');
}

/**
 * Systems (lines of music) per call. Claude writes one answer per call, and an answer is cut off at a length and
 * time limit (about five minutes, thinking included): a whole page of dense music in one call outgrows it.
 */
const SYSTEMS_PER_CALL = 2;
/** Calls at a time: the platform runs a couple of calls at once for a viewer (more wait their turn). */
const PARALLEL = 2;
/** Failures that asking for less can cure: an answer cut off or unreadable, a dropped connection. */
const SPLITTABLE = new Set(['invalid_json', 'empty_completion', 'upstream_error']);

/** Consecutive systems of a page sent in one call (the first call also gets the title area). */
interface Chunk {
  page: number;
  /** number of its first system on the page, from 1 */
  from: number;
  strips: Blob[];
  header: Blob | null;
}

interface ChunkResult {
  measures: TranscribedMeasure[];
  /** the answer to the first call: title, key, time… */
  head?: Partial<Transcription>;
  /** systems that could not be read even one at a time */
  failed: { page: number; system: number; code: string }[];
}

function countMeasures(text: string) {
  return (text.match(/"rh"\s*:/g) ?? []).length;
}

export async function recognizeWithClaude(
  file: File,
  onProgress: (p: OmrProgress) => void,
  signal: AbortSignal,
): Promise<OmrResult> {
  const sample = await useCapability<SampleFn>('sample');
  if (!sample) throw new OmrError(ERROR_TEXT.capability_disabled, 'capability_disabled');
  let limits: SampleLimits;
  try {
    limits = await sample.limits();
  } catch (e) {
    throw toOmrError(e);
  }
  if (!limits.images) throw new OmrError(ERROR_TEXT.images_unavailable, 'images_unavailable');
  const maxImages = Math.max(1, limits.images.maxCount || 1);

  onProgress({ stage: 'prepare', page: 0, pages: 0, measures: 0, message: isPdfFile(file) ? 'Открываю PDF…' : 'Открываю изображение…' });
  let canvases: HTMLCanvasElement[];
  try {
    canvases = await renderDocument(file, (page, pages) =>
      onProgress({ stage: 'prepare', page, pages, measures: 0, message: `Готовлю страницу ${page} из ${pages}` }),
    );
  } catch (e) {
    throw new OmrError('Не удалось открыть файл: ' + String((e as Error)?.message || e), 'render');
  }
  if (signal.aborted) throw new OmrError(ERROR_TEXT.cancelled, 'cancelled');
  const pagePreviews = await Promise.all(canvases.map(pagePreview));
  const pages = canvases.length;

  // every page cut into systems, a few systems per call
  const perCall = Math.max(1, Math.min(SYSTEMS_PER_CALL, maxImages - 1));
  const chunks: Chunk[] = [];
  for (let p = 0; p < pages; p++) {
    const layout = analyzePage(canvases[p]);
    const strips = await Promise.all(layout.systems.map((sys) => cropToBlob(canvases[p], sys)));
    const header = p === 0 && layout.header ? await cropToBlob(canvases[p], layout.header, 1400) : null;
    for (let start = 0; start < strips.length; start += perCall) {
      chunks.push({ page: p + 1, from: start + 1, strips: strips.slice(start, start + perCall), header: start === 0 ? header : null });
    }
  }
  const total = chunks.reduce((a, c) => a + c.strips.length, 0);

  // stops the other calls when one fails for good, and with the viewer's Stop
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener('abort', onAbort);
  let done = 0;
  let doneMeasures = 0;
  let lastPage = 1;
  const writing = new Map<number, number>();
  let callId = 0;
  const report = () =>
    onProgress({
      stage: 'read',
      page: lastPage,
      pages,
      measures: doneMeasures + [...writing.values()].reduce((a, n) => a + n, 0),
      message: total > perCall ? `Claude читает ноты: прочитано строк ${done} из ${total}` : `Claude читает страницу ${lastPage} из ${pages}`,
      done,
      total,
      running: writing.size,
    });

  const ask = async (c: Chunk, ctx: Context | null): Promise<Partial<Transcription>> => {
    const id = callId++;
    writing.set(id, 0);
    lastPage = c.page;
    report();
    try {
      const answer = await sample.json<Partial<Transcription>>(
        ctx ? nextPrompt(c.page, pages, c.from, c.strips.length, ctx) : firstPrompt(pages, c.strips.length, !!c.header),
        {
          images: c.header ? [c.header, ...c.strips] : c.strips,
          modelTier: 'complex',
          signal: stop.signal,
          onText: ({ text }: { text: string }) => {
            if (!writing.has(id)) return;
            writing.set(id, countMeasures(text));
            report();
          },
        },
      );
      if (!answer || !Array.isArray(answer.measures)) throw new OmrError(ERROR_TEXT.invalid_json, 'invalid_json');
      return answer;
    } catch (e) {
      throw toOmrError(e);
    } finally {
      writing.delete(id);
    }
  };

  /** Transcribes a chunk; an answer cut off or unreadable is asked again in halves, down to one system. */
  const transcribe = async (c: Chunk, ctx: Context | null): Promise<ChunkResult> => {
    try {
      const answer = await ask(c, ctx);
      return { measures: answer.measures as TranscribedMeasure[], head: ctx ? undefined : answer, failed: [] };
    } catch (e) {
      const err = toOmrError(e);
      if (!SPLITTABLE.has(err.code) || stop.signal.aborted) throw err;
      if (c.strips.length === 1) {
        // the first lines carry the key and time for the rest: without them nothing can go on
        if (!ctx) throw err;
        return { measures: [], failed: [{ page: c.page, system: c.from, code: err.code }] };
      }
      const half = Math.ceil(c.strips.length / 2);
      const a = await transcribe({ ...c, strips: c.strips.slice(0, half) }, ctx);
      const b = await transcribe({ page: c.page, from: c.from + half, strips: c.strips.slice(half), header: null }, ctx ?? contextOf(a.head));
      return { measures: [...a.measures, ...b.measures], head: a.head, failed: [...a.failed, ...b.failed] };
    }
  };

  const results: ChunkResult[] = [];
  try {
    // the first call alone: it asks the viewer's consent and reads the title, key and time
    results[0] = await transcribe(chunks[0], null);
    const ctx = contextOf(results[0].head);
    done += chunks[0].strips.length;
    doneMeasures += results[0].measures.length;
    report();
    let next = 1;
    const worker = async () => {
      while (next < chunks.length) {
        const k = next++;
        results[k] = await transcribe(chunks[k], ctx);
        done += chunks[k].strips.length;
        doneMeasures += results[k].measures.length;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length - 1) }, worker));
  } catch (e) {
    stop.abort();
    const err = toOmrError(e);
    throw signal.aborted ? new OmrError(ERROR_TEXT.cancelled, 'cancelled') : err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  const head = results[0].head ?? {};
  const merged: Transcription = {
    title: typeof head.title === 'string' ? head.title : '',
    composer: typeof head.composer === 'string' ? head.composer : '',
    keyFifths: Number(head.keyFifths) || 0,
    time: typeof head.time === 'string' ? head.time : '4/4',
    tempo: typeof head.tempo === 'number' ? head.tempo : null,
    staves: head.staves === 1 ? 1 : 2,
    clef: typeof head.clef === 'string' ? head.clef : undefined,
    measures: [],
  };
  for (const r of results) {
    for (const m of r.measures) if (m && typeof m === 'object') merged.measures.push(m);
  }
  const warnings: string[] = [];
  const failed = results.flatMap((r) => r.failed);
  if (failed.length) {
    const one = failed.length === 1;
    warnings.push(
      `Claude не смог прочитать ${one ? 'строку' : 'строки'} нот: ${failed.map((f) => `стр. ${f.page}, строка ${f.system}`).join('; ')} — ` +
        `${one ? 'её' : 'их'} такты пропущены. Сверьтесь с оригиналом или распознайте файл ещё раз: в течение пяти минут ` +
        'уже прочитанные строки возьмутся из памяти без нового ожидания.',
    );
  }
  if (!merged.measures.length) throw new OmrError('Claude не нашёл на страницах ни одного такта.', 'empty');
  onProgress({ stage: 'build', page: pages, pages, measures: merged.measures.length, message: 'Собираю ноты…', done: total, total });
  const res = transcriptionToMusicXml(merged);
  warnings.push(...res.warnings);
  if (canvases.length >= MAX_PAGES) warnings.push(`Распознаны только первые ${MAX_PAGES} страниц.`);
  return { xml: res.xml, pagePreviews, warnings, measures: res.measures };
}

/** Key, time and staves read from the first lines, given to the calls for the rest. */
function contextOf(head: Partial<Transcription> | undefined): Context {
  if (!head) throw new OmrError(ERROR_TEXT.invalid_json, 'invalid_json');
  return {
    key: Number(head.keyFifths) || 0,
    time: typeof head.time === 'string' ? head.time : '4/4',
    staves: head.staves === 1 ? 1 : 2,
  };
}
