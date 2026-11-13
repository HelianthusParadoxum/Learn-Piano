import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FingerPicker } from '../components/FingerPicker';
import { Keyboard, keyCenter, rangeFor, whiteKeyCount, type KeyMark } from '../components/Keyboard';
import { PianoRoll } from '../components/PianoRoll';
import { familyColor, ScoreView } from '../components/ScoreView';
import { StructureMap } from '../components/StructureMap';
import { handsFor, Transport, type HandSelection } from '../components/Transport';
import { player } from '../lib/audio';
import { routeHash, usePersistentState, usePlayerState } from '../lib/hooks';
import { DEFAULT_SETTINGS, EPS, type Block, type GuideStep, type Hand, type NoteEvent, type PieceSettings } from '../lib/model';
import {
  belowThresholdText,
  blockMeasures,
  changedMeasureCount,
  diffLines,
  diffNoteCount,
  occurrences,
  similarityText,
  steadyHandText,
  stepTitle,
  transpositionText,
} from '../lib/patternText';
import { stepOfBlock } from '../lib/patterns';
import { stepSpan, type Guide } from '../lib/piece';
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

function stepBlocks(step: GuideStep): number[] {
  if (step.kind !== 'assemble') return [step.block];
  const out: number[] = [];
  for (let b = step.fromBlock; b <= step.toBlock; b++) out.push(b);
  return out;
}

export function GuideView(props: Props) {
  const { guide, step, learnedSteps, onStep } = props;
  const { steps, blocks, families, score, analyses } = guide;
  const current = steps[step - 1];
  const highlight = useMemo(() => new Set(current ? stepBlocks(current) : []), [current]);
  if (!current) return <div className="page-msg">В пьесе нет нот для гайда.</div>;
  const item = (st: GuideStep, i: number) => {
    const active = i === step - 1;
    const learned = learnedSteps.has(i);
    const a = analyses[i];
    let badge: React.ReactNode;
    let title: string;
    let sub: string;
    let color = '#64748b';
    if (st.kind === 'assemble') {
      const span = stepSpan(blocks, st);
      badge = st.whole ? '★' : '⧉';
      title = st.whole ? 'Вся пьеса' : `Соединяем ${blocks.slice(st.fromBlock, st.toBlock + 1).map((b) => b.label).join(' ')}`;
      sub = `т. ${score.measures[span.startMeasure].number}–${score.measures[span.endMeasure].number}`;
    } else {
      const b = blocks[st.block];
      color = familyColor(b.family);
      badge = b.label;
      if (st.kind === 'pattern') {
        const times = families[b.family].blocks.length;
        title = `Паттерн ${b.label}`;
        sub = `т. ${score.measures[b.startMeasure].number}–${score.measures[b.endMeasure].number}${times > 1 ? ` · ×${times}` : ''} · ${a.difficultyLabel}`;
      } else {
        title = `Вариация ${b.label}`;
        const n = diffNoteCount(b);
        sub = `т. ${score.measures[b.startMeasure].number}–${score.measures[b.endMeasure].number} · ${b.transpose || b.steps ? 'транспонирована' : `отличий: ${n}`}`;
      }
    }
    return (
      <button
        key={i}
        className={`block-item kind-${st.kind} ${active ? 'active' : ''} ${learned ? 'learned' : ''}`}
        onClick={() => onStep(i + 1)}
      >
        <span className={`block-num ${st.kind === 'variation' ? 'variant' : ''}`} style={{ ['--block-color' as string]: color }}>
          {learned ? '✓' : badge}
        </span>
        <span className="block-item-text">
          <span className="block-item-title">{title}</span>
          <span className="block-item-sub">{sub}</span>
        </span>
      </button>
    );
  };
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
          <div className="block-list-title">Паттерны и вариации</div>
          {steps.map((st, i) => (st.kind !== 'assemble' ? item(st, i) : null))}
          {steps.some((st) => st.kind === 'assemble') && <div className="block-list-title">Сборка</div>}
          {steps.map((st, i) => (st.kind === 'assemble' ? item(st, i) : null))}
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

function StepView(props: Props & { stepIndex: number }) {
  const { pieceId, guide, stepIndex, learnedSteps, settings, onStep, onToggleLearned, onOverride, overrides } = props;
  const { score, blocks, families, steps, analyses, renderXml } = guide;
  const step = steps[stepIndex];
  const analysis = analyses[stepIndex];
  const span = stepSpan(blocks, step);
  const block: Block | null = step.kind === 'assemble' ? null : blocks[step.block];
  const isVariation = step.kind === 'variation' && !!block;
  const base: Block | null = isVariation && block ? blocks[families[block.family].base] : null;
  const { title, subtitle } = stepTitle(score, blocks, families, step);
  const ps = usePlayerState();
  const hasR = analysis.noteCount.R > 0;
  const hasL = analysis.noteCount.L > 0;

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

  const handSel: HandSelection =
    handSelPref === 'both' ? (hasR && hasL ? 'both' : hasR ? 'R' : 'L') : handSelPref === 'R' ? (hasR ? 'R' : 'L') : hasL ? 'L' : 'R';
  const hands = handsFor(handSel, otherQuiet);
  const prevBlock = block && block.index > 0 ? blocks[block.index - 1] : null;
  const from = withPrev && prevBlock ? prevBlock.start : span.start;
  const to = span.end;
  const firstMeasure = withPrev && prevBlock ? prevBlock.startMeasure : span.startMeasure;

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
        ? new Set(rangeNotes.filter((n) => n.onset >= block!.start - EPS && !diffIds.has(n.id) && !rhythmIds.has(n.id)).map((n) => n.id))
        : undefined,
    [isVariation, dimSame, rangeNotes, block, diffIds, rhythmIds],
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
    for (const h of ['R', 'L'] as Hand[]) {
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
  const kbRange = useMemo(() => rangeFor([...rangeNotes, ...baseNotes].map((n) => n.midi)), [rangeNotes, baseNotes]);

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
  const markers = withPrev && prevBlock ? [{ at: (span.start - from) / (to - from), label: `начало ${block?.label}` }] : undefined;

  const familyOccurrences = block ? occurrences(score, blocks, families, block.family) : [];
  const diffText = isVariation && block ? diffLines(score, blocks, families, block) : [];
  const assembleBlocks = step.kind === 'assemble' ? blocks.slice(step.fromBlock, step.toBlock + 1) : [];
  const pianoHint = (
    <>
      Цифры — пальцы: <b className="t-R">синие</b> — правая рука, <b className="t-L">оранжевые</b> — левая (1 — большой … 5 —
      мизинец). Нажмите на ноту, чтобы поменять палец.
      {userOverrides > 0 && ` Изменено вами: ${userOverrides}.`}
    </>
  );

  return (
    <section className="step">
      <div className="step-header">
        <div>
          <div className="step-kicker">
            Шаг {stepIndex + 1} из {steps.length}
          </div>
          <h2 className="step-title">
            {block && (
              <span className={`label-chip ${isVariation ? 'variant' : ''}`} style={{ ['--block-color' as string]: familyColor(block.family) }}>
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
            {hasR && <span className="badge hand-R">Правая: {analysis.noteCount.R} нот</span>}
            {hasL && <span className="badge hand-L">Левая: {analysis.noteCount.L} нот</span>}
          </div>
        </div>
        <button className={`btn ${isLearned ? 'success' : 'outline'}`} onClick={() => onToggleLearned(stepIndex)}>
          {isLearned ? '✓ Выучено' : 'Отметить как выученное'}
        </button>
      </div>

      {isVariation && block && base && (
        <div className="variation-intro">
          <b>Это паттерн {families[block.family].letter}</b> ({blockMeasures(score, base)}) с изменениями. Совпадающие ноты вы уже
          знаете — <span className="diff-swatch" /> выделены только отличия
          {block.transpose || block.steps ? `; ${transpositionText(block)}` : ''}. {steadyHandText(score, families, block)}
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
          <ScoreView xml={renderXml} score={score} range={[base.startMeasure, base.endMeasure]} zoom={0.85} activeIds={activeIds} markIds={markIds} />
        </div>
      )}

      <div className="card score-card">
        <div className="card-head">
          <span>{isVariation ? `Вариация ${block!.label} — отличия выделены` : step.kind === 'assemble' ? 'Ноты фрагмента' : 'Ноты паттерна с аппликатурой'}</span>
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
        onStepPrev={() => stepTo(-1)}
        onStepNext={() => stepTo(1)}
        withPrev={withPrev}
        onWithPrev={(v) => {
          player.stop();
          setCursor(null);
          setWithPrev(v);
        }}
        canWithPrev={!!prevBlock}
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
            <i className="dot hand-R" /> правая рука <i className="dot hand-L" /> левая рука
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
              <h3>Чем {block.label} отличается от {families[block.family].letter}</h3>
              <p className="muted small">
                Совпадает на {similarityText(score, block)}
                {changedMeasureCount(block) ? ` · отличия в ${changedMeasureCount(block)} из ${block.endMeasure - (block.coreStart ?? block.startMeasure) + 1} тактов` : ''}.{' '}
                {belowThresholdText(score, families, block, settings.similarity ?? DEFAULT_SETTINGS.similarity!)}
              </p>
              <ul className="tips diff-list">
                {diffText.length ? diffText.map((t, i) => <li key={i} className="tip tip-diff">{t}</li>) : <li className="tip">Отличия только в длительностях нот.</li>}
              </ul>
            </>
          )}
          {step.kind === 'pattern' && familyOccurrences.length > 1 && (
            <>
              <h3>Где встречается паттерн {block!.label}</h3>
              <ul className="occurrences">
                {familyOccurrences.map((o) => (
                  <li key={o.block.index}>
                    <button className={`occ role-${o.block.role}`} style={{ ['--block-color' as string]: familyColor(o.block.family) }} onClick={() => onStep(stepOfBlock(steps, blocks, o.block.index) + 1)}>
                      {o.text}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="muted small">Выучив его один раз, вы знаете все эти места пьесы.</p>
            </>
          )}
          {step.kind === 'assemble' && (
            <>
              <h3>Из чего состоит фрагмент</h3>
              <div className="assemble-row">
                {assembleBlocks.map((b) => (
                  <button key={b.index} className={`occ role-${b.role}`} style={{ ['--block-color' as string]: familyColor(b.family) }} onClick={() => onStep(stepOfBlock(steps, blocks, b.index) + 1)}>
                    {b.label} · т. {score.measures[b.startMeasure].number}–{score.measures[b.endMeasure].number}
                  </button>
                ))}
              </div>
            </>
          )}
          <h3>Постановка рук</h3>
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
