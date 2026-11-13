/** Builds human-readable learning hints for a block. */
import { isBlackKey, keyPosition } from './fingering';
import { EPS, type Hand, type NoteEvent, type Score } from './model';
import {
  FINGER_NAMES,
  fullNoteName,
  intervalName,
  keyName,
  keySignatureAccidentals,
  midiSpelling,
  stepName,
} from './noteNames';
import { quarterToSeconds } from './timing';

export interface Tip {
  kind: 'position' | 'crossing' | 'jump' | 'accidental' | 'rhythm' | 'chord' | 'repeat' | 'key' | 'hands' | 'tie';
  text: string;
}

export interface HandPosition {
  hand: Hand;
  thumbMidi: number;
  text: string;
}

export interface BlockAnalysis {
  noteCount: Record<Hand, number>;
  handPositions: HandPosition[];
  tips: Tip[];
  plan: string[];
  difficulty: number;
  difficultyLabel: string;
  lowest: number;
  highest: number;
  crossings: number;
  jumps: number;
}

const HAND_RU: Record<Hand, string> = { R: 'Правая рука', L: 'Левая рука' };
const HAND_RU_GEN: Record<Hand, string> = { R: 'правой руки', L: 'левой руки' };

function measureLabel(score: Score, idx: number): string {
  return `такт ${score.measures[idx]?.number ?? idx + 1}`;
}

/** White key under the thumb for a note played with finger f. */
function thumbKey(midi: number, finger: number, hand: Hand): number {
  const pos = Math.round(hand === 'R' ? keyPosition(midi) - (finger - 1) : keyPosition(midi) + (finger - 1));
  const octave = Math.floor(pos / 7);
  const idx = ((pos % 7) + 7) % 7;
  return octave * 12 + [0, 2, 4, 5, 7, 9, 11][idx];
}

interface Ev {
  onset: number;
  notes: NoteEvent[];
}

function eventsOf(notes: NoteEvent[]): Ev[] {
  const out: Ev[] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.onset - n.onset) < EPS * 10) last.notes.push(n);
    else out.push({ onset: n.onset, notes: [n] });
  }
  return out;
}

/** A stretch of the piece analysed for a guide step: [start, end) in quarters, in measures startMeasure…endMeasure. */
export interface Span {
  startMeasure: number;
  endMeasure: number;
  start: number;
  end: number;
  /** first full measure (startMeasure holds only an upbeat if they differ) */
  coreStart?: number;
}

export type StepKind = 'pattern' | 'variation' | 'together' | 'assemble';

const HAND_INSTR: Record<Hand, string> = { R: 'правой рукой', L: 'левой рукой' };

/**
 * Hints for a guide step. `hand` limits the analysis to one hand (pattern and variation steps are
 * learned with one hand; together and assemble steps with both).
 */
export function analyzeSpan(score: Score, block: Span, kind: StepKind = 'pattern', isFirst = false, hand?: Hand): BlockAnalysis {
  const inBlock = score.notes.filter(
    (n) => n.hand && (!hand || n.hand === hand) && n.onset >= block.start - EPS && n.onset < block.end - EPS,
  );
  const byHand: Record<Hand, NoteEvent[]> = {
    R: inBlock.filter((n) => n.hand === 'R'),
    L: inBlock.filter((n) => n.hand === 'L'),
  };
  const tips: Tip[] = [];
  const handPositions: HandPosition[] = [];
  let crossings = 0;
  let jumps = 0;
  let maxChord = 1;

  for (const hand of ['R', 'L'] as Hand[]) {
    const notes = byHand[hand];
    if (!notes.length) continue;
    const evs = eventsOf(notes);
    maxChord = Math.max(maxChord, ...evs.map((e) => e.notes.length));

    // starting position
    const first = evs[0].notes;
    const ref = first.find((n) => n.finger === 1) ?? first[0];
    if (ref.finger) {
      const thumb = thumbKey(ref.midi, ref.finger, hand);
      const thumbSp = midiSpelling(thumb);
      const startNote = hand === 'R' ? first[first.length - 1] : first[0];
      handPositions.push({
        hand,
        thumbMidi: thumb,
        text:
          `${HAND_RU[hand]}: начинает с ноты ${fullNoteName(startNote)} ${startNote.finger}-м пальцем` +
          (ref.finger === 1 && ref === startNote ? '.' : `; большой палец — над нотой ${fullNoteName(thumbSp)}.`),
      });
    }

    // crossings, jumps and shifts between consecutive single notes
    const reported = new Set<string>();
    for (let i = 1; i < evs.length; i++) {
      const a = evs[i - 1].notes;
      const b = evs[i].notes;
      if (a.length !== 1 || b.length !== 1) continue;
      const na = a[0];
      const nb = b[0];
      if (!na.finger || !nb.finger) continue;
      const up = nb.midi > na.midi;
      const where = measureLabel(score, nb.measureIndex);
      const thumbUnder = (hand === 'R' ? up : !up) && na.finger > 1 && nb.finger === 1;
      const fingerOver = (hand === 'R' ? !up : up) && na.finger === 1 && nb.finger > 1 && nb.midi !== na.midi;
      if (thumbUnder) {
        crossings++;
        const k = `tu${na.finger}${where}`;
        if (!reported.has(k)) {
          reported.add(k);
          tips.push({
            kind: 'crossing',
            text: `${HAND_RU[hand]}, ${where}: подкладывание большого пальца под ${na.finger}-й на ноте ${stepName(nb.step, nb.alter, 'solfege')}. Рука плавно смещается ${up ? 'вправо' : 'влево'}, локоть свободен.`,
          });
        }
      } else if (fingerOver) {
        crossings++;
        const k = `fo${nb.finger}${where}`;
        if (!reported.has(k)) {
          reported.add(k);
          tips.push({
            kind: 'crossing',
            text: `${HAND_RU[hand]}, ${where}: перекладывание ${nb.finger}-го пальца через большой на ноту ${stepName(nb.step, nb.alter, 'solfege')}.`,
          });
        }
      } else {
        const interval = Math.abs(nb.midi - na.midi);
        const sameFinger = na.finger === nb.finger && interval > 0;
        const k = `j${where}`;
        if (interval >= 8) {
          jumps++;
          if (!reported.has(k)) {
            reported.add(k);
            tips.push({
              kind: 'jump',
              text: `${HAND_RU[hand]}, ${where}: смена позиции — скачок на ${intervalName(interval, true)} ${up ? 'вверх' : 'вниз'} (с ${na.finger}-го на ${nb.finger}-й палец). Найдите глазами новую клавишу заранее.`,
            });
          }
        } else if (sameFinger) {
          jumps++;
          if (!reported.has(k)) {
            reported.add(k);
            tips.push({
              kind: 'jump',
              text: `${HAND_RU[hand]}, ${where}: смещение руки — ${na.finger}-й палец переходит с ноты ${stepName(na.step, na.alter, 'solfege')} на ${stepName(nb.step, nb.alter, 'solfege')}; вся кисть сдвигается ${up ? 'вправо' : 'влево'}.`,
            });
          }
        }
      }
    }
    if (evs.some((e) => e.notes.length >= 3)) {
      tips.push({
        kind: 'chord',
        text: `Аккорды у ${HAND_RU_GEN[hand]}: ставьте все пальцы на клавиши заранее и нажимайте одновременно, одним движением руки.`,
      });
    } else if (evs.filter((e) => e.notes.length === 2).length >= 2) {
      tips.push({
        kind: 'chord',
        text: `${HAND_RU[hand]} играет двойные ноты (интервалы) — следите, чтобы обе клавиши звучали ровно вместе.`,
      });
    }
  }

  // fingers placed on another key than last time (marked with arrows in the notes)
  const moved = inBlock.filter((n) => n.fingerMove).length;
  if (moved) {
    tips.push({
      kind: 'position',
      text: `Стрелка перед номером пальца (→3, ←3) — палец встаёт на другую клавишу, чем в прошлый раз (правее или левее): здесь таких мест ${moved}. Посмотрите на них заранее — там рука смещается или палец переставляется.`,
    });
  }

  // key signature and accidentals
  const fifths = score.measures[block.startMeasure]?.fifths ?? 0;
  const keyAcc = keySignatureAccidentals(fifths);
  if (keyAcc.length && (isFirst || score.measures[block.startMeasure].keyChange)) {
    const names = keyAcc.map((a) => stepName(a.step, a.alter, 'solfege')).join(', ');
    tips.push({
      kind: 'key',
      text: `Тональность ${keyName(fifths)}: в ключе ${names} — эти ноты всегда играются на чёрных клавишах, если нет отказа (♮).`,
    });
  } else if (keyAcc.length) {
    const usedKeyNotes = keyAcc.filter((a) => inBlock.some((n) => n.step === a.step && n.alter === a.alter));
    if (usedKeyNotes.length) {
      tips.push({
        kind: 'key',
        text: `Не забывайте ключевые знаки: ${usedKeyNotes.map((a) => stepName(a.step, a.alter, 'solfege')).join(', ')}.`,
      });
    }
  }
  const accidentals = new Map<string, string>();
  for (const n of inBlock) {
    if (!n.accidental) continue;
    const name = stepName(n.step, n.alter, 'solfege') + (n.alter === 0 ? ' (♮ бекар)' : '');
    if (!accidentals.has(name)) accidentals.set(name, measureLabel(score, n.measureIndex));
  }
  if (accidentals.size) {
    tips.push({
      kind: 'accidental',
      text:
        'Случайные знаки: ' +
        Array.from(accidentals.entries())
          .map(([name, where]) => `${name} — ${where}`)
          .join('; ') +
        '. Знак действует до конца такта.',
    });
  }

  // rhythm
  if (inBlock.some((n) => n.dotted && n.duration <= 1.5 + EPS)) {
    tips.push({ kind: 'rhythm', text: 'Пунктирный ритм: нота с точкой длиннее на половину — посчитайте вслух, прежде чем играть.' });
  }
  if (inBlock.some((n) => n.tuplet)) {
    tips.push({ kind: 'rhythm', text: 'Триоли: три ноты ровно на место двух — проговаривайте «три-о-ли».' });
  }
  if (inBlock.some((n) => n.tieContinuations.length > 0)) {
    tips.push({ kind: 'tie', text: 'Залигованные ноты: нажмите клавишу один раз и держите её на всю суммарную длительность.' });
  }
  const bothHands = byHand.R.length > 0 && byHand.L.length > 0;
  if (bothHands && kind === 'together') {
    tips.push({
      kind: 'hands',
      text: 'Каждую руку вы уже разучили отдельно. Соединяйте медленно — ровность важнее скорости.',
    });
  }

  // difficulty
  const dur = Math.max(0.5, quarterToSeconds(score.tempoMap, block.end) - quarterToSeconds(score.tempoMap, block.start));
  const onsets = new Set(inBlock.map((n) => `${n.hand}${n.onset.toFixed(3)}`)).size;
  const nps = onsets / dur;
  const blackCount = inBlock.filter((n) => isBlackKey(n.midi)).length;
  let score01 =
    Math.min(3, nps / 2.5) * 0.8 +
    Math.min(2, crossings * 0.3) +
    Math.min(1.5, jumps * 0.3) +
    Math.min(1, accidentals.size * 0.3 + blackCount * 0.03) +
    (maxChord >= 3 ? 0.6 : maxChord === 2 ? 0.3 : 0) +
    (bothHands ? 0.5 : 0);
  const difficulty = Math.max(1, Math.min(5, Math.round(score01 / 1.4 + 0.4)));
  const labels = ['', 'очень легко', 'легко', 'средне', 'сложно', 'очень сложно'];

  const plan: string[] = [];
  const by = hand ? HAND_INSTR[hand] : '';
  if (kind === 'variation') {
    plan.push('Нажмите «Сравнить»: сначала прозвучит основа паттерна, затем эта вариация. Услышьте разницу.');
    plan.push('Найдите выделенные ноты — только они отличаются от уже выученной основы.');
    plan.push(`Сыграйте ${by ? by + ' ' : ''}такты с отличиями, медленно, 3 раза подряд без ошибок.`);
    plan.push('Сыграйте вариацию целиком, сначала медленно, затем в темпе 80–100%.');
  } else if (kind === 'together') {
    plan.push('Послушайте фрагмент двумя руками и проследите глазами за обеими строчками нот.');
    plan.push('Вспомните каждую руку отдельно — эти паттерны вы уже разучили.');
    plan.push('Соедините руки очень медленно (40–50%). Если сбиваетесь, сыграйте этот такт каждой рукой и снова вместе.');
    plan.push('Постепенно повышайте темп до 80–100%. Цель — 3 раза подряд без ошибок.');
  } else if (kind === 'assemble') {
    plan.push('Послушайте фрагмент целиком и проследите, как части следуют друг за другом.');
    plan.push('Сыграйте медленно без остановок — особенно внимательно на стыках.');
    if (bothHands) plan.push('Если стык не получается — сыграйте его каждой рукой отдельно, затем снова вместе.');
    plan.push('Постепенно повышайте темп до 80–100%. Цель — 3 раза подряд без ошибок.');
  } else {
    plan.push('Послушайте паттерн и проследите глазами за нотами и клавишами.');
    if (by) plan.push(`Сыграйте ${by} медленно (50–60%), пока не получится 3 раза подряд без ошибок.`);
    else {
      if (byHand.R.length) plan.push('Правая рука отдельно в медленном темпе (50–60%), пока не получится 3 раза подряд без ошибок.');
      if (byHand.L.length) plan.push('Левая рука отдельно — так же медленно, следите за аппликатурой.');
      if (bothHands) plan.push('Обе руки вместе, очень медленно. Лучше медленно и ровно, чем быстро с остановками.');
    }
    plan.push('Постепенно повышайте темп до 80–100%.');
  }

  const all = inBlock.map((n) => n.midi);
  return {
    noteCount: { R: byHand.R.length, L: byHand.L.length },
    handPositions,
    tips,
    plan,
    difficulty,
    difficultyLabel: labels[difficulty],
    lowest: all.length ? Math.min(...all) : 60,
    highest: all.length ? Math.max(...all) : 72,
    crossings,
    jumps,
  };
}

export { FINGER_NAMES };
