import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScoreView } from '../components/ScoreView';
import { StructureMap } from '../components/StructureMap';
import { handsFor, Transport, type HandSelection } from '../components/Transport';
import { player } from '../lib/audio';
import { usePersistentState, usePlayerState } from '../lib/hooks';
import { EPS } from '../lib/model';
import type { Guide } from '../lib/piece';
import { blockOfMeasure } from '../lib/segment';
import { quarterToSeconds } from '../lib/timing';

function fmtTime(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function FullScoreView(props: {
  guide: Guide;
  learned: ReadonlySet<number>;
  lastBlock: number;
  onOpenBlock: (index: number) => void;
}) {
  const { guide, learned, lastBlock, onOpenBlock } = props;
  const { score, blocks, families, renderXml } = guide;
  const ps = usePlayerState();
  const hasR = score.notes.some((n) => n.hand === 'R');
  const hasL = score.notes.some((n) => n.hand === 'L');
  const [handSelPref, setHandSel] = usePersistentState<HandSelection>('handSelFull', 'both');
  const [otherQuiet, setOtherQuiet] = usePersistentState('otherQuiet', false);
  const [tempoPct, setTempoPct] = usePersistentState('tempoPctFull', 100);
  const [loop, setLoop] = useState(false);
  const [metronome, setMetronome] = usePersistentState('metronome', false);
  const [countIn, setCountIn] = usePersistentState('countIn', false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [showDiff, setShowDiff] = usePersistentState('showDiffFull', true);
  const diffIds = useMemo(() => {
    const set = new Set<number>();
    if (showDiff) for (const b of blocks) for (const id of [...(b.diff?.changed ?? []), ...(b.diff?.rhythm ?? [])]) set.add(id);
    return set;
  }, [blocks, showDiff]);

  const handSel: HandSelection =
    handSelPref === 'both' ? (hasR && hasL ? 'both' : hasR ? 'R' : 'L') : handSelPref === 'R' ? (hasR ? 'R' : 'L') : hasL ? 'L' : 'R';
  const hands = handsFor(handSel, otherQuiet);
  const from = 0;
  const to = score.totalLength;
  const isMine = ps.from === from && ps.to === to;
  const playing = ps.playing && isMine;
  const pos = playing ? ps.position ?? from : cursor ?? from;
  const showActive = playing || cursor !== null;

  const activeIds = useMemo(() => {
    const s = new Set<number>();
    if (!showActive) return s;
    for (const n of score.notes) {
      if (n.onset > pos + 1e-6) break;
      if (n.hand && hands[n.hand] === 'off') continue;
      if (pos < n.onset + n.duration - 1e-6) s.add(n.id);
    }
    return s;
  }, [score, pos, showActive, hands.R, hands.L]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentMeasure = useMemo(() => {
    if (!showActive) return null;
    let idx = 0;
    for (const m of score.measures) if (m.start <= pos + EPS) idx = m.index;
    return idx;
  }, [score, pos, showActive]);
  const currentBlock = currentMeasure !== null ? blockOfMeasure(blocks, currentMeasure)?.index : lastBlock;

  const startPlayback = useCallback(
    (startAt?: number, restart = false) => {
      void player.play(score, {
        from,
        to,
        startAt: startAt ?? cursor ?? from,
        hands,
        tempoFactor: tempoPct / 100,
        loop,
        metronome,
        countIn: countIn && !restart,
      });
    },
    [score, to, cursor, hands.R, hands.L, tempoPct, loop, metronome, countIn], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const stopPlayback = useCallback(() => {
    const st = player.getState();
    player.stop();
    if (st.position !== null && st.from === from && st.to === to) setCursor(st.position);
  }, [to]);

  useEffect(() => () => player.stop(), []);
  useEffect(() => {
    if (!ps.playing && isMine && ps.position === null) setCursor(null);
  }, [ps.playing, ps.position, isMine]);
  useEffect(() => {
    if (player.getState().playing && isMine) startPlayback(player.getState().position ?? from, true);
  }, [tempoPct, hands.R, hands.L, metronome, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        if (t?.tagName === 'BUTTON') return; // the focused button handles Space itself
        e.preventDefault();
        if (player.getState().playing) stopPlayback();
        else startPlayback();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startPlayback, stopPlayback]);

  const f = tempoPct / 100;
  const totalSec = quarterToSeconds(score.tempoMap, to, f);
  const elapsedSec = quarterToSeconds(score.tempoMap, pos, f);
  const markers = blocks.slice(1).map((b) => ({ at: b.start / to, label: `${b.label} · такт ${score.measures[b.startMeasure].number}` }));

  return (
    <section className="full-score">
      <div className="full-intro">
        <p>
          Пьеса разложена на паттерны. <b>Нажмите на фрагмент</b> (рамку на нотах или полосу ниже), чтобы перейти к шагу,
          где он разучивается. Во время воспроизведения подсвечиваются звучащие ноты и текущий фрагмент.
        </p>
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
        progress={to > 0 ? pos / to : 0}
        onSeek={(fr) => {
          const q = fr * to;
          const b = blocks.find((x) => q >= x.start - EPS && q < x.end - EPS);
          const target = b ? b.start : q;
          if (player.getState().playing) startPlayback(target);
          else setCursor(target);
        }}
        timeLabel={`${fmtTime(elapsedSec)} / ${fmtTime(totalSec)}`}
        markers={markers}
      />
      <StructureMap
        score={score}
        blocks={blocks}
        families={families}
        highlight={currentBlock !== undefined ? new Set([currentBlock]) : undefined}
        onBlock={onOpenBlock}
        showSummary
      />
      <div className="full-legend">
        <span>Рамки одного цвета — один паттерн: буква без штриха — его первое появление и точные повторы, A′, A″ — вариации.</span>
        <label className="check">
          <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
          <span className="diff-swatch" /> показывать отличия вариаций от основы
        </label>
      </div>
      <div className="card score-card full">
        <ScoreView
          xml={renderXml}
          score={score}
          zoom={0.9}
          activeIds={activeIds}
          blocks={blocks}
          currentBlock={currentBlock}
          learned={learned}
          onBlockClick={onOpenBlock}
          diffIds={diffIds}
          followMeasure={playing ? currentMeasure : null}
        />
      </div>
    </section>
  );
}
