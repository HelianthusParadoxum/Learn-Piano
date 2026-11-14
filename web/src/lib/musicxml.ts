import { strFromU8, unzipSync } from 'fflate';
import { fingerLabel } from './fingering';
import {
  EPS,
  type Hand,
  type MeasureInfo,
  type NoteEvent,
  type Score,
  type StaffInfo,
  type TempoPoint,
} from './model';

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const DYNAMICS: Record<string, number> = {
  pppp: 0.25, ppp: 0.3, pp: 0.4, p: 0.5, mp: 0.6, mf: 0.7, f: 0.82, ff: 0.92, fff: 1, ffff: 1,
  sf: 0.85, sfz: 0.88, sffz: 0.92, fz: 0.85, rf: 0.8, rfz: 0.82, fp: 0.75, sfp: 0.75,
};

const BEAT_UNITS: Record<string, number> = {
  breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125,
};

export const DEFAULT_TEMPO = 90;

/* ------------------------------------------------------------------ */
/* File loading                                                        */
/* ------------------------------------------------------------------ */

/** Returns MusicXML text from raw file bytes (.musicxml/.xml or compressed .mxl). */
export function musicXmlFromBytes(bytes: Uint8Array, filename = ''): string {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    return decodeText(bytes);
  }
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  let rootPath: string | undefined;
  const container = files['META-INF/container.xml'];
  if (container) {
    const m = /full-path="([^"]+)"/.exec(strFromU8(container));
    if (m && files[m[1]]) rootPath = m[1];
  }
  if (!rootPath) {
    rootPath = names.find(
      (n) => !n.startsWith('META-INF') && !n.startsWith('__MACOSX') && /\.(xml|musicxml)$/i.test(n),
    );
  }
  if (!rootPath) throw new Error(`В архиве ${filename || '.mxl'} не найден файл MusicXML`);
  return decodeText(files[rootPath]);
}

function decodeText(bytes: Uint8Array): string {
  // UTF-16 BOM support (some editors export UTF-16 MusicXML)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

export function parseXmlDocument(xml: string): XMLDocument {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Файл не является корректным MusicXML: ' + (err.textContent || '').slice(0, 200));
  const root = doc.documentElement;
  if (root.tagName === 'score-timewise') return timewiseToPartwise(doc);
  if (root.tagName !== 'score-partwise') {
    throw new Error('Неизвестный формат: ожидается MusicXML (score-partwise)');
  }
  return doc;
}

/** Minimal score-timewise → score-partwise conversion. */
function timewiseToPartwise(doc: XMLDocument): XMLDocument {
  const src = doc.documentElement;
  const out = document.implementation.createDocument(null, 'score-partwise', null);
  const root = out.documentElement;
  for (const attr of Array.from(src.attributes)) root.setAttribute(attr.name, attr.value);
  const parts = new Map<string, Element>();
  for (const child of Array.from(src.children)) {
    if (child.tagName !== 'measure') {
      root.appendChild(out.importNode(child, true));
      continue;
    }
    for (const partEl of Array.from(child.children)) {
      if (partEl.tagName !== 'part') continue;
      const id = partEl.getAttribute('id') || 'P1';
      let p = parts.get(id);
      if (!p) {
        p = out.createElement('part');
        p.setAttribute('id', id);
        parts.set(id, p);
        root.appendChild(p);
      }
      const m = out.createElement('measure');
      for (const attr of Array.from(child.attributes)) m.setAttribute(attr.name, attr.value);
      for (const c of Array.from(partEl.childNodes)) m.appendChild(out.importNode(c, true));
      p.appendChild(m);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function child(el: Element, tag: string): Element | undefined {
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return undefined;
}

function children(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

function textOf(el: Element | undefined, tag?: string): string | undefined {
  if (!el) return undefined;
  const target = tag ? child(el, tag) : el;
  const t = target?.textContent?.trim();
  return t ? t : undefined;
}

function numOf(el: Element | undefined, tag?: string): number | undefined {
  const t = textOf(el, tag);
  if (t === undefined) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function parseBeats(text: string | undefined): number | undefined {
  if (!text) return undefined;
  // composite meters like "3+2"
  const parts = text.split('+').map((s) => Number(s.trim()));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts.reduce((a, b) => a + b, 0);
}

export function pitchToMidi(step: string, alter: number, octave: number): number {
  return (octave + 1) * 12 + (STEP_SEMITONES[step] ?? 0) + Math.round(alter);
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

interface MeasureAttrs {
  beats: number;
  beatType: number;
  fifths: number;
  timeChange: boolean;
  keyChange: boolean;
}

export function parseScore(xml: string, fallbackTitle = ''): Score {
  const doc = parseXmlDocument(xml);
  return parseScoreDocument(doc, fallbackTitle);
}

export function parseScoreDocument(doc: XMLDocument, fallbackTitle = ''): Score {
  const root = doc.documentElement;
  const partEls = children(root, 'part');
  if (partEls.length === 0) throw new Error('В файле нет ни одной партии (part)');

  // document-order index of every <note> element (used to inject fingering into a clone)
  const allNoteEls = Array.from(doc.getElementsByTagName('note'));
  const noteIndex = new Map<Element, number>();
  allNoteEls.forEach((el, i) => noteIndex.set(el, i));

  const partNames = new Map<string, string>();
  const partList = child(root, 'part-list');
  if (partList) {
    for (const sp of children(partList, 'score-part')) {
      partNames.set(sp.getAttribute('id') || '', textOf(sp, 'part-name') || '');
    }
  }

  const measureCount = Math.max(...partEls.map((p) => children(p, 'measure').length));

  /* ---------- pass 1: measure lengths & attributes ---------- */
  const actualLen = new Array<number>(measureCount).fill(0);
  const attrs: MeasureAttrs[] = [];
  const stavesPerPart: number[] = [];
  const clefs = new Map<string, string>(); // `${part}:${staff}` → clef sign at start

  partEls.forEach((partEl, pi) => {
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let fifths = 0;
    let staves = 1;
    const measures = children(partEl, 'measure');
    measures.forEach((m, mi) => {
      let pos = 0;
      let maxPos = 0;
      let lastStart = 0;
      let timeChange = false;
      let keyChange = false;
      for (const c of Array.from(m.children)) {
        switch (c.tagName) {
          case 'attributes': {
            divisions = numOf(c, 'divisions') ?? divisions;
            const time = child(c, 'time');
            if (time) {
              const b = parseBeats(textOf(time, 'beats'));
              const bt = numOf(time, 'beat-type');
              if (b && bt) {
                if (mi > 0 && (b !== beats || bt !== beatType)) timeChange = true;
                beats = b;
                beatType = bt;
              }
            }
            const key = child(c, 'key');
            if (key) {
              const f = numOf(key, 'fifths');
              if (f !== undefined) {
                if (mi > 0 && f !== fifths) keyChange = true;
                fifths = f;
              }
            }
            staves = numOf(c, 'staves') ?? staves;
            for (const cl of children(c, 'clef')) {
              const num = cl.getAttribute('number') || '1';
              const k = `${pi}:${num}`;
              if (!clefs.has(k)) clefs.set(k, textOf(cl, 'sign') || 'G');
            }
            break;
          }
          case 'note': {
            if (child(c, 'grace') || child(c, 'cue')) break;
            const dur = numOf(c, 'duration') ?? 0;
            if (child(c, 'chord')) {
              maxPos = Math.max(maxPos, lastStart + dur);
            } else {
              lastStart = pos;
              pos += dur;
              maxPos = Math.max(maxPos, pos);
            }
            break;
          }
          case 'backup':
            pos = Math.max(0, pos - (numOf(c, 'duration') ?? 0));
            break;
          case 'forward':
            pos += numOf(c, 'duration') ?? 0;
            maxPos = Math.max(maxPos, pos);
            break;
        }
      }
      actualLen[mi] = Math.max(actualLen[mi], maxPos / divisions);
      if (pi === 0 || !attrs[mi]) {
        attrs[mi] = { beats, beatType, fifths, timeChange, keyChange };
      }
    });
    stavesPerPart[pi] = staves;
  });

  // fill attrs for measures missing in the first part
  for (let i = 0; i < measureCount; i++) {
    if (!attrs[i]) attrs[i] = attrs[i - 1] ?? { beats: 4, beatType: 4, fifths: 0, timeChange: false, keyChange: false };
  }

  const staffOffset: number[] = [];
  let acc = 0;
  for (let pi = 0; pi < partEls.length; pi++) {
    staffOffset[pi] = acc;
    acc += stavesPerPart[pi] || 1;
  }

  const firstPartMeasures = children(partEls[0], 'measure');
  const measures: MeasureInfo[] = [];
  let start = 0;
  for (let i = 0; i < measureCount; i++) {
    const a = attrs[i];
    const nominal = (a.beats * 4) / a.beatType;
    const mEl = firstPartMeasures[i];
    const implicit = mEl?.getAttribute('implicit') === 'yes';
    let length = actualLen[i];
    if (length <= EPS) length = nominal;
    else if (length < nominal - EPS && !implicit && i > 0 && i < measureCount - 1) length = nominal;
    measures.push({
      index: i,
      number: mEl?.getAttribute('number') || String(i + 1),
      start,
      length,
      nominalLength: nominal,
      beats: a.beats,
      beatType: a.beatType,
      fifths: a.fifths,
      implicit: implicit || (i === 0 && length < nominal - EPS),
      repeatForward: false,
      repeatBackward: false,
      endingStop: false,
      newSystem: false,
      newPage: false,
      timeChange: a.timeChange,
      keyChange: a.keyChange,
    });
    start += length;
  }
  const totalLength = start;

  /* ---------- pass 2: notes, directions, barlines ---------- */
  const notes: NoteEvent[] = [];
  const tempoMap: TempoPoint[] = [];
  const openTies = new Map<string, NoteEvent>();

  partEls.forEach((partEl, pi) => {
    let divisions = 1;
    let velocity = 0.7;
    const mEls = children(partEl, 'measure');
    mEls.forEach((m, mi) => {
      const minfo = measures[mi];
      let pos = 0;
      let lastStart = 0;
      const graceQueue: NoteEvent[] = [];
      for (const c of Array.from(m.children)) {
        switch (c.tagName) {
          case 'attributes':
            divisions = numOf(c, 'divisions') ?? divisions;
            break;
          case 'backup':
            pos = Math.max(0, pos - (numOf(c, 'duration') ?? 0));
            break;
          case 'forward':
            pos += numOf(c, 'duration') ?? 0;
            break;
          case 'print':
            if (pi === 0) {
              if (c.getAttribute('new-system') === 'yes') minfo.newSystem = true;
              if (c.getAttribute('new-page') === 'yes') minfo.newPage = true;
            }
            break;
          case 'barline': {
            const loc = c.getAttribute('location') || 'right';
            const rep = child(c, 'repeat');
            if (rep) {
              const dir = rep.getAttribute('direction');
              if (dir === 'forward') minfo.repeatForward = true;
              if (dir === 'backward') minfo.repeatBackward = true;
            }
            const style = textOf(c, 'bar-style');
            if (style && loc === 'right') minfo.barStyleRight = style;
            const ending = child(c, 'ending');
            if (ending) {
              const type = ending.getAttribute('type');
              if (type === 'start') minfo.endingStart = ending.getAttribute('number') || '1';
              else minfo.endingStop = true;
            }
            break;
          }
          case 'sound': {
            const t = Number(c.getAttribute('tempo'));
            if (t > 0) addTempo(tempoMap, minfo.start + pos / divisions, t);
            break;
          }
          case 'direction': {
            const onsetHere = minfo.start + pos / divisions;
            for (const dt of children(c, 'direction-type')) {
              const reh = child(dt, 'rehearsal');
              if (reh && pi === 0 && reh.textContent?.trim()) minfo.rehearsal = reh.textContent.trim();
              const dyn = child(dt, 'dynamics');
              if (dyn) {
                const first = dyn.children[0];
                if (first && DYNAMICS[first.tagName] !== undefined) velocity = DYNAMICS[first.tagName];
              }
              const metro = child(dt, 'metronome');
              if (metro) {
                const unit = BEAT_UNITS[textOf(metro, 'beat-unit') || 'quarter'] ?? 1;
                const dotted = !!child(metro, 'beat-unit-dot');
                const perMin = numOf(metro, 'per-minute');
                if (perMin && perMin > 0) addTempo(tempoMap, onsetHere, perMin * unit * (dotted ? 1.5 : 1), true);
              }
            }
            const snd = child(c, 'sound');
            if (snd) {
              const t = Number(snd.getAttribute('tempo'));
              if (t > 0) addTempo(tempoMap, onsetHere, t);
              const d = Number(snd.getAttribute('dynamics'));
              if (d > 0) velocity = Math.min(1, Math.max(0.2, (d / 100) * 0.8));
            }
            break;
          }
          case 'note': {
            const isGrace = !!child(c, 'grace');
            const isChord = !!child(c, 'chord');
            if (child(c, 'cue')) break;
            const dur = (numOf(c, 'duration') ?? 0) / divisions;
            let onsetInMeasure: number;
            if (isGrace) onsetInMeasure = pos / divisions;
            else if (isChord) onsetInMeasure = lastStart / divisions;
            else {
              lastStart = pos;
              onsetInMeasure = pos / divisions;
              pos += (numOf(c, 'duration') ?? 0);
            }
            const pitchEl = child(c, 'pitch');
            if (!pitchEl || child(c, 'rest')) break; // rests & unpitched
            const step = textOf(pitchEl, 'step') || 'C';
            const alter = numOf(pitchEl, 'alter') ?? 0;
            const octave = numOf(pitchEl, 'octave') ?? 4;
            const midi = pitchToMidi(step, alter, octave);
            const staff = numOf(c, 'staff') ?? 1;
            const voice = textOf(c, 'voice') || '1';
            const onset = minfo.start + onsetInMeasure;
            const xmlIndex = noteIndex.get(c) ?? -1;

            const tieTypes = children(c, 'tie').map((t) => t.getAttribute('type'));
            const notations = child(c, 'notations');
            if (notations) {
              for (const t of children(notations, 'tied')) {
                const type = t.getAttribute('type');
                if (type && !tieTypes.includes(type)) tieTypes.push(type);
              }
            }
            const tieStop = tieTypes.includes('stop');
            const tieStart = tieTypes.includes('start');

            if (tieStop && !isGrace) {
              const k1 = `${pi}|${staff}|${midi}`;
              const k2 = `${pi}|*|${midi}`;
              const head = openTies.get(k1) ?? openTies.get(k2);
              if (head && Math.abs(head.onset + head.duration - onset) < 0.26) {
                head.duration = Math.max(head.duration, onset + dur - head.onset);
                head.tieContinuations.push({ xmlIndex, measureIndex: mi, onsetInMeasure, onset });
                if (!tieStart) {
                  openTies.delete(`${pi}|${head.staff}|${midi}`);
                  openTies.delete(k2);
                }
                break;
              }
            }

            let scoreFinger: number | undefined;
            if (notations) {
              const tech = child(notations, 'technical');
              const fing = tech ? child(tech, 'fingering') : undefined;
              const m = fing?.textContent?.match(/[1-5]/);
              if (m) scoreFinger = Number(m[0]);
            }

            const ev: NoteEvent = {
              id: notes.length,
              midi,
              step,
              alter,
              octave,
              onset,
              duration: isGrace ? 0.125 : Math.max(dur, 0.05),
              measureIndex: mi,
              onsetInMeasure,
              partIndex: pi,
              staff,
              staffIndex: staffOffset[pi] + staff - 1,
              voice,
              hand: null,
              grace: isGrace,
              velocity,
              xmlIndex,
              tieContinuations: [],
              scoreFinger,
              key: `${pi}:${mi}:${staff}:${voice}:${Math.round(onsetInMeasure * 1000)}:${midi}${isGrace ? 'g' : ''}`,
              dotted: !!child(c, 'dot'),
              tuplet: !!child(c, 'time-modification'),
              accidental: textOf(c, 'accidental'),
            };
            if (isGrace) {
              graceQueue.push(ev);
            } else {
              // grace notes are played just before the main note
              if (graceQueue.length) {
                const g = graceQueue.splice(0);
                g.forEach((gn, i) => {
                  gn.onset = onset - 0.125 * (g.length - i);
                  if (gn.onset < 0) gn.onset = 0;
                });
              }
            }
            notes.push(ev);
            if (tieStart && !isGrace) {
              openTies.set(`${pi}|${staff}|${midi}`, ev);
              openTies.set(`${pi}|*|${midi}`, ev);
            }
            break;
          }
        }
      }
    });
  });

  notes.sort((a, b) => a.onset - b.onset || a.staffIndex - b.staffIndex || a.midi - b.midi);
  notes.forEach((n, i) => (n.id = i));

  // tempo
  tempoMap.sort((a, b) => a.onset - b.onset);
  const tempoFromFile = tempoMap.length > 0;
  if (!tempoFromFile || tempoMap[0].onset > EPS) {
    tempoMap.unshift({ onset: 0, bpm: tempoFromFile ? tempoMap[0].bpm : DEFAULT_TEMPO });
  }
  dedupeTempo(tempoMap);

  /* ---------- staves & hands ---------- */
  const staves: StaffInfo[] = [];
  partEls.forEach((partEl, pi) => {
    const id = partEl.getAttribute('id') || '';
    for (let s = 1; s <= (stavesPerPart[pi] || 1); s++) {
      const sn = notes.filter((n) => n.partIndex === pi && n.staff === s);
      staves.push({
        partIndex: pi,
        staff: s,
        staffIndex: staffOffset[pi] + s - 1,
        clef: clefs.get(`${pi}:${s}`) || (s === 2 ? 'F' : 'G'),
        hand: null,
        partName: partNames.get(id) || '',
        noteCount: sn.length,
        meanPitch: sn.length ? sn.reduce((a, n) => a + n.midi, 0) / sn.length : 60,
      });
    }
  });
  assignHands(staves, stavesPerPart);
  const handOf = new Map(staves.map((s) => [s.staffIndex, s.hand]));
  for (const n of notes) n.hand = handOf.get(n.staffIndex) ?? null;

  return {
    title: extractTitle(root) || fallbackTitle || 'Без названия',
    composer: extractComposer(root),
    rights: extractRights(root),
    measures,
    notes,
    staves,
    tempoMap,
    tempoFromFile,
    totalLength,
    partCount: partEls.length,
    doc,
  };
}

function addTempo(map: TempoPoint[], onset: number, bpm: number, weak = false) {
  const existing = map.find((t) => Math.abs(t.onset - onset) < EPS);
  if (existing) {
    if (!weak) existing.bpm = bpm;
    return;
  }
  map.push({ onset, bpm: Math.min(400, Math.max(20, bpm)) });
}

function dedupeTempo(map: TempoPoint[]) {
  for (let i = map.length - 1; i > 0; i--) {
    if (Math.abs(map[i].bpm - map[i - 1].bpm) < 0.01) map.splice(i, 1);
  }
}

/** Decides which staves are played by the right and the left hand. */
export function assignHands(staves: StaffInfo[], stavesPerPart: number[]) {
  const withNotes = staves.filter((s) => s.noteCount > 0);
  const pianoPart = stavesPerPart.findIndex((n) => n >= 2);
  if (pianoPart >= 0) {
    for (const s of staves) {
      if (s.partIndex !== pianoPart) continue;
      if (s.staff === 1) s.hand = 'R';
      else if (s.staff === 2) s.hand = 'L';
    }
    return;
  }
  if (withNotes.length === 1) {
    withNotes[0].hand = withNotes[0].clef === 'F' ? 'L' : 'R';
    return;
  }
  if (withNotes.length === 2) {
    const [a, b] = withNotes;
    const [hi, lo] = a.meanPitch >= b.meanPitch ? [a, b] : [b, a];
    hi.hand = 'R';
    lo.hand = 'L';
    return;
  }
  // several single-staff parts: take the last treble+bass pair (typical "voice + piano" layout)
  for (let i = withNotes.length - 2; i >= 0; i--) {
    if (withNotes[i].clef !== 'F' && withNotes[i + 1].clef === 'F') {
      withNotes[i].hand = 'R';
      withNotes[i + 1].hand = 'L';
      return;
    }
  }
  for (const s of withNotes) s.hand = (s.clef === 'F' ? 'L' : 'R') as Hand;
}

function extractTitle(root: Element): string {
  const work = child(root, 'work');
  const wt = textOf(work, 'work-title');
  const mt = textOf(root, 'movement-title');
  let creditTitle: string | undefined;
  let bestSize = 0;
  for (const credit of children(root, 'credit')) {
    const type = textOf(credit, 'credit-type');
    for (const cw of children(credit, 'credit-words')) {
      const txt = cw.textContent?.trim();
      if (!txt) continue;
      if (type === 'title') return txt;
      const size = Number(cw.getAttribute('font-size')) || 0;
      if (!type && size > bestSize && txt.length < 80) {
        bestSize = size;
        creditTitle = txt;
      }
    }
  }
  const candidates = [wt, mt, creditTitle].filter(
    (t): t is string =>
      !!t &&
      !/^(untitled|unknown|title|score|без названия)(\.mvt\d+)?$/i.test(t) &&
      !/\.(pdf|xml|mxl|png|jpe?g|tiff?)$/i.test(t),
  );
  return candidates[0] || '';
}

function extractRights(root: Element): string | undefined {
  const ident = child(root, 'identification');
  const text = ident
    ? children(ident, 'rights')
        .map((r) => r.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
    : '';
  return text || undefined;
}

function extractComposer(root: Element): string {
  const ident = child(root, 'identification');
  if (ident) {
    for (const cr of children(ident, 'creator')) {
      if (cr.getAttribute('type') === 'composer' && cr.textContent?.trim()) return cr.textContent.trim();
    }
  }
  for (const credit of children(root, 'credit')) {
    if (textOf(credit, 'credit-type') === 'composer') {
      const t = textOf(credit, 'credit-words');
      if (t) return t;
    }
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Fingering injection                                                 */
/* ------------------------------------------------------------------ */

export const NOTE_CHILD_ORDER = [
  'grace', 'cue', 'chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'instrument', 'voice', 'type',
  'dot', 'accidental', 'time-modification', 'stem', 'notehead', 'notehead-text', 'staff', 'beam', 'notations',
  'lyric', 'play', 'listen',
];

/**
 * Returns a copy of the document with <fingering> elements set for every note that has a finger.
 * Notes are matched by document order index. With `moveMarks` a finger that lands on another key than
 * the last time it was used gets a chevron after its number ("3›", "3‹"; "3»", "3«" for a move longer
 * than a tone: first which finger, then where it goes) — for display only: other programs expect plain
 * digits.
 */
export function withFingerings(doc: XMLDocument, notes: NoteEvent[], moveMarks = false): XMLDocument {
  const clone = doc.cloneNode(true) as XMLDocument;
  const els = Array.from(clone.getElementsByTagName('note'));
  for (const n of notes) {
    if (!n.finger || n.xmlIndex < 0) continue;
    const el = els[n.xmlIndex];
    if (!el) continue;
    const text = moveMarks ? fingerLabel(n) : String(n.finger);
    setFingering(clone, el, text, n.hand === 'L' ? 'below' : 'above');
  }
  return clone;
}

function setFingering(doc: XMLDocument, note: Element, finger: string, placement: string) {
  let notations = child(note, 'notations');
  if (!notations) {
    notations = doc.createElementNS(note.namespaceURI, 'notations');
    const idx = NOTE_CHILD_ORDER.indexOf('notations');
    const after = Array.from(note.children).find((c) => NOTE_CHILD_ORDER.indexOf(c.tagName) > idx);
    note.insertBefore(notations, after ?? null);
  }
  let technical = child(notations, 'technical');
  if (!technical) {
    technical = doc.createElementNS(note.namespaceURI, 'technical');
    notations.appendChild(technical);
  }
  let fing = child(technical, 'fingering');
  if (!fing) {
    fing = doc.createElementNS(note.namespaceURI, 'fingering');
    technical.appendChild(fing);
  }
  fing.textContent = finger;
  fing.setAttribute('placement', placement);
}

export function serializeXml(doc: XMLDocument): string {
  return new XMLSerializer().serializeToString(doc);
}
