import { isBlackKey, keyPosition } from '../lib/fingering';
import type { Hand } from '../lib/model';
import { midiLabel, type NameStyle } from '../lib/noteNames';

export interface KeyMark {
  hand: Hand | null;
  finger?: number;
}

export interface KeyboardRange {
  low: number;
  high: number;
}

/** Keyboard range covering the given notes, snapped to whole octaves, at least two octaves wide. */
export function rangeFor(midis: number[], minOctaves = 2): KeyboardRange {
  if (!midis.length) return { low: 48, high: 83 };
  let low = Math.min(...midis);
  let high = Math.max(...midis);
  low = low - (((low % 12) + 12) % 12); // down to C
  high = high + (11 - (((high % 12) + 12) % 12)); // up to B
  while (high - low + 1 < minOctaves * 12) {
    if ((high - low + 1) / 12 % 2 === 0) high += 12;
    else low -= 12;
  }
  return { low: Math.max(21, low), high: Math.min(108, high) };
}

export function whiteKeyCount(r: KeyboardRange): number {
  let c = 0;
  for (let m = r.low; m <= r.high; m++) if (!isBlackKey(m)) c++;
  return c;
}

/** Centre of a key in white-key units relative to the left edge of the range. */
export function keyCenter(r: KeyboardRange, midi: number): number {
  const base = keyPosition(r.low);
  return keyPosition(midi) - base + 0.5;
}

const WW = 24; // white key width (svg units)
const WH = 112;
const BW = 14;
const BH = 70;

export function Keyboard(props: {
  range: KeyboardRange;
  active: Map<number, KeyMark>;
  marks?: Map<number, KeyMark>;
  nameStyle: NameStyle;
  preferFlats?: boolean;
  onKeyClick?: (midi: number) => void;
}) {
  const { range, active, marks, nameStyle, preferFlats, onKeyClick } = props;
  const whites: number[] = [];
  const blacks: number[] = [];
  for (let m = range.low; m <= range.high; m++) (isBlackKey(m) ? blacks : whites).push(m);
  const width = whites.length * WW;
  const x0 = keyPosition(range.low);

  const fingerBadge = (cx: number, cy: number, mark: KeyMark, small = false) => (
    <g className={`finger-badge hand-${mark.hand ?? 'x'}`}>
      <circle cx={cx} cy={cy} r={small ? 7.5 : 9} />
      <text x={cx} y={cy + (small ? 3.6 : 4.2)} textAnchor="middle">
        {mark.finger ?? ''}
      </text>
    </g>
  );

  return (
    <svg className="keyboard" viewBox={`0 0 ${width} ${WH + 2}`} preserveAspectRatio="none" role="img" aria-label="Клавиатура">
      {whites.map((m) => {
        const x = (keyPosition(m) - x0) * WW;
        const a = active.get(m);
        const mark = marks?.get(m);
        const isC = ((m % 12) + 12) % 12 === 0;
        return (
          <g key={m} onClick={() => onKeyClick?.(m)} className="key-group">
            <rect
              x={x + 0.5}
              y={0}
              width={WW - 1}
              height={WH}
              rx={3}
              className={`key white ${a ? `pressed hand-${a.hand ?? 'x'}` : mark ? `marked hand-${mark.hand ?? 'x'}` : ''}`}
            />
            <text x={x + WW / 2} y={WH - 7} textAnchor="middle" className={`key-label ${isC ? 'c' : ''}`}>
              {nameStyle === 'solfege' ? midiLabel(m, 'solfege') : midiLabel(m, 'latin')}
            </text>
            {isC && nameStyle === 'solfege' && (
              <text x={x + WW / 2} y={WH - 19} textAnchor="middle" className="key-octave">
                {Math.floor(m / 12) - 1}
              </text>
            )}
            {a?.finger && fingerBadge(x + WW / 2, WH - 42, a)}
            {!a && mark?.finger && fingerBadge(x + WW / 2, WH - 42, mark)}
          </g>
        );
      })}
      {blacks.map((m) => {
        const cx = (keyPosition(m) - x0 + 0.5) * WW;
        const a = active.get(m);
        const mark = marks?.get(m);
        return (
          <g key={m} onClick={() => onKeyClick?.(m)} className="key-group">
            <rect
              x={cx - BW / 2}
              y={0}
              width={BW}
              height={BH}
              rx={2}
              className={`key black ${a ? `pressed hand-${a.hand ?? 'x'}` : mark ? `marked hand-${mark.hand ?? 'x'}` : ''}`}
            />
            {(a?.finger || (!a && mark?.finger)) && fingerBadge(cx, BH - 13, (a ?? mark)!, true)}
            {(a || mark) && !(a?.finger || mark?.finger) && null}
            <title>{midiLabel(m, nameStyle, preferFlats)}</title>
          </g>
        );
      })}
    </svg>
  );
}
