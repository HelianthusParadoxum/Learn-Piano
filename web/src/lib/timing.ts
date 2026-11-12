import type { TempoPoint } from './model';

/** Seconds elapsed from quarter 0 to quarter q, following the tempo map; factor scales the tempo (0.5 = half speed). */
export function quarterToSeconds(map: TempoPoint[], q: number, factor = 1): number {
  let t = 0;
  for (let i = 0; i < map.length; i++) {
    const from = map[i].onset;
    const to = i + 1 < map.length ? map[i + 1].onset : Infinity;
    if (q <= from) break;
    const span = Math.min(q, to) - from;
    t += (span * 60) / (map[i].bpm * factor);
  }
  return t;
}

export function secondsToQuarter(map: TempoPoint[], sec: number, factor = 1): number {
  let t = 0;
  for (let i = 0; i < map.length; i++) {
    const from = map[i].onset;
    const to = i + 1 < map.length ? map[i + 1].onset : Infinity;
    const secPerQ = 60 / (map[i].bpm * factor);
    const segDur = (to - from) * secPerQ;
    if (sec <= t + segDur) return from + (sec - t) / secPerQ;
    t += segDur;
  }
  return map.length ? map[map.length - 1].onset : 0;
}

export function tempoAt(map: TempoPoint[], q: number): number {
  let bpm = map[0]?.bpm ?? 90;
  for (const p of map) if (p.onset <= q + 1e-9) bpm = p.bpm;
  return bpm;
}
