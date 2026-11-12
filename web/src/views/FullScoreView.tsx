import { useCallback, useEffect, useMemo, useState } from 'react';
import { BLOCK_COLORS, ScoreView } from '../components/ScoreView';
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
  const { score, blocks, renderXml } = guide;
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

  const handSel: HandSelection = handSelPref === 'both' ? (hasR && hasL ? 'both' : hasR ? 'R' : 'L') : handSelPref;
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
    (startAt?: number) => {
      void player.play(score, {
        from,
        to,
        startAt: startAt ?? cursor ?? from,
        hands,
        tempoFactor: tempoPct / 100,
        loop,
        metronome,
        countIn,
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
    if (player.getState().playing && isMine) startPlayback(player.getState().position ?? from);
  }, [tempoPct, hands.R, hands.L, metronome, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
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
  const markers = blocks.slice(1).map((b) => ({ at: b.start / to, label: `Блок ${b.index + 1}` }));

  return (
    <section className="full-score">
      <div className="full-intro">
        <p>
          Цветные рамки — блоки гайда. <b>Нажмите на блок</b>, чтобы перейти к шагу с его разучиванием. Во время
          воспроизведения подсвечиваются звучащие ноты и текущий блок.
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
      <div className="block-chips">
        {blocks.map((b) => (
          <button
            key={b.index}
            className={`block-chip ${b.index === currentBlock ? 'current' : ''} ${learned.has(b.index) ? 'learned' : ''}`}
            style={{ ['--block-color' as string]: BLOCK_COLORS[b.index % BLOCK_COLORS.length] }}
            onClick={() => onOpenBlock(b.index)}
            title={`Открыть шаг ${b.index + 1}`}
          >
            <b>{learned.has(b.index) ? '✓' : b.index + 1}</b>
            <span>
              т. {score.measures[b.startMeasure].number}–{score.measures[b.endMeasure].number}
            </span>
          </button>
        ))}
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
          followMeasure={playing ? currentMeasure : null}
        />
      </div>
    </section>
  );
}
