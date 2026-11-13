import { useEffect, useRef } from 'react';
import type { HandMode } from '../lib/audio';
import { isBlackKey } from '../lib/fingering';
import type { Hand, MeasureInfo, NoteEvent } from '../lib/model';
import { keyCenter, whiteKeyCount, type KeyboardRange } from './Keyboard';

const DIFF_COLORS: [string, string] = ['#c026d3', '#f5d0fe'];
const COLORS: Record<Hand | 'x', [string, string]> = {
  R: ['#2563eb', '#bfdbfe'],
  L: ['#ea580c', '#fed7aa'],
  x: ['#64748b', '#e2e8f0'],
};

/** "Falling notes" view aligned with the keyboard below it. */
export function PianoRoll(props: {
  notes: NoteEvent[];
  range: KeyboardRange;
  position: number;
  windowQ: number;
  hands: Record<Hand, HandMode>;
  measures: MeasureInfo[];
  rangeEnd: number;
  height?: number;
  /** notes that differ from the base pattern */
  diffIds?: ReadonlySet<number>;
}) {
  const { notes, range, position, windowQ, hands, measures, rangeEnd, height = 200, diffIds } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: height });

  useEffect(() => {
    const c = canvasRef.current!;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      sizeRef.current = { w, h: height };
      draw();
    });
    ro.observe(c.parentElement!);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  useEffect(() => {
    draw();
  });

  function draw() {
    const c = canvasRef.current;
    if (!c) return;
    const { w, h } = sizeRef.current;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const count = whiteKeyCount(range);
    const kw = w / count;
    const pxPerQ = h / windowQ;

    // background lanes for black keys
    ctx.fillStyle = '#f1f5f9';
    for (let m = range.low; m <= range.high; m++) {
      if (!isBlackKey(m)) continue;
      const cx = keyCenter(range, m) * kw;
      ctx.fillRect(cx - kw * 0.3, 0, kw * 0.6, h);
    }
    // octave separators
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let m = range.low; m <= range.high; m++) {
      if (((m % 12) + 12) % 12 !== 0) continue;
      const x = (keyCenter(range, m) - 0.5) * kw;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    // bar lines
    for (const m of measures) {
      const y = h - (m.start - position) * pxPerQ;
      if (y < -1 || y > h + 1) continue;
      ctx.strokeStyle = '#94a3b8';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#64748b';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`такт ${m.number}`, 4, y - 4);
    }
    // end of range
    const yEnd = h - (rangeEnd - position) * pxPerQ;
    if (yEnd > 0 && yEnd < h) {
      ctx.fillStyle = 'rgba(148,163,184,0.18)';
      ctx.fillRect(0, 0, w, yEnd);
    }

    // notes
    ctx.font = `bold ${Math.max(10, Math.min(14, kw * 0.55))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of notes) {
      const end = n.onset + n.duration;
      if (end < position - 1e-6 || n.onset > position + windowQ) continue;
      const hand = (n.hand ?? 'x') as Hand | 'x';
      const mode = n.hand ? hands[n.hand] : 'on';
      const black = isBlackKey(n.midi);
      const cx = keyCenter(range, n.midi) * kw;
      const bw = kw * (black ? 0.58 : 0.82);
      const yTop = h - (end - position) * pxPerQ;
      const yBottom = h - (n.onset - position) * pxPerQ;
      const sounding = n.onset <= position + 1e-6 && end > position;
      const isDiff = diffIds?.has(n.id);
      const [strong, light] = isDiff ? DIFF_COLORS : COLORS[hand];
      ctx.globalAlpha = mode === 'off' ? 0.25 : mode === 'quiet' ? 0.55 : 1;
      ctx.fillStyle = sounding ? strong : black ? strong : light;
      ctx.strokeStyle = strong;
      ctx.lineWidth = isDiff ? 2.5 : 1.5;
      const top = Math.max(yTop, -4);
      const bottom = Math.min(yBottom - 1, h + 4);
      roundRect(ctx, cx - bw / 2, top, bw, Math.max(4, bottom - top), Math.min(6, bw / 3));
      ctx.fill();
      ctx.stroke();
      if (n.finger && bottom - top > 12) {
        ctx.fillStyle = sounding || black ? '#fff' : strong;
        ctx.fillText(String(n.finger), cx, Math.min(bottom - 9, h - 9));
      }
      ctx.globalAlpha = 1;
    }
    // "now" line
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, h - 2, w, 2);
  }

  return (
    <div className="piano-roll" style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
