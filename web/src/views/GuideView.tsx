import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FingerPicker } from '../components/FingerPicker';
import { Keyboard, keyCenter, rangeFor, whiteKeyCount, type KeyMark } from '../components/Keyboard';
import { PianoRoll } from '../components/PianoRoll';
import { familyColor, ScoreView } from '../components/ScoreView';
import { StructureMap } from '../components/StructureMap';
import { handsFor, Transport, type HandSelection } from '../components/Transport';
import { player } from '../lib/audio';
import { routeHash, usePersistentState, usePlayerState } from '../lib/hooks';
import { EPS, type Block, type GuideStep, type Hand, type NoteEvent, type PieceSettings } from '../lib/model';
import {
  blockMeasures,
  changedMeasureCount,
  diffLines,
  diffNoteCount,
  HAND_LOWER,
  HAND_NAME,
  HAND_SHORT,
  occurrences,
  plural,
  shiftText,
  shortMeasures,
  stepTitle,
  togetherLabels,
  transpositionText,
} from '../lib/patternText';
import { stepOfBlock } from '../lib/patterns';
import { blocksOfStep, stepHand, stepLastBlock, stepSpan, type Guide } from '../lib/piece';
import { quarterToSeconds } from '../lib/timing';

interface Props {
  pieceId: string;
  guide: Guide;
  /** 1-based step number */
  step: number;
  learnedSteps: ReadonlySet<number>;
  settings: PieceSettings;
  overrides: Record<string, number>;
  onStep: (step: number) => void;
  onToggleLearned: (stepIndex: number) => void;
  onOverride: (key: string, finger: number | null) => void;
}

const HANDS: Hand[] = ['R', 'L'];

export function GuideView(props: Props) {
  const { guide, step, learnedSteps, onStep } = props;
  const { steps, blocks, families, score, analyses, parts } = guide;
  const current = steps[step - 1];
  const highlight = useMemo(() => (current ? blocksOfStep(blocks, current) : new Set<number>()), [blocks, current]);
  if (!current) return <div className="page-msg">В пьесе нет нот для гайда.</div>;
  const multiPart = parts.length > 1;

  const item = (st: GuideStep, i: number) => {
    const active = i === step - 1;
    const learned = learnedSteps.has(i);
    const a = analyses[i];
    let badge: React.ReactNode;
    let title: string;
    let sub: string;
    let color = '#64748b';
    let badgeClass = '';
    if (st.kind === 'together' || st.kind === 'assemble') {
      const where = shortMeasures(score, st.startMeasure, st.endMeasure);
      if (st.kind === 'together') {
        badge = 'П+Л';
        badgeClass = 'both';
        title = 'Двумя руками';
        sub = `${where} · ${togetherLabels(blocks, st.startMeasure, st.endMeasure)}`;
      } else {
        badge = st.whole ? '★' : '⧉';
        title = st.whole ? 'Вся пьеса' : 'Соединяем';
        sub = where;
      }
    } else {
      const b = blocks[st.block];
      const last = stepLastBlock(blocks, st)!;
      color = familyColor(b.family);
      badge = b.label;
      badgeClass = `hand-${b.hand} ${st.kind === 'variation' ? 'variant' : ''}`;
      const where = shortMeasures(score, b.startMeasure, last.endMeasure);
      const who = multiPart ? `${HAND_SHORT[b.hand]} · ` : '';
      if (st.kind === 'pattern') {
        const times = families[b.family].blocks.length;
        title = `Паттерн ${b.label}`;
        sub = `${who}${where}${times > 1 ? ` · ×${times}` : ''}${b.sequenceEnd !== undefined ? ' · секвенция' : ''} · ${a.difficultyLabel}`;
      } else {
        title = `Вариация ${b.label}`;
        sub = `${who}${where} · ${b.transpose || b.steps ? 'сдвинута' : `отличий: ${diffNoteCount(b)}`}`;
      }
    }
    return (
      <button
        key={i}
        className={`block-item kind-${st.kind} ${active ? 'active' : ''} ${learned ? 'learned' : ''}`}
        onClick={() => onStep(i + 1)}
      >
        <span className={`block-num ${badgeClass}`} style={{ ['--block-color' as string]: color }}>
          {learned ? '✓' : badge}
        </span>
        <span className="block-item-text">
          <span className="block-item-title">{title}</span>
          <span className="block-item-sub">{sub}</span>
        </span>
      </button>
    );
  };

  type Group = { key: string; title: string; hand?: Hand; items: number[] };
  const groups: Group[] = [];
  if (!multiPart) {
    for (const hand of HANDS) {
      const items = steps.flatMap((st, i) => ((st.kind === 'pattern' || st.kind === 'variation') && blocks[st.block].hand === hand ? [i] : []));
      if (items.length) groups.push({ key: hand, title: HAND_NAME[hand], hand, items });
    }
    const rest = steps.flatMap((st, i) => (st.kind === 'together' || st.kind === 'assemble' ? [i] : []));
    const twoHands = steps.some((st) => st.kind === 'together');
    if (rest.length) groups.push({ key: 'both', title: twoHands ? 'Двумя руками' : 'Сборка', items: rest });
  } else {
    parts.forEach(([a, b], p) => {
      const items = steps.flatMap((st, i) => (st.part === p && !(st.kind === 'assemble' && st.whole) ? [i] : []));
      if (items.length) groups.push({ key: `p${p}`, title: `Часть ${p + 1} · ${shortMeasures(score, a, b)}`, items });
    });
    const whole = steps.flatMap((st, i) => (st.kind === 'assemble' && st.whole ? [i] : []));
    if (whole.length) groups.push({ key: 'whole', title: 'Вся пьеса', items: whole });
  }

  return (
    <div className="guide-wrap">
      <StructureMap
        score={score}
        blocks={blocks}
        families={families}
        highlight={highlight}
        onBlock={(b) => onStep(stepOfBlock(steps, blocks, b) + 1)}
        showSummary
      />
      <div className="guide">
        <aside className="block-list" aria-label="Шаги гайда">
          {groups.map((g) => (
            <div key={g.key} className="block-group">
              <div className={`block-list-title ${g.hand ? `t-${g.hand}` : ''}`}>{g.title}</div>
              {g.items.map((i) => item(steps[i], i))}
            </div>
          ))}
        </aside>
        <StepView key={step} {...props} stepIndex={step - 1} />
      </div>
    </div>
  );
}

function fmtTime(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function notesBetween(notes: NoteEvent[], from: number, to: number) {
  return notes.filter((n) => n.hand && n.onset >= from - EPS && n.onset < to - EPS);
}

/** The stretch played just before a step ("with the previous fragment"): same hand, or the previous chunk. */
function previousSpan(guide: Guide, step: GuideStep): { start: number; startMeasure: number; label: string } | null {
  const { blocks, chunks, score } = guide;
  if (step.kind === 'pattern' || step.kind === 'variation') {
    const b = blocks[step.block];
    const prev = blocks[b.index - 1];
    if (!prev || prev.hand !== b.hand || prev.endMeasure + 1 !== b.startMeasure) return null;
    return { start: prev.start, startMeasure: prev.startMeasure, label: b.label };
  }
  if (step.kind === 'together') {
    const k = chunks.findIndex((c) => c.startMeasure === step.startMeasure);
    const prev = chunks[k - 1];
    if (k <= 0 || !prev) return null;
    return { start: score.measures[prev.startMeasure].start, startMeasure: prev.startMeasure, label: `такта ${score.measures[step.startMeasure].number}` };
  }
  return null;
}

function StepView(props: Props & { stepIndex: number }) {
  const { pieceId, guide, stepIndex, learnedSteps, settings, onStep, onToggleLearned, onOverride, overrides } = props;
  const { score, blocks, families, steps, analyses, renderXml } = guide;
  const step = steps[stepIndex];
  const analysis = analyses[stepIndex];
  const span = stepSpan(score, blocks, step);
  const hand = stepHand(blocks, step);
  const block: Block | null = step.kind === 'pattern' || step.kind === 'variation' ? blocks[step.block] : null;
  const isVariation = step.kind === 'variation' && !!block;
  const base: Block | null = isVariation && block ? blocks[families[block.family].base] : null;
  const { title, subtitle } = stepTitle(score, blocks, families, step);
  const ps = usePlayerState();

  const spanNotes = useMemo(() => notesBetween(score.notes, span.start, span.end), [score, span.start, span.end]);
  const hasR = spanNotes.some((n) => n.hand === 'R');
  const hasL = spanNotes.some((n) => n.hand === 'L');

  const [handSelPref, setHandSel] = usePersistentState<HandSelection>('handSel', 'both');
  const [otherQuiet, setOtherQuiet] = usePersistentState('otherQuiet', false);
  const [tempoPct, setTempoPct] = usePersistentState('tempoPct', 70);
  const [loop, setLoop] = usePersistentState('loop', true);
  const [metronome, setMetronome] = usePersistentState('metronome', false);
  const [countIn, setCountIn] = usePersistentState('countIn', false);
  const [dimSame, setDimSame] = usePersistentState('dimSame', true);
  const [withPrev, setWithPrev] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ noteId: number; rect: DOMRect } | null>(null);
  const [planDone, setPlanDone] = useState<Set<number>>(new Set());

  // a step for one hand plays that hand; two-hand steps follow the player's choice
  const handSel: HandSelection = hand
    ? hand
    : handSelPref === 'both'
      ? hasR && hasL
        ? 'both'
        : hasR
          ? 'R'
          : 'L'
      : handSelPref === 'R'
        ? hasR
          ? 'R'
          : 'L'
        : hasL
          ? 'L'
          : 'R';
  const hands = handsFor(handSel, otherQuiet);
  const prev = useMemo(() => previousSpan(guide, step), [guide, step]);
  const from = withPrev && prev ? prev.start : span.start;
  const to = span.end;
  const firstMeasure = withPrev && prev ? prev.startMeasure : span.startMeasure;

  const isMine = ps.from === from && ps.to === to;
  const playing = ps.playing && isMine;
  const pos = playing ? ps.position ?? from : cursor ?? from;

  const rangeNotes = useMemo(() => notesBetween(score.notes, from, to), [score, from, to]);
  // in "compare" playback the base pattern sounds first
  const baseNotes = useMemo(() => (base ? notesBetween(score.notes, base.start, base.end) : []), [score, base]);

  const diffIds = useMemo(() => new Set(isVariation ? block!.diff?.changed ?? [] : []), [isVariation, block]);
  const rhythmIds = useMemo(() => new Set(isVariation ? block!.diff?.rhythm ?? [] : []), [isVariation, block]);
  const markIds = useMemo(() => new Set(isVariation ? block!.diff?.baseUnmatched ?? [] : []), [isVariation, block]);
  const dimIds = useMemo(
    () =>
      isVariation && dimSame
        ? new Set(
            rangeNotes
              .filter((n) => n.hand === hand && n.onset >= block!.start - EPS && !diffIds.has(n.id) && !rhythmIds.has(n.id))
              .map((n) => n.id),
          )
        : undefined,
    [isVariation, dimSame, rangeNotes, block, hand, diffIds, rhythmIds],
  );

  const onsets = useMemo(() => {
    const set = new Set<number>();
    for (const n of rangeNotes) if (hands[n.hand!] === 'on') set.add(Math.round(n.onset * 1e6) / 1e6);
    return Array.from(set).sort((a, b) => a - b);
  }, [rangeNotes, hands.R, hands.L]); // eslint-disable-line react-hooks/exhaustive-deps

  const active: NoteEvent[] = useMemo(() => {
    const pool = playing && baseNotes.length ? [...rangeNotes, ...baseNotes] : rangeNotes;
    const visible = pool.filter((n) => hands[n.hand!] !== 'off');
    if (playing || cursor !== null) {
      return visible.filter((n) => n.onset <= pos + 1e-6 && pos < n.onset + n.duration - 1e-6);
    }
    // idle: show where each hand starts
    const out: NoteEvent[] = [];
    for (const h of HANDS) {
      const hn = visible.filter((n) => n.hand === h);
      if (!hn.length) continue;
      const first = Math.min(...hn.map((n) => n.onset));
      out.push(...hn.filter((n) => Math.abs(n.onset - first) < EPS * 10));
    }
    return out;
  }, [rangeNotes, baseNotes, playing, cursor, pos, hands.R, hands.L]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeIds = useMemo(() => new Set(active.map((n) => n.id)), [active]);
  const activeKeys = useMemo(() => {
    const m = new Map<number, KeyMark>();
    for (const n of active) m.set(n.midi, { hand: n.hand, finger: n.finger, diff: diffIds.has(n.id) });
    return m;
  }, [active, diffIds]);
  const marks = useMemo(() => {
    const m = new Map<number, KeyMark>();
    for (const n of rangeNotes) if (hands[n.hand!] !== 'off' && !m.has(n.midi)) m.set(n.midi, { hand: n.hand });
    return m;
  }, [rangeNotes, hands.R, hands.L]); // eslint-disable-line react-hooks/exhaustive-deps
  const kbRange = useMemo(
    () => rangeFor([...rangeNotes, ...baseNotes].filter((n) => hands[n.hand!] !== 'off').map((n) => n.midi)),
    [rangeNotes, baseNotes, hands.R, hands.L], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // on narrow screens the keyboard scrolls horizontally: keep the pressed keys in view
  const kbScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = kbScrollRef.current;
    if (!box || box.scrollWidth <= box.clientWidth + 2 || !active.length) return;
    const count = whiteKeyCount(kbRange);
    const xs = active.map((n) => (keyCenter(kbRange, n.midi) / count) * box.scrollWidth);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (lo < box.scrollLeft + 20 || hi > box.scrollLeft + box.clientWidth - 20) {
      box.scrollTo({ left: Math.max(0, (lo + hi) / 2 - box.clientWidth / 2), behavior: 'smooth' });
    }
  }, [active, kbRange]);

  const startPlayback = useCallback(
    (startAt?: number, restart = false) => {
      void player.play(score, {
        from,
        to,
        startAt: startAt ?? (cursor !== null && cursor < to - EPS ? cursor : from),
        hands,
        tempoFactor: tempoPct / 100,
        loop,
        metronome,
        countIn: countIn && !restart,
      });
    },
    [score, from, to, cursor, hands.R, hands.L, tempoPct, loop, metronome, countIn], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const startCompare = useCallback(() => {
    if (!base || !block) return;
    setCursor(null);
    void player.play(score, {
      from,
      to,
      sequence: [
        { from: base.start, to: base.end },
        { from: block.start, to: block.end },
      ],
      hands,
      tempoFactor: tempoPct / 100,
      loop: false,
      metronome,
      countIn,
    });
  }, [score, base, block, from, to, hands.R, hands.L, tempoPct, metronome, countIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopPlayback = useCallback(() => {
    const st = player.getState();
    player.stop();
    if (st.position !== null && st.from === from && st.to === to && st.position >= from && st.position < to) setCursor(st.position);
  }, [from, to]);

  // stop when leaving this step
  useEffect(() => () => player.stop(), []);

  // natural end of playback → back to the start
  useEffect(() => {
    if (!ps.playing && isMine && ps.position === null) setCursor(null);
  }, [ps.playing, ps.position, isMine]);

  // apply changed options immediately while playing (not during the "compare" sequence)
  useEffect(() => {
    const st = player.getState();
    if (st.playing && isMine && st.position !== null && st.position >= from && st.position < to) startPlayback(st.position, true);
  }, [tempoPct, hands.R, hands.L, metronome, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepTo = useCallback(
    (dir: 1 | -1) => {
      const st = player.getState();
      // while playing, step from the note that is sounding now
      const current =
        st.playing && st.from === from && st.to === to && st.position !== null && st.position >= from && st.position < to
          ? st.position
          : cursor;
      if (st.playing) player.stop();
      if (!onsets.length) return;
      let next: number;
      if (current === null) next = dir === 1 ? onsets[0] : onsets[onsets.length - 1];
      else {
        const idx = onsets.findIndex((o) => o > current + 1e-6);
        if (dir === 1) next = idx === -1 ? onsets[0] : onsets[idx];
        else {
          const before = onsets.filter((o) => o < current - 1e-6);
          next = before.length ? before[before.length - 1] : onsets[onsets.length - 1];
        }
      }
      setCursor(next);
      const chord = rangeNotes.filter((n) => Math.abs(n.onset - next) < 1e-6 && hands[n.hand!] === 'on');
      void player.preview(chord.map((n) => ({ midi: n.midi, velocity: n.velocity })), 0.9);
    },
    [onsets, cursor, rangeNotes, from, to, hands.R, hands.L], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        if (t?.tagName === 'BUTTON') return; // the focused button handles Space itself
        e.preventDefault();
        if (player.getState().playing) stopPlayback();
        else startPlayback();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        stepTo(1);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        stepTo(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startPlayback, stopPlayback, stepTo]);

  const inRange = pos >= from && pos <= to;
  const shownPos = inRange ? pos : from;
  const totalSec = quarterToSeconds(score.tempoMap, to, tempoPct / 100) - quarterToSeconds(score.tempoMap, from, tempoPct / 100);
  const elapsedSec = quarterToSeconds(score.tempoMap, shownPos, tempoPct / 100) - quarterToSeconds(score.tempoMap, from, tempoPct / 100);
  const progress = to > from ? Math.min(1, Math.max(0, (shownPos - from) / (to - from))) : 0;
  const windowQ = Math.min(12, Math.max(4, (to - from) / 2));
  const isLearned = learnedSteps.has(stepIndex);
  const pickerNote = picker ? score.notes[picker.noteId] : null;
  const userOverrides = Object.keys(overrides).length;
  const comparing = playing && !!base && pos < block!.start - EPS;
  const markers = withPrev && prev ? [{ at: (span.start - from) / (to - from), label: `начало ${prev.label}` }] : undefined;

  const familyOccurrences = block ? occurrences(score, blocks, families, block.family) : [];
  const diffText = isVariation && block ? diffLines(score, blocks, families, block) : [];
  const sequence = block && block.sequenceEnd !== undefined ? blocks.slice(block.index + 1, block.sequenceEnd + 1) : [];
  const partsOfSpan =
    step.kind === 'together' || step.kind === 'assemble'
      ? HANDS.map((h) => ({
          hand: h,
          list: blocks.filter((b) => b.hand === h && b.endMeasure >= span.startMeasure && b.startMeasure <= span.endMeasure),
        })).filter((x) => x.list.length)
      : [];
  const pianoHint = (
    <>
      Цифры — пальцы{hand ? '' : <>: <b className="t-R">синие</b> — правая рука, <b className="t-L">оранжевые</b> — левая</>} (1 — большой … 5 —
      мизинец). Нажмите на ноту, чтобы поменять палец.
      {userOverrides > 0 && ` Изменено вами: ${userOverrides}.`}
    </>
  );
  const handBadge = (h: Hand) => (
    <span key={h} className={`badge hand-${h}`}>
      {HAND_NAME[h]}: {analysis.noteCount[h]} нот
    </span>
  );

  return (
    <section className="step">
      <div className="step-header">
        <div>
          <div className="step-kicker">
            Шаг {stepIndex + 1} из {steps.length}
            {hand ? ` · ${HAND_LOWER[hand]}` : step.kind === 'together' ? ' · двумя руками' : ''}
          </div>
          <h2 className="step-title">
            {block && (
              <span
                className={`label-chip hand-${block.hand} ${isVariation ? 'variant' : ''}`}
                style={{ ['--block-color' as string]: familyColor(block.family) }}
              >
                {block.label}
              </span>
            )}
            {title}
          </h2>
          <div className="step-sub">{subtitle}</div>
          <div className="step-badges">
            <span className={`badge diff-${analysis.difficulty}`}>Сложность: {analysis.difficultyLabel}</span>
            {isVariation && block && (
              <span className="badge similar">
                ≈ {Math.round(block.similarity * 100)}% как {families[block.family].letter}
              </span>
            )}
            {hand ? handBadge(hand) : HANDS.filter((h) => analysis.noteCount[h] > 0).map(handBadge)}
          </div>
        </div>
        <button className={`btn ${isLearned ? 'success' : 'outline'}`} onClick={() => onToggleLearned(stepIndex)}>
          {isLearned ? '✓ Выучено' : 'Отметить как выученное'}
        </button>
      </div>

      {hand && (
        <div className={`hand-intro hand-${hand}`}>
          Этот шаг — только для {hand === 'R' ? 'правой' : 'левой'} руки: {hand === 'R' ? 'левая' : 'правая'} рука в нотах приглушена и не
          звучит{hasR && hasL ? ' (её можно включить тихо, чтобы держать ритм)' : ''}.
        </div>
      )}

      {isVariation && block && base && (
        <div className="variation-intro">
          <b>Это паттерн {families[block.family].letter}</b> ({blockMeasures(score, base)}) с изменениями. Совпадающие ноты вы уже
          знаете — <span className="diff-swatch" /> выделены только отличия
          {block.transpose || block.steps ? `; ${transpositionText(block)}` : ''}.
        </div>
      )}

      {isVariation && base && (
        <div className="card score-card base-card">
          <div className="card-head">
            <span>
              Основа {families[block!.family].letter} · {blockMeasures(score, base)}
            </span>
            <span className="muted small">
              <span className="diff-swatch base" /> — ноты основы, которые в вариации изменились или исчезли
            </span>
          </div>
          <ScoreView
            xml={renderXml}
            score={score}
            range={[base.startMeasure, base.endMeasure]}
            zoom={0.85}
            activeIds={activeIds}
            markIds={markIds}
            focusHand={hand}
          />
        </div>
      )}

      <div className="card score-card">
        <div className="card-head">
          <span>
            {isVariation
              ? `Вариация ${block!.label} — отличия выделены`
              : step.kind === 'pattern'
                ? 'Ноты паттерна с аппликатурой'
                : 'Ноты фрагмента'}
          </span>
          <span className="muted small">{pianoHint}</span>
        </div>
        {isVariation && (
          <div className="diff-legend">
            <span>
              <span className="diff-swatch" /> другая нота
            </span>
            {rhythmIds.size > 0 && (
              <span>
                <span className="diff-swatch rhythm" /> другой ритм
              </span>
            )}
            <label className="check">
              <input type="checkbox" checked={dimSame} onChange={(e) => setDimSame(e.target.checked)} />
              приглушить совпадающие ноты
            </label>
          </div>
        )}
        <ScoreView
          xml={renderXml}
          score={score}
          range={[firstMeasure, span.endMeasure]}
          zoom={1.05}
          activeIds={activeIds}
          selectedId={picker?.noteId ?? null}
          diffIds={isVariation ? diffIds : undefined}
          rhythmIds={isVariation ? rhythmIds : undefined}
          dimIds={dimIds}
          focusHand={hand}
          onNoteClick={(noteId, rect) => {
            const n = score.notes[noteId];
            if (n?.hand) setPicker({ noteId, rect });
          }}
        />
      </div>

      <Transport
        playing={playing}
        countingIn={playing && ps.countingIn}
        countBeat={ps.countBeat}
        onPlay={() => startPlayback()}
        onStop={stopPlayback}
        tempoPct={tempoPct}
        onTempo={setTempoPct}
        baseBpm={score.tempoMap[0].bpm}
        loop={loop}
        onLoop={setLoop}
        metronome={metronome}
        onMetronome={setMetronome}
        countIn={countIn}
        onCountIn={setCountIn}
        handSel={handSel}
        onHandSel={setHandSel}
        hasR={hasR}
        hasL={hasL}
        otherQuiet={otherQuiet}
        onOtherQuiet={setOtherQuiet}
        fixedHand={hand}
        onStepPrev={() => stepTo(-1)}
        onStepNext={() => stepTo(1)}
        withPrev={withPrev}
        onWithPrev={(v) => {
          player.stop();
          setCursor(null);
          setWithPrev(v);
        }}
        canWithPrev={!!prev}
        progress={progress}
        onSeek={(f) => {
          const q = from + f * (to - from);
          const snapped = onsets.filter((o) => o <= q + 1e-6).pop() ?? from;
          if (player.getState().playing) startPlayback(snapped);
          else setCursor(snapped);
        }}
        timeLabel={comparing ? `звучит основа ${families[block!.family].letter}…` : `${fmtTime(elapsedSec)} / ${fmtTime(totalSec)}`}
        markers={markers}
        extra={
          isVariation ? (
            <button className={`btn small compare-btn ${comparing ? 'on' : ''}`} onClick={startCompare} title="Сыграть основу паттерна, а затем эту вариацию">
              ⇄ Сравнить {families[block!.family].letter} → {block!.label}
            </button>
          ) : null
        }
      />

      <div className="card keys-card">
        <div className="card-head">
          <span>Клавиатура</span>
          <span className="legend">
            {(!hand || hand === 'R' || otherQuiet) && hasR && (
              <>
                <i className="dot hand-R" /> правая рука{' '}
              </>
            )}
            {(!hand || hand === 'L' || otherQuiet) && hasL && (
              <>
                <i className="dot hand-L" /> левая рука
              </>
            )}
            {isVariation && (
              <>
                <i className="dot diff" /> отличие от {families[block!.family].letter}
              </>
            )}
            <span className="muted small"> · ◀ ▶ или стрелки — по одной ноте</span>
          </span>
        </div>
        <div className="kb-scroll" ref={kbScrollRef}>
          <div className="kb-inner" style={{ minWidth: whiteKeyCount(kbRange) * 22 }}>
            <PianoRoll
              notes={rangeNotes}
              range={kbRange}
              position={inRange ? pos : from}
              windowQ={windowQ}
              hands={hands}
              measures={score.measures}
              rangeEnd={to}
              height={190}
              diffIds={isVariation ? diffIds : undefined}
            />
            <Keyboard
              range={kbRange}
              active={activeKeys}
              marks={marks}
              nameStyle={settings.noteNames}
              preferFlats={(score.measures[span.startMeasure]?.fifths ?? 0) < 0}
              onKeyClick={(midi) => void player.preview([{ midi }], 0.8)}
            />
          </div>
        </div>
      </div>

      <div className="step-columns">
        <div className="card tips-card">
          {isVariation && block && (
            <>
              <h3>
                Чем {block.label} отличается от {families[block.family].letter}
              </h3>
              <p className="muted small">
                Совпадает на {Math.round(block.similarity * 100)}%
                {changedMeasureCount(block)
                  ? ` · отличия в ${changedMeasureCount(block)} из ${block.endMeasure - (block.coreStart ?? block.startMeasure) + 1} ${plural(block.endMeasure - (block.coreStart ?? block.startMeasure) + 1, 'такта', 'тактов', 'тактов')}`
                  : ''}
                .
              </p>
              <ul className="tips diff-list">
                {diffText.length ? (
                  diffText.map((t, i) => (
                    <li key={i} className="tip tip-diff">
                      {t}
                    </li>
                  ))
                ) : (
                  <li className="tip">Отличия только в длительностях нот.</li>
                )}
              </ul>
            </>
          )}
          {sequence.length > 0 && block && (
            <>
              <h3>Секвенция</h3>
              <p className="sequence-note">
                Сразу после {block.label} тот же рисунок повторяется от других нот:{' '}
                {sequence.map((b) => `${shortMeasures(score, b.startMeasure, b.endMeasure)} — ${shiftText(b)}`).join('; ')}. Рука
                сохраняет форму и аппликатуру и просто сдвигается.
              </p>
            </>
          )}
          {step.kind === 'pattern' && familyOccurrences.length > 1 && (
            <>
              <h3>Где встречается паттерн {block!.label}</h3>
              <ul className="occurrences">
                {familyOccurrences.map((o) => (
                  <li key={o.block.index}>
                    <button
                      className={`occ role-${o.block.role}`}
                      style={{ ['--block-color' as string]: familyColor(o.block.family) }}
                      onClick={() => onStep(stepOfBlock(steps, blocks, o.block.index) + 1)}
                    >
                      {o.text}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="muted small">
                Выучив его один раз, вы знаете партию {block!.hand === 'R' ? 'правой' : 'левой'} руки во всех этих местах.
              </p>
            </>
          )}
          {partsOfSpan.length > 0 && (
            <>
              <h3>{step.kind === 'together' ? 'Что играет каждая рука' : 'Из чего состоит фрагмент'}</h3>
              {partsOfSpan.map(({ hand: h, list }) => (
                <div key={h} className="assemble-row">
                  <span className={`assemble-hand t-${h}`}>{HAND_SHORT[h]}:</span>
                  {list.map((b) => (
                    <button
                      key={b.index}
                      className={`occ role-${b.role}`}
                      style={{ ['--block-color' as string]: familyColor(b.family) }}
                      onClick={() => onStep(stepOfBlock(steps, blocks, b.index) + 1)}
                      title="Открыть шаг, где этот паттерн разучивается"
                    >
                      {b.label} · {shortMeasures(score, b.startMeasure, b.endMeasure)}
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
          <h3>Постановка {hand ? (hand === 'R' ? 'правой руки' : 'левой руки') : 'рук'}</h3>
          {analysis.handPositions.length === 0 && <p className="muted">В этом фрагменте нет нот для рук.</p>}
          {analysis.handPositions.map((p) => (
            <p key={p.hand} className={`hand-pos hand-${p.hand}`}>
              {p.text}
            </p>
          ))}
          {analysis.tips.length > 0 && (
            <>
              <h3>На что обратить внимание</h3>
              <ul className="tips">
                {analysis.tips.map((t, i) => (
                  <li key={i} className={`tip tip-${t.kind}`}>
                    {t.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="card plan-card">
          <h3>План занятия</h3>
          <ol className="plan">
            {analysis.plan.map((p, i) => (
              <li key={i} className={planDone.has(i) ? 'done' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={planDone.has(i)}
                    onChange={() => {
                      const next = new Set(planDone);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      setPlanDone(next);
                    }}
                  />
                  <span>{p}</span>
                </label>
              </li>
            ))}
          </ol>
          {planDone.size === analysis.plan.length && !isLearned && (
            <button className="btn success" onClick={() => onToggleLearned(stepIndex)}>
              Всё получилось — шаг выучен ✓
            </button>
          )}
        </div>
      </div>

      <div className="step-nav">
        <button className="btn outline" disabled={stepIndex === 0} onClick={() => onStep(stepIndex)}>
          ← Предыдущий шаг
        </button>
        <a className="btn ghost" href={routeHash({ page: 'piece', pieceId, tab: 'score' })}>
          Карта всей пьесы
        </a>
        <button className="btn primary" disabled={stepIndex === steps.length - 1} onClick={() => onStep(stepIndex + 2)}>
          Следующий шаг →
        </button>
      </div>

      {picker && pickerNote && (
        <FingerPicker
          note={pickerNote}
          rect={picker.rect}
          nameStyle={settings.noteNames}
          onPick={(f) => {
            onOverride(pickerNote.key, f);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}
