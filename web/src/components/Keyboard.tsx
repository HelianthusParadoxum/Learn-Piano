import { isBlackKey, keyPosition } from '../lib/fingering';
import type { FingerMove, Hand } from '../lib/model';
import { midiLabel, type NameStyle } from '../lib/noteNames';

export interface KeyMark {
  hand: Hand | null;
  finger?: number;
  /** the note differs from the base pattern */
  diff?: boolean;
  /** the finger presses another key than last time: the sign is the direction, 2 — more than a tone away */
  move?: FingerMove;
}

/** One triangle beside a finger badge for a move of up to a tone, two for a longer one. */
function moveTriangles(cx: number, cy: number, move: FingerMove, small: boolean): string {
  const dir = Math.sign(move);
  const gap = small ? 9 : 11;
  const triangle = (from: number, w: number) => `M ${cx + dir * from} ${cy - 4} l ${dir * w} 4 l ${-dir * w} 4 z`;
  return Math.abs(move) === 1 ? triangle(gap, 5) : `${triangle(gap - 1, 4)} ${triangle(gap + 3.5, 4)}`;
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

  const fingerBadge = (key: string, cx: number, cy: number, mark: KeyMark, small = false) => (
    <g key={key} className={`finger-badge hand-${mark.hand ?? 'x'} ${mark.diff ? 'diff' : ''} ${mark.move ? 'moved' : ''}`}>
      <circle cx={cx} cy={cy} r={small ? 7.5 : 9} />
      <text x={cx} y={cy + (small ? 3.6 : 4.2)} textAnchor="middle">
        {mark.finger ?? ''}
      </text>
      {mark.move && (
        // the finger came from another key: an arrow on the side it moved towards, two for a long move
        <path className="finger-move" d={moveTriangles(cx, cy, mark.move, small)} />
      )}
    </g>
  );

  // finger badges are drawn over all keys: a black key must not hide the move mark of a white key next to it
  const badges: React.ReactElement[] = [];

  return (
    <svg className="keyboard" viewBox={`0 0 ${width} ${WH + 2}`} preserveAspectRatio="none" role="img" aria-label="Клавиатура">
      {whites.map((m) => {
        const x = (keyPosition(m) - x0) * WW;
        const a = active.get(m);
        const mark = marks?.get(m);
        const isC = ((m % 12) + 12) % 12 === 0;
        const badge = a?.finger ? a : !a && mark?.finger ? mark : undefined;
        if (badge) badges.push(fingerBadge(`w${m}`, x + WW / 2, WH - 42, badge));
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
          </g>
        );
      })}
      {blacks.map((m) => {
        const cx = (keyPosition(m) - x0 + 0.5) * WW;
        const a = active.get(m);
        const mark = marks?.get(m);
        const badge = a?.finger ? a : !a && mark?.finger ? mark : undefined;
        if (badge) badges.push(fingerBadge(`b${m}`, cx, BH - 13, badge, true));
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
            <title>{midiLabel(m, nameStyle, preferFlats)}</title>
          </g>
        );
      })}
      <g className="key-badges" pointerEvents="none">
        {badges}
      </g>
    </svg>
  );
}
