/**
 * Web Audio playback: a sampled piano (Salamander Grand Piano, CC-BY 3.0 by Alexander Holm)
 * and a look-ahead scheduler that reports the playback position in quarter notes.
 */
import type { Hand, NoteEvent, Score } from './model';
import { quarterToSeconds, secondsToQuarter } from './timing';

const NOTE_INDEX: Record<string, number> = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };

interface Voice {
  src: AudioScheduledSourceNode;
  gain: GainNode;
  end: number;
}

export class PianoEngine {
  ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private sampleKeys: number[] = [];
  private loading: Promise<void> | null = null;
  private voices = new Set<Voice>();
  status: 'idle' | 'loading' | 'ready' | 'synth' = 'idle';

  ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctx: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.9;
      this.out.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  load(base = './piano/'): Promise<void> {
    if (this.loading) return this.loading;
    this.status = 'loading';
    this.loading = (async () => {
      const ctx = this.ensureContext();
      const names: string[] = await fetch(base + 'samples.json').then((r) => {
        if (!r.ok) throw new Error('samples.json ' + r.status);
        return r.json();
      });
      await Promise.all(
        names.map(async (name) => {
          const m = /^([A-G]s?)(\d)$/.exec(name);
          if (!m) return;
          const midi = (Number(m[2]) + 1) * 12 + NOTE_INDEX[m[1]];
          const data = await fetch(`${base}${name}.mp3`).then((r) => r.arrayBuffer());
          const buf = await ctx.decodeAudioData(data);
          this.buffers.set(midi, buf);
        }),
      );
      this.sampleKeys = Array.from(this.buffers.keys()).sort((a, b) => a - b);
      this.status = this.sampleKeys.length ? 'ready' : 'synth';
    })().catch((e) => {
      console.warn('Piano samples unavailable, using synth fallback', e);
      this.status = 'synth';
    });
    return this.loading;
  }

  private nearestSample(midi: number): number {
    let best = this.sampleKeys[0];
    for (const k of this.sampleKeys) if (Math.abs(k - midi) < Math.abs(best - midi)) best = k;
    return best;
  }

  /** Schedules a note at AudioContext time `when`. */
  playNote(midi: number, when: number, duration: number, velocity = 0.7, gain = 1) {
    const ctx = this.ensureContext();
    if (!this.out) return;
    const level = Math.pow(Math.max(0.05, Math.min(1, velocity)), 1.5) * gain * 1.1;
    const g = ctx.createGain();
    const off = when + Math.max(0.09, duration);
    let src: AudioScheduledSourceNode;
    if (this.sampleKeys.length) {
      const sm = this.nearestSample(midi);
      const s = ctx.createBufferSource();
      s.buffer = this.buffers.get(sm)!;
      s.playbackRate.value = Math.pow(2, (midi - sm) / 12);
      g.gain.setValueAtTime(level, when);
      g.gain.setValueAtTime(level, off);
      g.gain.setTargetAtTime(0, off, 0.09);
      src = s;
    } else {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(level * 0.45, when + 0.006);
      g.gain.setTargetAtTime(level * 0.12, when + 0.01, 0.35);
      g.gain.setValueAtTime(level * 0.12, off);
      g.gain.setTargetAtTime(0, off, 0.06);
      src = o;
    }
    src.connect(g).connect(this.out);
    src.start(when);
    const end = off + 0.8;
    src.stop(end);
    const voice: Voice = { src, gain: g, end };
    this.voices.add(voice);
    src.onended = () => {
      this.voices.delete(voice);
      g.disconnect();
    };
  }

  /** Metronome click. */
  click(when: number, accent: boolean) {
    const ctx = this.ensureContext();
    if (!this.out) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.22 : 0.13, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(this.out);
    o.start(when);
    o.stop(when + 0.06);
  }

  /** Quickly silences everything that is scheduled or sounding. */
  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setTargetAtTime(0, t, 0.02);
        v.src.stop(t + 0.15);
      } catch {
        /* already stopped */
      }
    }
    this.voices.clear();
  }
}

export type HandMode = 'on' | 'quiet' | 'off';

export interface PlaybackOptions {
  /** Range in quarter notes. */
  from: number;
  to: number;
  /** Position to start from (defaults to `from`). */
  startAt?: number;
  hands: Record<Hand, HandMode>;
  tempoFactor: number;
  loop: boolean;
  metronome: boolean;
  countIn: boolean;
}

export interface PlayerState {
  playing: boolean;
  /** Current position in quarter notes (null when idle or during the count-in). */
  position: number | null;
  countingIn: boolean;
  /** Count-in beat number (1-based) while counting in. */
  countBeat: number;
  from: number;
  to: number;
  pass: number;
}

interface ScheduledItem {
  time: number;
  kind: 'note' | 'click';
  midi?: number;
  dur?: number;
  vel?: number;
  gain?: number;
  accent?: boolean;
}

interface Pass {
  base: number; // ctx time at which `startQ` sounds
  startQ: number;
  endQ: number;
  items: ScheduledItem[];
  next: number;
  endTime: number;
}

const HAND_GAIN: Record<HandMode, number> = { on: 1, quiet: 0.22, off: 0 };
const LOOK_AHEAD = 0.15;
const LOOP_GAP = 0.5;

export class Player {
  private listeners = new Set<() => void>();
  private state: PlayerState = { playing: false, position: null, countingIn: false, countBeat: 0, from: 0, to: 0, pass: 0 };
  private timer: number | null = null;
  private raf: number | null = null;
  private passes: Pass[] = [];
  private opts: PlaybackOptions | null = null;
  private score: Score | null = null;
  private countInEnd = 0;
  private countInBeats: { time: number }[] = [];

  constructor(readonly engine: PianoEngine) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get playing() {
    return this.state.playing;
  }

  async play(score: Score, opts: PlaybackOptions) {
    this.stop(false);
    const engine = this.engine;
    const ctx = engine.ensureContext();
    if (engine.status === 'idle' || engine.status === 'loading') {
      this.set({ playing: true, position: opts.startAt ?? opts.from, countingIn: false, from: opts.from, to: opts.to });
      await engine.load();
      if (!this.state.playing) return; // stopped while loading
    }
    this.score = score;
    this.opts = opts;
    const startQ = Math.min(Math.max(opts.startAt ?? opts.from, opts.from), opts.to - 1e-3);
    let t0 = ctx.currentTime + 0.12;
    this.countInBeats = [];
    if (opts.countIn) {
      const m = measureAt(score, startQ);
      const beatQ = 4 / m.beatType;
      const beats = Math.max(1, Math.round(m.nominalLength / beatQ));
      const secPerBeat = quarterToSeconds(score.tempoMap, startQ + beatQ, opts.tempoFactor) -
        quarterToSeconds(score.tempoMap, startQ, opts.tempoFactor);
      for (let i = 0; i < beats; i++) {
        const time = t0 + i * secPerBeat;
        engine.click(time, i === 0);
        this.countInBeats.push({ time });
      }
      t0 += beats * secPerBeat;
    }
    this.countInEnd = t0;
    this.passes = [this.buildPass(t0, startQ, opts.to)];
    this.set({ playing: true, position: startQ, countingIn: opts.countIn, countBeat: 0, from: opts.from, to: opts.to, pass: 0 });
    this.timer = window.setInterval(this.tick, 25);
    this.tick();
    const frame = () => {
      this.updatePosition();
      if (this.state.playing) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private buildPass(base: number, startQ: number, endQ: number): Pass {
    const score = this.score!;
    const opts = this.opts!;
    const f = opts.tempoFactor;
    const map = score.tempoMap;
    const s0 = quarterToSeconds(map, startQ, f);
    const items: ScheduledItem[] = [];
    for (const n of score.notes) {
      if (n.onset < startQ - 1e-6 || n.onset >= endQ - 1e-6) continue;
      const gain = noteGain(n, opts.hands);
      if (gain <= 0) continue;
      const time = base + quarterToSeconds(map, n.onset, f) - s0;
      const endOn = Math.min(n.onset + n.duration, endQ);
      const dur = quarterToSeconds(map, endOn, f) - quarterToSeconds(map, n.onset, f);
      items.push({ time, kind: 'note', midi: n.midi, dur: Math.max(0.05, dur * 0.97), vel: n.velocity, gain });
    }
    if (opts.metronome) {
      for (const m of score.measures) {
        if (m.start + m.length <= startQ || m.start >= endQ) continue;
        const beatQ = 4 / m.beatType;
        for (let q = m.start, i = 0; q < m.start + m.length - 1e-6; q += beatQ, i++) {
          if (q < startQ - 1e-6 || q >= endQ - 1e-6) continue;
          items.push({ time: base + quarterToSeconds(map, q, f) - s0, kind: 'click', accent: i === 0 });
        }
      }
    }
    items.sort((a, b) => a.time - b.time);
    const endTime = base + quarterToSeconds(map, endQ, f) - s0;
    return { base, startQ, endQ, items, next: 0, endTime };
  }

  private tick = () => {
    const ctx = this.engine.ctx;
    if (!ctx || !this.opts) return;
    const horizon = ctx.currentTime + LOOK_AHEAD;
    let pass = this.passes[this.passes.length - 1];
    while (pass && pass.next < pass.items.length && pass.items[pass.next].time < horizon) {
      const it = pass.items[pass.next++];
      if (it.kind === 'note') this.engine.playNote(it.midi!, it.time, it.dur!, it.vel, it.gain);
      else this.engine.click(it.time, !!it.accent);
    }
    if (pass && pass.next >= pass.items.length && this.opts.loop && pass.endTime < horizon + 0.5 && this.passes.length < 10_000) {
      const nextPass = this.buildPass(pass.endTime + LOOP_GAP, this.opts.from, this.opts.to);
      this.passes.push(nextPass);
      if (this.passes.length > 3) this.passes.shift();
      pass = nextPass;
    }
  };

  private updatePosition() {
    const ctx = this.engine.ctx;
    if (!ctx || !this.opts || !this.score) return;
    const now = ctx.currentTime;
    if (now < this.countInEnd) {
      let beat = 0;
      for (let i = 0; i < this.countInBeats.length; i++) if (now >= this.countInBeats[i].time) beat = i + 1;
      if (beat !== this.state.countBeat || !this.state.countingIn) this.set({ countingIn: true, countBeat: beat, position: null });
      return;
    }
    // find the pass that is currently sounding
    let current: Pass | undefined;
    for (const p of this.passes) if (now >= p.base - 1e-3) current = p;
    if (!current) return;
    if (now > current.endTime) {
      if (!this.opts.loop) {
        if (now > current.endTime + 0.25) this.stop(true);
        return;
      }
      // in the gap between two passes: show the start
      this.set({ position: this.opts.from, countingIn: false });
      return;
    }
    const map = this.score.tempoMap;
    const f = this.opts.tempoFactor;
    const q = secondsToQuarter(map, quarterToSeconds(map, current.startQ, f) + (now - current.base), f);
    this.set({ position: q, countingIn: false, pass: this.passes.indexOf(current) });
  }

  /** Stops playback. When `natural` is true the position is reset to the start of the range. */
  stop(natural = false) {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.timer = null;
    this.raf = null;
    this.engine.silence();
    this.passes = [];
    const wasPlaying = this.state.playing;
    if (wasPlaying || this.state.countingIn) {
      this.set({ playing: false, countingIn: false, countBeat: 0, position: natural ? null : this.state.position });
    }
  }

  /** Plays a single chord/note immediately (used for "step" mode and clicks on keys). */
  async preview(notes: { midi: number; velocity?: number }[], duration = 0.9) {
    const engine = this.engine;
    const ctx = engine.ensureContext();
    if (engine.status === 'idle' || engine.status === 'loading') await engine.load();
    const t = ctx.currentTime + 0.02;
    for (const n of notes) engine.playNote(n.midi, t, duration, n.velocity ?? 0.7, 1);
  }
}

function noteGain(n: NoteEvent, hands: Record<Hand, HandMode>): number {
  if (n.hand) return HAND_GAIN[hands[n.hand]];
  // parts that are not played by the pianist (e.g. a vocal line) accompany softly when both hands are on
  return hands.R === 'on' && hands.L === 'on' ? 0.45 : 0;
}

function measureAt(score: Score, q: number) {
  let m = score.measures[0];
  for (const x of score.measures) if (x.start <= q + 1e-6) m = x;
  return m;
}

export const pianoEngine = new PianoEngine();
export const player = new Player(pianoEngine);
