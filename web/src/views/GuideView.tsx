import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FingerPicker } from '../components/FingerPicker';
import { Keyboard, keyCenter, rangeFor, whiteKeyCount, type KeyMark } from '../components/Keyboard';
import { PianoRoll } from '../components/PianoRoll';
import { BLOCK_COLORS, ScoreView } from '../components/ScoreView';
import { handsFor, Transport, type HandSelection } from '../components/Transport';
import { player } from '../lib/audio';
import { routeHash, usePersistentState, usePlayerState } from '../lib/hooks';
import { EPS, type Block, type Hand, type NoteEvent, type PieceSettings } from '../lib/model';
import type { Guide } from '../lib/piece';
import { quarterToSeconds } from '../lib/timing';

interface Props {
  pieceId: string;
  guide: Guide;
  step: number;
  learned: ReadonlySet<number>;
  settings: PieceSettings;
  overrides: Record<string, number>;
  onStep: (step: number) => void;
  onToggleLearned: (b: Block) => void;
  onOverride: (key: string, finger: number | null) => void;
}

export function GuideView(props: Props) {
  const { guide, step, learned, onStep } = props;
  const { blocks, score, analyses } = guide;
  const block = blocks[step - 1];
  if (!block) return <div className="page-msg">В пьесе нет блоков.</div>;
  return (
    <div className="guide">
      <aside className="block-list" aria-label="Блоки">
        <div className="block-list-title">Шаги гайда</div>
        {blocks.map((b) => {
          const a = analyses[b.index];
          return (
            <button
              key={b.index}
              className={`block-item ${b.index === block.index ? 'active' : ''} ${learned.has(b.index) ? 'learned' : ''}`}
              onClick={() => onStep(b.index + 1)}
            >
              <span className="block-num" style={{ background: BLOCK_COLORS[b.index % BLOCK_COLORS.length] }}>
                {learned.has(b.index) ? '✓' : b.index + 1}
              </span>
              <span className="block-item-text">
                <span className="block-item-title">
                  Такты {score.measures[b.startMeasure].number}–{score.measures[b.endMeasure].number}
                </span>
                <span className="block-item-sub">
                  {b.repeatOf !== undefined ? `повтор блока ${b.repeatOf + 1}` : b.similarTo !== undefined ? `похож на блок ${b.similarTo + 1}` : a.difficultyLabel}
                </span>
              </span>
              <span className="dots" title={`Сложность: ${a.difficultyLabel}`}>
                {[1, 2, 3, 4, 5].map((d) => (
                  <i key={d} className={d <= a.difficulty ? 'on' : ''} />
                ))}
              </span>
            </button>
          );
        })}
      </aside>
      <StepView key={block.index} {...props} block={block} />
    </div>
  );
}

function fmtTime(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function StepView(props: Props & { block: Block }) {
  const { pieceId, guide, block, learned, settings, onStep, onToggleLearned, onOverride, overrides } = props;
  const { score, blocks, analyses, renderXml } = guide;
  const analysis = analyses[block.index];
  const ps = usePlayerState();
  const hasR = analysis.noteCount.R > 0;
  const hasL = analysis.noteCount.L > 0;

  const [handSelPref, setHandSel] = usePersistentState<HandSelection>('handSel', 'both');
  const [otherQuiet, setOtherQuiet] = usePersistentState('otherQuiet', false);
  const [tempoPct, setTempoPct] = usePersistentState('tempoPct', 70);
  const [loop, setLoop] = usePersistentState('loop', true);
  const [metronome, setMetronome] = usePersistentState('metronome', false);
  const [countIn, setCountIn] = usePersistentState('countIn', false);
  const [withPrev, setWithPrev] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ noteId: number; rect: DOMRect } | null>(null);
  const [planDone, setPlanDone] = useState<Set<number>>(new Set());

  const handSel: HandSelection = handSelPref === 'both' ? (hasR && hasL ? 'both' : hasR ? 'R' : 'L') : handSelPref === 'R' ? (hasR ? 'R' : 'L') : hasL ? 'L' : 'R';
  const hands = handsFor(handSel, otherQuiet);
  const prev = block.index > 0 ? blocks[block.index - 1] : null;
  const from = withPrev && prev ? prev.start : block.start;
  const to = block.end;
  const firstMeasure = withPrev && prev ? prev.startMeasure : block.startMeasure;

  const isMine = ps.from === from && ps.to === to;
  const playing = ps.playing && isMine;
  const pos = playing ? ps.position ?? from : cursor ?? from;

  const rangeNotes = useMemo(
    () => score.notes.filter((n) => n.hand && n.onset >= from - EPS && n.onset < to - EPS),
    [score, from, to],
  );

  const onsets = useMemo(() => {
    const set = new Set<number>();
    for (const n of rangeNotes) if (hands[n.hand!] === 'on') set.add(Math.round(n.onset * 1e6) / 1e6);
    return Array.from(set).sort((a, b) => a - b);
  }, [rangeNotes, hands.R, hands.L]); // eslint-disable-line react-hooks/exhaustive-deps

  const active: NoteEvent[] = useMemo(() => {
    const visible = rangeNotes.filter((n) => hands[n.hand!] !== 'off');
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
  }, [rangeNotes, playing, cursor, pos, hands.R, hands.L]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeIds = useMemo(() => new Set(active.map((n) => n.id)), [active]);
  const activeKeys = useMemo(() => {
    const m = new Map<number, KeyMark>();
    for (const n of active) m.set(n.midi, { hand: n.hand, finger: n.finger });
    return m;
  }, [active]);
  const marks = useMemo(() => {
    const m = new Map<number, KeyMark>();
    for (const n of rangeNotes) if (hands[n.hand!] !== 'off' && !m.has(n.midi)) m.set(n.midi, { hand: n.hand });
    return m;
  }, [rangeNotes, hands.R, hands.L]); // eslint-disable-line react-hooks/exhaustive-deps
  const kbRange = useMemo(() => rangeFor(rangeNotes.map((n) => n.midi)), [rangeNotes]);

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

  const stopPlayback = useCallback(() => {
    const st = player.getState();
    player.stop();
    if (st.position !== null && st.from === from && st.to === to) setCursor(st.position);
  }, [from, to]);

  // stop when leaving this block
  useEffect(() => () => player.stop(), []);

  // natural end of playback → back to the start
  useEffect(() => {
    if (!ps.playing && isMine && ps.position === null) setCursor(null);
  }, [ps.playing, ps.position, isMine]);

  // apply changed options immediately while playing
  useEffect(() => {
    if (player.getState().playing && isMine) startPlayback(player.getState().position ?? from, true);
  }, [tempoPct, hands.R, hands.L, metronome, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepTo = useCallback(
    (dir: 1 | -1) => {
      const st = player.getState();
      // while playing, step from the note that is sounding now
      const current = st.playing && st.from === from && st.to === to && st.position !== null ? st.position : cursor;
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

  const totalSec =
    quarterToSeconds(score.tempoMap, to, tempoPct / 100) - quarterToSeconds(score.tempoMap, from, tempoPct / 100);
  const elapsedSec = quarterToSeconds(score.tempoMap, pos, tempoPct / 100) - quarterToSeconds(score.tempoMap, from, tempoPct / 100);
  const progress = to > from ? Math.min(1, Math.max(0, (pos - from) / (to - from))) : 0;
  const blockQ = to - from;
  const windowQ = Math.min(12, Math.max(4, blockQ / 2));
  const mStart = score.measures[block.startMeasure];
  const mEnd = score.measures[block.endMeasure];
  const isLearned = learned.has(block.index);
  const pickerNote = picker ? score.notes[picker.noteId] : null;
  const userOverrides = Object.keys(overrides).length;

  const markers = withPrev && prev ? [{ at: (block.start - from) / (to - from), label: `начало блока ${block.index + 1}` }] : undefined;

  return (
    <section className="step">
      <div className="step-header">
        <div>
          <div className="step-kicker">
            Шаг {block.index + 1} из {blocks.length}
          </div>
          <h2 className="step-title">
            Блок {block.index + 1}: такты {mStart.number}–{mEnd.number}
          </h2>
          <div className="step-badges">
            <span className={`badge diff-${analysis.difficulty}`}>Сложность: {analysis.difficultyLabel}</span>
            {block.repeatOf !== undefined && (
              <button className="badge repeat" onClick={() => onStep(block.repeatOf! + 1)}>
                ↺ повтор блока {block.repeatOf + 1}
              </button>
            )}
            {block.similarTo !== undefined && (
              <button className="badge similar" onClick={() => onStep(block.similarTo! + 1)}>
                ≈ похож на блок {block.similarTo + 1}
              </button>
            )}
            {hasR && <span className="badge hand-R">Правая: {analysis.noteCount.R} нот</span>}
            {hasL && <span className="badge hand-L">Левая: {analysis.noteCount.L} нот</span>}
          </div>
        </div>
        <button className={`btn ${isLearned ? 'success' : 'outline'}`} onClick={() => onToggleLearned(block)}>
          {isLearned ? '✓ Выучен' : 'Отметить как выученный'}
        </button>
      </div>

      <div className="card score-card">
        <div className="card-head">
          <span>Ноты блока с аппликатурой</span>
          <span className="muted small">
            Цифры — пальцы: <b className="t-R">синие</b> — правая рука, <b className="t-L">оранжевые</b> — левая (1 — большой … 5 — мизинец). Нажмите на ноту, чтобы поменять палец.
            {userOverrides > 0 && ` Изменено вами: ${userOverrides}.`}
          </span>
        </div>
        <ScoreView
          xml={renderXml}
          score={score}
          range={[firstMeasure, block.endMeasure]}
          zoom={1.05}
          activeIds={activeIds}
          selectedId={picker?.noteId ?? null}
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
        canWithPrev={!!prev}
        progress={progress}
        onSeek={(f) => {
          const q = from + f * (to - from);
          const snapped = onsets.filter((o) => o <= q + 1e-6).pop() ?? from;
          if (player.getState().playing) startPlayback(snapped);
          else setCursor(snapped);
        }}
        timeLabel={`${fmtTime(elapsedSec)} / ${fmtTime(totalSec)}`}
        markers={markers}
      />

      <div className="card keys-card">
        <div className="card-head">
          <span>Клавиатура</span>
          <span className="legend">
            <i className="dot hand-R" /> правая рука <i className="dot hand-L" /> левая рука
            <span className="muted small"> · ◀ ▶ или стрелки — по одной ноте</span>
          </span>
        </div>
        <div className="kb-scroll" ref={kbScrollRef}>
          <div className="kb-inner" style={{ minWidth: whiteKeyCount(kbRange) * 22 }}>
            <PianoRoll
              notes={rangeNotes}
              range={kbRange}
              position={pos}
              windowQ={windowQ}
              hands={hands}
              measures={score.measures}
              rangeEnd={to}
              height={190}
            />
            <Keyboard
              range={kbRange}
              active={activeKeys}
              marks={marks}
              nameStyle={settings.noteNames}
              preferFlats={(score.measures[block.startMeasure]?.fifths ?? 0) < 0}
              onKeyClick={(midi) => void player.preview([{ midi }], 0.8)}
            />
          </div>
        </div>
      </div>

      <div className="step-columns">
        <div className="card tips-card">
          <h3>Постановка рук</h3>
          {analysis.handPositions.length === 0 && <p className="muted">В блоке нет нот для рук.</p>}
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
            <button className="btn success" onClick={() => onToggleLearned(block)}>
              Всё получилось — блок выучен ✓
            </button>
          )}
        </div>
      </div>

      <div className="step-nav">
        <button className="btn outline" disabled={block.index === 0} onClick={() => onStep(block.index)}>
          ← Предыдущий блок
        </button>
        <a className="btn ghost" href={routeHash({ page: 'piece', pieceId, tab: 'score' })}>
          Карта всей пьесы
        </a>
        <button className="btn primary" disabled={block.index === blocks.length - 1} onClick={() => onStep(block.index + 2)}>
          Следующий блок →
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
