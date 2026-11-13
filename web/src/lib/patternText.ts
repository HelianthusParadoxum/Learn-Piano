/** Human-readable descriptions of the pattern structure (Russian). */
import { EPS, type Block, type GuideStep, type Hand, type NoteEvent, type PatternFamily, type Score } from './model';
import { intervalName, stepName } from './noteNames';

const HAND_RU: Record<Hand, string> = { R: 'правая рука', L: 'левая рука' };
const STEP_NAMES = ['', 'секунду', 'терцию', 'кварту', 'квинту', 'сексту', 'септиму', 'октаву'];

export function measuresText(score: Score, a: number, b: number): string {
  const ma = score.measures[a]?.number ?? String(a + 1);
  const mb = score.measures[b]?.number ?? String(b + 1);
  return a === b ? `такт ${ma}` : `такты ${ma}–${mb}`;
}

export function blockMeasures(score: Score, b: Block): string {
  return measuresText(score, b.startMeasure, b.endMeasure);
}

/** "сдвинут на большую секунду вниз" / "на терцию выше по ступеням гаммы" */
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

const pct = (x: number) => `${Math.round(x * 100)}%`;

function twoHanded(score: Score): boolean {
  return score.notes.some((n) => n.hand === 'R') && score.notes.some((n) => n.hand === 'L');
}

/** "79%" or, in a two-hand piece, "79% (правая рука — 100%, левая — 55%)". */
export function similarityText(score: Score, b: Block): string {
  const hands = b.diff?.hands;
  if (!hands || !twoHanded(score)) return pct(b.similarity);
  return `${pct(b.similarity)} (правая рука — ${pct(hands.R)}, левая — ${pct(hands.L)})`;
}

/** The hand that repeats the base (almost) exactly while the other one changes, if any. */
function steadyHand(score: Score, b: Block): Hand | null {
  const hands = b.diff?.hands;
  if (!hands || !twoHanded(score)) return null;
  for (const h of ['R', 'L'] as Hand[]) {
    const other: Hand = h === 'R' ? 'L' : 'R';
    if (hands[h] >= 0.95 && hands[other] < 0.95) return h;
  }
  return null;
}

/** "Правая рука повторяет A точно — меняется только левая." */
export function steadyHandText(score: Score, families: PatternFamily[], b: Block): string {
  const h = steadyHand(score, b);
  if (!h) return '';
  const letter = families[b.family].letter;
  const exact = b.diff!.hands[h] >= 0.999;
  const other = h === 'R' ? 'левая' : 'правая';
  return `${h === 'R' ? 'Правая' : 'Левая'} рука повторяет ${letter} ${exact ? 'точно' : 'почти точно'} — меняется ${exact ? 'только' : 'в основном'} ${other}.`;
}

/** Why a fragment below the similarity threshold still counts as a variation (the "one hand repeats" rule). */
export function belowThresholdText(score: Score, families: PatternFamily[], b: Block, threshold: number): string {
  if (b.similarity >= threshold - 1e-9) return '';
  const h = steadyHand(score, b);
  if (!h) return '';
  const letter = families[b.family].letter;
  return `В целом это меньше порога ${pct(threshold)}, но ${h === 'R' ? 'правая' : 'левая'} рука повторяет ${letter}, поэтому фрагмент разучивается как вариация ${letter}, а не как новый паттерн.`;
}

function notesIn(score: Score, measure: number, hand: Hand): NoteEvent[] {
  return score.notes
    .filter((n) => n.hand === hand && !n.grace && n.measureIndex === measure)
    .sort((a, b) => a.onset - b.onset || a.midi - b.midi);
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

/** Differences of a variation from its base, measure by measure and hand by hand. */
export function diffLines(score: Score, blocks: Block[], families: PatternFamily[], b: Block): string[] {
  if (!b.diff) return [];
  const base = blocks[families[b.family].base];
  const letter = families[b.family].letter;
  const lines: string[] = [];
  const shift = transpositionText(b);
  if (shift) lines.push(`По сравнению с ${letter} ${shift}.`);
  const bStart = b.coreStart ?? b.startMeasure;
  const baseStart = base.coreStart ?? base.startMeasure;
  const changed = new Set(b.diff.changed);
  const rhythm = new Set(b.diff.rhythm);
  const baseLost = new Set(b.diff.baseUnmatched);
  for (const m of b.diff.measures) {
    if (!m.changed && !m.missing && !m.rhythm) continue;
    const vm = bStart + m.offset;
    const bm = baseStart + m.offset;
    const where = `Такт ${score.measures[vm]?.number ?? vm + 1}`;
    const span = b.endMeasure - bStart + 1;
    const pos = span > 1 ? ` (${m.offset + 1}-й такт паттерна)` : '';
    for (const hand of ['R', 'L'] as Hand[]) {
      const here = notesIn(score, vm, hand);
      const there = notesIn(score, bm, hand);
      const handChanged = here.some((n) => changed.has(n.id)) || there.some((n) => baseLost.has(n.id));
      const handRhythm = here.some((n) => rhythm.has(n.id));
      if (!handChanged && !handRhythm) continue;
      if (!handChanged) {
        lines.push(`${where}${pos}, ${HAND_RU[hand]}: те же ноты, но другой ритм (длительности).`);
        continue;
      }
      if (!here.length) {
        lines.push(`${where}${pos}, ${HAND_RU[hand]}: здесь пауза (в ${letter} — ${listNotes(there, false)}).`);
        continue;
      }
      if (!there.length) {
        lines.push(`${where}${pos}, ${HAND_RU[hand]}: добавились ноты ${listNotes(here, false)} (в ${letter} рука молчала).`);
        continue;
      }
      let a = listNotes(there, false);
      let c = listNotes(here, false);
      if (a === c) {
        a = listNotes(there, true);
        c = listNotes(here, true);
      }
      lines.push(`${where}${pos}, ${HAND_RU[hand]}: в ${letter} — ${a}; здесь — ${c}.`);
    }
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
      return { block: b, text: `${b.label}: ${where} — точный повтор${of.role === 'variation' ? ` вариации ${of.label}` : ''}` };
    }
    const n = changedMeasureCount(b);
    return {
      block: b,
      text: `${b.label}: ${where} — вариация, совпадает на ${similarityText(score, b)}${n ? `, отличия в ${n} ${n === 1 ? 'такте' : 'тактах'}` : ''}${b.transpose || b.steps ? ', транспонирована' : ''}`,
    };
  });
}

/** How much of the piece is new material once the patterns are learned. */
export function structureSummary(score: Score, blocks: Block[], families: PatternFamily[]) {
  const total = score.measures.length;
  let learn = 0;
  let variations = 0;
  for (const b of blocks) {
    if (b.role === 'base') learn += b.endMeasure - b.startMeasure + 1;
    else if (b.role === 'variation') {
      variations++;
      learn += b.transpose || b.steps ? b.endMeasure - b.startMeasure + 1 : changedMeasureCount(b);
    }
  }
  const repeated = families.filter((f) => f.blocks.length > 1).length;
  return { total, learn: Math.min(total, learn), patterns: families.length, repeated, variations };
}

export function stepTitle(score: Score, blocks: Block[], families: PatternFamily[], step: GuideStep): { title: string; subtitle: string } {
  if (step.kind === 'pattern') {
    const b = blocks[step.block];
    const f = families[b.family];
    const times = f.blocks.length;
    return {
      title: `Паттерн ${b.label}`,
      subtitle: `${blockMeasures(score, b)}${times > 1 ? ` · встречается ${times} ${times < 5 ? 'раза' : 'раз'}` : ''}`,
    };
  }
  if (step.kind === 'variation') {
    const b = blocks[step.block];
    return { title: `Вариация ${b.label}`, subtitle: `${blockMeasures(score, b)} · отличия от ${families[b.family].letter} выделены` };
  }
  const from = blocks[step.fromBlock];
  const to = blocks[step.toBlock];
  const labels = blocks.slice(step.fromBlock, step.toBlock + 1).map((b) => b.label).join(' ');
  return {
    title: step.whole ? 'Вся пьеса целиком' : `Соединяем: ${labels}`,
    subtitle: `${measuresText(score, from.startMeasure, to.endMeasure)}${step.whole ? ` · ${labels}` : ''}`,
  };
}
