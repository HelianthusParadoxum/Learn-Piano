import type { ReactNode } from 'react';
import type { HandMode } from '../lib/audio';
import type { Hand } from '../lib/model';

export type HandSelection = 'both' | 'R' | 'L';

export function handsFor(sel: HandSelection, otherQuiet: boolean): Record<Hand, HandMode> {
  const other: HandMode = otherQuiet ? 'quiet' : 'off';
  if (sel === 'R') return { R: 'on', L: other };
  if (sel === 'L') return { R: other, L: 'on' };
  return { R: 'on', L: 'on' };
}

export interface TransportProps {
  playing: boolean;
  countingIn: boolean;
  countBeat: number;
  onPlay: () => void;
  onStop: () => void;
  tempoPct: number;
  onTempo: (pct: number) => void;
  baseBpm: number;
  loop: boolean;
  onLoop: (v: boolean) => void;
  metronome: boolean;
  onMetronome: (v: boolean) => void;
  countIn: boolean;
  onCountIn: (v: boolean) => void;
  handSel: HandSelection;
  onHandSel: (h: HandSelection) => void;
  hasR: boolean;
  hasL: boolean;
  otherQuiet: boolean;
  onOtherQuiet: (v: boolean) => void;
  /** a step for one hand: the hand cannot be switched, the other hand can sound quietly */
  fixedHand?: Hand | null;
  onStepPrev?: () => void;
  onStepNext?: () => void;
  withPrev?: boolean;
  onWithPrev?: (v: boolean) => void;
  canWithPrev?: boolean;
  progress: number;
  onSeek?: (fraction: number) => void;
  timeLabel: string;
  markers?: { at: number; label: string }[];
  /** extra controls in the first row (e.g. "compare with the base pattern") */
  extra?: ReactNode;
}

export function Transport(p: TransportProps) {
  const bpm = Math.round((p.baseBpm * p.tempoPct) / 100);
  return (
    <div className="transport">
      <div className="transport-row">
        <button
          className={`play-btn ${p.playing ? 'playing' : ''}`}
          onClick={p.playing ? p.onStop : p.onPlay}
          title={p.playing ? 'Остановить (пробел)' : 'Играть (пробел)'}
        >
          {p.playing ? (
            p.countingIn ? (
              <span className="count-in">{p.countBeat || '…'}</span>
            ) : (
              <svg viewBox="0 0 24 24" width="22" height="22"><rect x="6" y="5" width="4.5" height="14" rx="1" fill="currentColor" /><rect x="13.5" y="5" width="4.5" height="14" rx="1" fill="currentColor" /></svg>
            )
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" /></svg>
          )}
        </button>
        {p.extra}
        {p.onStepPrev && (
          <div className="step-btns" title="Пошаговый режим: по одной ноте/аккорду (← →)">
            <button className="btn small" onClick={p.onStepPrev}>◀ шаг</button>
            <button className="btn small" onClick={p.onStepNext}>шаг ▶</button>
          </div>
        )}
        {p.fixedHand ? (
          <span className={`hand-fixed hand-${p.fixedHand}`} title="Этот шаг разучивается одной рукой">
            {p.fixedHand === 'R' ? 'Правая рука' : 'Левая рука'}
          </span>
        ) : (
          <div className="seg" role="group" aria-label="Руки">
            <button className={p.handSel === 'both' ? 'on' : ''} onClick={() => p.onHandSel('both')} disabled={!p.hasR || !p.hasL}>
              Обе руки
            </button>
            <button className={`r ${p.handSel === 'R' ? 'on' : ''}`} onClick={() => p.onHandSel('R')} disabled={!p.hasR}>
              Правая
            </button>
            <button className={`l ${p.handSel === 'L' ? 'on' : ''}`} onClick={() => p.onHandSel('L')} disabled={!p.hasL}>
              Левая
            </button>
          </div>
        )}
        {p.handSel !== 'both' && p.hasR && p.hasL && (
          <label className="check" title="Вторая рука звучит тихо — так легче держать ритм">
            <input type="checkbox" checked={p.otherQuiet} onChange={(e) => p.onOtherQuiet(e.target.checked)} />
            {p.fixedHand ? `${p.fixedHand === 'R' ? 'левая' : 'правая'} рука тихо` : 'вторая рука тихо'}
          </label>
        )}
      </div>
      <div className="transport-row">
        <label className="tempo">
          <span>Темп</span>
          <input
            type="range"
            min={25}
            max={130}
            step={5}
            value={p.tempoPct}
            onChange={(e) => p.onTempo(Number(e.target.value))}
          />
          <span className="tempo-value">
            {p.tempoPct}% · ♩={bpm}
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.loop} onChange={(e) => p.onLoop(e.target.checked)} />
          повтор по кругу
        </label>
        <label className="check">
          <input type="checkbox" checked={p.metronome} onChange={(e) => p.onMetronome(e.target.checked)} />
          метроном
        </label>
        <label className="check">
          <input type="checkbox" checked={p.countIn} onChange={(e) => p.onCountIn(e.target.checked)} />
          отсчёт такта
        </label>
        {p.onWithPrev && p.canWithPrev && (
          <label className="check" title="Сыграть предыдущий фрагмент и этот подряд — тренировка «стыка»">
            <input type="checkbox" checked={!!p.withPrev} onChange={(e) => p.onWithPrev!(e.target.checked)} />
            с предыдущим фрагментом
          </label>
        )}
      </div>
      <div className="progress-row">
        <div
          className="progress-track seekable"
          onClick={(e) => {
            if (!p.onSeek) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            p.onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
          }}
          title="Нажмите, чтобы начать с этого места"
        >
          <div className="progress-fill" style={{ width: `${Math.round(p.progress * 1000) / 10}%` }} />
          {p.markers?.map((m, i) => (
            <span key={i} className="progress-marker" style={{ left: `${m.at * 100}%` }} title={m.label} />
          ))}
        </div>
        <span className="time-label">{p.timeLabel}</span>
      </div>
    </div>
  );
}
