/** Human-readable descriptions of the pattern structure (Russian). */
import { EPS, type Block, type GuideStep, type Hand, type NoteEvent, type PatternFamily, type Score } from './model';
import { intervalName, stepName } from './noteNames';

export const HAND_NAME: Record<Hand, string> = { R: 'Правая рука', L: 'Левая рука' };
export const HAND_LOWER: Record<Hand, string> = { R: 'правая рука', L: 'левая рука' };
export const HAND_SHORT: Record<Hand, string> = { R: 'правая', L: 'левая' };
const STEP_NAMES = ['', 'секунду', 'терцию', 'кварту', 'квинту', 'сексту', 'септиму', 'октаву'];

/** Russian plural: plural(21, 'паттерн', 'паттерна', 'паттернов') → "паттерн". */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

export function measuresText(score: Score, a: number, b: number): string {
  const ma = score.measures[a]?.number ?? String(a + 1);
  const mb = score.measures[b]?.number ?? String(b + 1);
  return a === b ? `такт ${ma}` : `такты ${ma}–${mb}`;
}

/** A stretch of the piece: [start, end) in quarters, full measures coreStart…endMeasure. */
export interface Stretch {
  startMeasure: number;
  endMeasure: number;
  start: number;
  coreStart?: number;
}

/** The stretch begins before its first full measure (with an upbeat). */
export function hasUpbeat(score: Score, x: Stretch): boolean {
  const core = x.coreStart ?? x.startMeasure;
  return x.start < (score.measures[core]?.start ?? 0) - EPS;
}

/** "такты 5–8" or "такты 5–8 с затактом" */
export function stretchText(score: Score, x: Stretch): string {
  return measuresText(score, x.coreStart ?? x.startMeasure, x.endMeasure) + (hasUpbeat(score, x) ? ' с затактом' : '');
}

export function blockMeasures(score: Score, b: Block): string {
  return stretchText(score, b);
}

/** "т. 5–8" */
export function shortMeasures(score: Score, a: number, b: number): string {
  const ma = score.measures[a]?.number ?? String(a + 1);
  const mb = score.measures[b]?.number ?? String(b + 1);
  return a === b ? `т. ${ma}` : `т. ${ma}–${mb}`;
}

/** "т. 5–8" or "т. 5–8 с затактом" */
export function shortStretch(score: Score, x: Stretch): string {
  return shortMeasures(score, x.coreStart ?? x.startMeasure, x.endMeasure) + (hasUpbeat(score, x) ? ' с затактом' : '');
}

/** "на большую секунду ниже" / "на терцию выше по ступеням гаммы" */
export function shiftText(b: Block): string {
  if (b.steps) {
    const n = Math.abs(b.steps);
    const name = n <= 7 ? STEP_NAMES[n] : `${n} ступеней`;
    return `на ${name} ${b.steps > 0 ? 'выше' : 'ниже'} по ступеням гаммы`;
  }
  if (b.transpose) return `на ${intervalName(b.transpose, true)} ${b.transpose > 0 ? 'выше' : 'ниже'}`;
  return '';
}

/** "весь рисунок сдвинут на большую секунду вниз" / "… вверх по ступеням гаммы (секвенция)" */
export function transpositionText(b: Block): string {
  if (b.steps) {
    const n = Math.abs(b.steps);
    const name = n <= 7 ? STEP_NAMES[n] : `${n} ступеней`;
    return `весь рисунок сдвинут на ${name} ${b.steps > 0 ? 'вверх' : 'вниз'} по ступеням гаммы (секвенция)`;
  }
  if (b.transpose) {
    return `весь рисунок сдвинут на ${intervalName(b.transpose, true)} ${b.transpose > 0 ? 'вверх' : 'вниз'}`;
  }
  return '';
}

const isShifted = (b: Block) => b.transpose !== 0 || !!b.steps;

/** Notes of a hand in one measure, inside a fragment's span. */
function notesIn(score: Score, measure: number, hand: Hand, b: Block): NoteEvent[] {
  return score.notes
    .filter((n) => n.hand === hand && !n.grace && n.measureIndex === measure && n.onset >= b.start - EPS && n.onset < b.end - EPS)
    .sort((x, y) => x.onset - y.onset || x.midi - y.midi);
}

/** "ми, ре+соль, до" — notes in time order, chords joined with "+". */
function listNotes(notes: NoteEvent[], withOctave: boolean): string {
  const groups: NoteEvent[][] = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].onset - n.onset) < EPS * 10) g.push(n);
    else groups.push([n]);
  }
  // a chord with the same note in two octaves (e.g. an octave in the bass) needs octave numbers
  const octaves = withOctave || groups.some((g) => new Set(g.map((n) => n.step + n.alter)).size < g.length);
  const name = (n: NoteEvent) => stepName(n.step, n.alter, 'solfege') + (octaves ? `${n.octave}` : '');
  const parts = groups.map((g) => g.map(name).join('+'));
  if (parts.length > 10) return parts.slice(0, 10).join(', ') + ', …';
  return parts.join(', ');
}

/** Differences of a variation from its base, measure by measure (notes of the variation's hand). */
export function diffLines(score: Score, blocks: Block[], families: PatternFamily[], b: Block): string[] {
  if (!b.diff) return [];
  const base = blocks[families[b.family].base];
  const letter = families[b.family].letter;
  const hand = b.hand;
  const lines: string[] = [];
  const shift = transpositionText(b);
  if (shift) lines.push(`По сравнению с ${letter} ${shift}.`);
  const bStart = b.coreStart ?? b.startMeasure;
  const baseStart = base.coreStart ?? base.startMeasure;
  const changed = new Set(b.diff.changed);
  const rhythm = new Set(b.diff.rhythm);
  const baseLost = new Set(b.diff.baseUnmatched);
  const span = b.endMeasure - bStart + 1;
  for (const m of b.diff.measures) {
    if (!m.changed && !m.missing && !m.rhythm) continue;
    const vm = bStart + m.offset;
    const bm = baseStart + m.offset;
    const where =
      m.offset < 0
        ? `Затакт (конец такта ${score.measures[vm]?.number ?? vm + 1})`
        : `Такт ${score.measures[vm]?.number ?? vm + 1}${span > 1 ? ` (${m.offset + 1}-й такт паттерна)` : ''}`;
    const here = notesIn(score, vm, hand, b);
    const there = notesIn(score, bm, hand, base);
    const handChanged = here.some((n) => changed.has(n.id)) || there.some((n) => baseLost.has(n.id));
    const handRhythm = here.some((n) => rhythm.has(n.id));
    if (!handChanged && !handRhythm) continue;
    if (!handChanged) {
      lines.push(`${where}: те же ноты, но другой ритм (длительности).`);
      continue;
    }
    if (!here.length) {
      lines.push(`${where}: здесь пауза (в ${letter} — ${listNotes(there, false)}).`);
      continue;
    }
    if (!there.length) {
      lines.push(`${where}: добавились ноты ${listNotes(here, false)} (в ${letter} рука молчала).`);
      continue;
    }
    let a = listNotes(there, false);
    let c = listNotes(here, false);
    if (a === c) {
      a = listNotes(there, true);
      c = listNotes(here, true);
    }
    lines.push(`${where}: в ${letter} — ${a}; здесь — ${c}.`);
  }
  if (lines.length > 8) return [...lines.slice(0, 8), `…и ещё ${lines.length - 8} отличий — смотрите выделенные ноты.`];
  return lines;
}

/** Number of measures of the variation that contain differences. */
export function changedMeasureCount(b: Block): number {
  return b.diff ? b.diff.measures.filter((m) => m.changed || m.missing || m.rhythm).length : 0;
}

export function diffNoteCount(b: Block): number {
  return b.diff ? b.diff.changed.length + b.diff.rhythm.length : 0;
}

export interface Occurrence {
  block: Block;
  text: string;
}

/** All appearances of a pattern family with their roles. */
export function occurrences(score: Score, blocks: Block[], families: PatternFamily[], family: number): Occurrence[] {
  return families[family].blocks.map((k) => {
    const b = blocks[k];
    const where = blockMeasures(score, b);
    if (b.role === 'base') return { block: b, text: `${b.label}: ${where} — основа` };
    if (b.role === 'repeat') {
      const of = blocks[b.repeatOf!];
      if (isShifted(b)) {
        return { block: b, text: `${b.label}: ${where} — тот же рисунок ${shiftText(b)}${b.sequenceOf !== undefined ? ' (секвенция)' : ''}` };
      }
      return { block: b, text: `${b.label}: ${where} — точный повтор${of.role === 'variation' ? ` вариации ${of.label}` : ''}` };
    }
    const n = changedMeasureCount(b);
    return {
      block: b,
      text: `${b.label}: ${where} — вариация, совпадает на ${Math.round(b.similarity * 100)}%${n ? `, отличия в ${n} ${plural(n, 'такте', 'тактах', 'тактах')}` : ''}${isShifted(b) ? ', сдвинута' : ''}`,
    };
  });
}

export interface HandSummary {
  hand: Hand;
  /** measures where the hand plays */
  measures: number;
  /** measures to learn: patterns plus the changed measures of variations */
  learn: number;
  patterns: number;
  variations: number;
  labels: string;
}

/** How much of each hand's part is new material once its patterns are learned. */
export function structureSummary(blocks: Block[], families: PatternFamily[]): HandSummary[] {
  const out: HandSummary[] = [];
  for (const hand of ['R', 'L'] as Hand[]) {
    const mine = blocks.filter((b) => b.hand === hand);
    if (!mine.length) continue;
    let measures = 0;
    let learn = 0;
    let variations = 0;
    for (const b of mine) {
      const len = b.endMeasure - (b.coreStart ?? b.startMeasure) + 1;
      measures += len;
      if (b.role === 'base') learn += len;
      else if (b.role === 'variation') {
        variations++;
        learn += isShifted(b) ? len : changedMeasureCount(b);
      }
    }
    out.push({
      hand,
      measures,
      learn: Math.min(measures, learn),
      patterns: families.filter((f) => f.hand === hand).length,
      variations,
      labels: mine.map((b) => b.label).join(' '),
    });
  }
  return out;
}

/** Labels of one hand's fragments that overlap [start, end) (quarters): "A A′". */
export function handLabels(blocks: Block[], hand: Hand, start: number, end: number): string {
  return blocks
    .filter((x) => x.hand === hand && x.end > start + EPS && x.start < end - EPS)
    .map((x) => x.label)
    .join(' ');
}

/** "правая A A′ + левая a a′" for [start, end) in quarters */
export function togetherLabels(blocks: Block[], a: number, b: number): string {
  const parts: string[] = [];
  for (const hand of ['R', 'L'] as Hand[]) {
    const l = handLabels(blocks, hand, a, b);
    if (l) parts.push(`${HAND_SHORT[hand]} ${l}`);
  }
  return parts.join(' + ');
}

export function stepTitle(score: Score, blocks: Block[], families: PatternFamily[], step: GuideStep): { title: string; subtitle: string } {
  if (step.kind === 'pattern' || step.kind === 'variation') {
    const b = blocks[step.block];
    const last = b.sequenceEnd !== undefined ? blocks[b.sequenceEnd] : b;
    const where = stretchText(score, { ...b, endMeasure: last.endMeasure });
    if (step.kind === 'pattern') {
      const times = families[b.family].blocks.length;
      return {
        title: `Паттерн ${b.label}`,
        subtitle: `${HAND_NAME[b.hand]} · ${where}${b.sequenceEnd !== undefined ? ' (с секвенцией)' : ''}${times > 1 ? ` · встречается ${times} ${plural(times, 'раз', 'раза', 'раз')}` : ''}`,
      };
    }
    return { title: `Вариация ${b.label}`, subtitle: `${HAND_NAME[b.hand]} · ${where} · отличия от ${families[b.family].letter} выделены` };
  }
  const where = stretchText(score, step);
  const labels = togetherLabels(blocks, step.start, step.end);
  if (step.kind === 'together') return { title: `Двумя руками: ${where}`, subtitle: labels };
  return {
    title: step.whole ? 'Вся пьеса целиком' : `Соединяем: ${where}`,
    subtitle: step.whole ? `${where} · обе руки` : labels,
  };
}
