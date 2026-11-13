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

function nextPrompt(page: number, pages: number, systems: number, ctx: { measures: number; key: number; time: string; staves: number }): string {
  return `You are an expert music copyist. Continue transcribing a piece of printed sheet music exactly, note by note, for a piano learning app.

The ${systems} image(s) are consecutive systems (lines of music) of page ${page} of ${pages}, in reading order. So far ${ctx.measures} measures were transcribed; the key signature is ${ctx.key} (fifths: + sharps, − flats) and the time signature ${ctx.time} unless these images show a change. Staves per system: ${ctx.staves}.

${NOTATION_RULES}

Reply with only this JSON object: {"measures": [ ...every measure of these systems, in order... ]}`;
}

const ERROR_TEXT: Record<string, string> = {
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
  invalid_json: 'Claude ответил в неожиданном формате. Попробуйте ещё раз — ответы немного различаются.',
  prompt_too_large: 'Страница слишком большая для одного запроса.',
  upstream_error: 'Сбой связи с Claude. Попробуйте ещё раз.',
  cancelled: 'Распознавание остановлено.',
};

function toOmrError(e: unknown): OmrError {
  if (e instanceof OmrError) return e;
  const se = e as Partial<SampleError>;
  if (se && typeof se.code === 'string') return new OmrError(ERROR_TEXT[se.code] ?? ERROR_TEXT.upstream_error, se.code);
  return new OmrError(String((e as Error)?.message || e), 'error');
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

  const merged: Transcription = { measures: [] };
  const warnings: string[] = [];
  let key = 0;
  let time = '4/4';
  for (let p = 0; p < pages; p++) {
    const layout = analyzePage(canvases[p]);
    const strips = await Promise.all(layout.systems.map((s) => cropToBlob(canvases[p], s)));
    const header = p === 0 && layout.header ? await cropToBlob(canvases[p], layout.header, 1400) : null;
    // split the systems of a page into calls of at most `maxImages` images
    const perCall = Math.max(1, maxImages - (header ? 1 : 0));
    for (let start = 0; start < strips.length; start += perCall) {
      const chunk = strips.slice(start, start + perCall);
      const isFirst = p === 0 && start === 0;
      const images = isFirst && header ? [header, ...chunk] : chunk;
      const prompt = isFirst
        ? firstPrompt(pages, chunk.length, !!header)
        : nextPrompt(p + 1, pages, chunk.length, {
            measures: merged.measures.length,
            key,
            time,
            staves: merged.staves ?? 2,
          });
      const before = merged.measures.length;
      onProgress({
        stage: 'read',
        page: p + 1,
        pages,
        measures: before,
        message: `Claude читает страницу ${p + 1} из ${pages}${strips.length > perCall ? ` (строки ${start + 1}–${start + chunk.length})` : ''}`,
      });
      let answer: Partial<Transcription>;
      try {
        answer = await sample.json<Partial<Transcription>>(prompt, {
          images,
          modelTier: 'complex',
          signal,
          onText: ({ text }: { text: string }) =>
            onProgress({
              stage: 'read',
              page: p + 1,
              pages,
              measures: before + countMeasures(text),
              message: `Claude записывает ноты страницы ${p + 1} из ${pages}`,
            }),
        });
      } catch (e) {
        throw toOmrError(e);
      }
      if (!answer || !Array.isArray(answer.measures)) {
        throw new OmrError(ERROR_TEXT.invalid_json, 'invalid_json');
      }
      if (isFirst) {
        merged.title = typeof answer.title === 'string' ? answer.title : '';
        merged.composer = typeof answer.composer === 'string' ? answer.composer : '';
        merged.keyFifths = Number(answer.keyFifths) || 0;
        merged.time = typeof answer.time === 'string' ? answer.time : '4/4';
        merged.tempo = typeof answer.tempo === 'number' ? answer.tempo : null;
        merged.staves = answer.staves === 1 ? 1 : 2;
        merged.clef = typeof answer.clef === 'string' ? answer.clef : undefined;
        key = merged.keyFifths;
        time = merged.time;
      }
      for (const m of answer.measures as TranscribedMeasure[]) {
        if (!m || typeof m !== 'object') continue;
        if (m.key !== undefined && Number.isFinite(Number(m.key))) key = Number(m.key);
        if (typeof m.time === 'string') time = m.time;
        merged.measures.push(m);
      }
      if (signal.aborted) throw new OmrError(ERROR_TEXT.cancelled, 'cancelled');
    }
  }
  if (!merged.measures.length) throw new OmrError('Claude не нашёл на страницах ни одного такта.', 'empty');
  onProgress({ stage: 'build', page: pages, pages, measures: merged.measures.length, message: 'Собираю ноты…' });
  const res = transcriptionToMusicXml(merged);
  warnings.push(...res.warnings);
  if (canvases.length >= MAX_PAGES) warnings.push(`Распознаны только первые ${MAX_PAGES} страниц.`);
  return { xml: res.xml, pagePreviews, warnings, measures: res.measures };
}
