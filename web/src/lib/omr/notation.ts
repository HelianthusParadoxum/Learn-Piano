/**
 * Compact text notation used for transcriptions made by Claude, and its conversion to MusicXML.
 *
 * A measure lists, for each hand, events in time order separated by spaces. Event = NOTES ":" DURATION
 *   NOTES     C4 · F#5 · Bb3 · chord C4+E4+G4 · rest r            (scientific octaves, middle C = C4)
 *             a pitch may carry a printed fingering: E5@3
 *   DURATION  w h q e s t (whole … 32nd) or 1 2 4 8 16 32, then "." / ".." for dots, "T" for triplets,
 *             "m" = whole-measure rest; a trailing "~" ties the notes to the next event
 * Example:   "D5:q G4:e A4:e B4:e C5:e"    "G3+B3+D4:h A3:q"    "C5:h.~"   "r:m"
 */

export interface TranscribedMeasure {
  rh?: string | string[];
  lh?: string | string[];
  key?: number;
  time?: string;
}

export interface Transcription {
  title?: string;
  composer?: string;
  keyFifths?: number;
  time?: string;
  tempo?: number | null;
  staves?: number;
  clef?: string;
  measures: TranscribedMeasure[];
}

interface Pitch {
  step: string;
  alter: number;
  octave: number;
  finger?: number;
}

export interface Token {
  rest: boolean;
  measureRest: boolean;
  pitches: Pitch[];
  /** duration in quarters */
  quarters: number;
  type: string;
  dots: number;
  triplet: boolean;
  tie: boolean;
}

const DIV = 48; // divisions per quarter: handles 32nds, triplets and dots

const LETTER: Record<string, [string, number]> = {
  w: ['whole', 4],
  h: ['half', 2],
  q: ['quarter', 1],
  e: ['eighth', 0.5],
  s: ['16th', 0.25],
  t: ['32nd', 0.125],
  '1': ['whole', 4],
  '2': ['half', 2],
  '4': ['quarter', 1],
  '8': ['eighth', 0.5],
  '16': ['16th', 0.25],
  '32': ['32nd', 0.125],
};

const PITCH_RE = /^([A-G])(##|bb|#|b|x|n)?(-?\d)(?:@([1-5]))?$/;
const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function parsePitch(raw: string): Pitch | null {
  const s = raw.trim().replace(/♯/g, '#').replace(/♭/g, 'b').replace(/♮/g, 'n');
  const m = PITCH_RE.exec(s.charAt(0).toUpperCase() + s.slice(1));
  if (!m) return null;
  const acc = m[2] ?? '';
  const alter = acc === '#' ? 1 : acc === '##' || acc === 'x' ? 2 : acc === 'b' ? -1 : acc === 'bb' ? -2 : 0;
  return { step: m[1], alter, octave: Number(m[3]), finger: m[4] ? Number(m[4]) : undefined };
}

export function parseToken(raw: string): Token | null {
  const s = raw.trim();
  const colon = s.lastIndexOf(':');
  if (colon <= 0) return null;
  const notes = s.slice(0, colon);
  let dur = s.slice(colon + 1);
  let tie = false;
  if (dur.endsWith('~')) {
    tie = true;
    dur = dur.slice(0, -1);
  }
  if (/^m$/i.test(dur)) {
    return { rest: true, measureRest: true, pitches: [], quarters: 0, type: 'whole', dots: 0, triplet: false, tie: false };
  }
  const dm = /^(16|32|1|2|4|8|[whqestWHQEST])(\.{0,2})(T|t|3)?$/.exec(dur);
  if (!dm) return null;
  const [type, base] = LETTER[dm[1].toLowerCase()];
  const dots = dm[2].length;
  const triplet = !!dm[3];
  let quarters = base * (dots === 1 ? 1.5 : dots === 2 ? 1.75 : 1);
  if (triplet) quarters = (quarters * 2) / 3;
  if (/^[rR]$/.test(notes)) {
    return { rest: true, measureRest: false, pitches: [], quarters, type, dots, triplet, tie: false };
  }
  const pitches: Pitch[] = [];
  for (const p of notes.split('+')) {
    const pitch = parsePitch(p);
    if (!pitch) return null;
    pitches.push(pitch);
  }
  if (!pitches.length) return null;
  return { rest: false, measureRest: false, pitches, quarters, type, dots, triplet, tie };
}

function midiOf(p: Pitch) {
  return (p.octave + 1) * 12 + STEP_SEMI[p.step] + p.alter;
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function voicesOf(v: string | string[] | undefined): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function parseTime(t: string | undefined): [number, number] | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(t ?? '');
  if (!m) return null;
  const beats = Number(m[1]);
  const beatType = Number(m[2]);
  if (!beats || ![1, 2, 4, 8, 16, 32].includes(beatType)) return null;
  return [beats, beatType];
}

export interface ConversionResult {
  xml: string;
  measures: number;
  notes: number;
  warnings: string[];
}

/** Converts a transcription into MusicXML (one piano part, one or two staves). */
export function transcriptionToMusicXml(t: Transcription): ConversionResult {
  const warnings: string[] = [];
  const measuresIn = Array.isArray(t.measures) ? t.measures : [];
  if (!measuresIn.length) throw new Error('В ответе нет ни одного такта');
  const staves = t.staves === 1 ? 1 : 2;
  let [beats, beatType] = parseTime(t.time) ?? [4, 4];
  let fifths = Number.isFinite(Number(t.keyFifths)) ? Math.max(-7, Math.min(7, Math.round(Number(t.keyFifths)))) : 0;
  let notesCount = 0;
  let badTokens = 0;

  // pitches waiting for a tie stop, per staff/voice
  const pendingTies = new Map<string, Set<number>>();

  const singleClef = (() => {
    if (staves === 2) return 'G';
    if (/bass|f/i.test(t.clef ?? '')) return 'F';
    return 'G';
  })();

  const pickup = isPickup(measuresIn, beats, beatType);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<score-partwise version="4.0">');
  if (t.title) out.push(`<work><work-title>${esc(String(t.title))}</work-title></work>`);
  out.push('<identification>');
  if (t.composer) out.push(`<creator type="composer">${esc(String(t.composer))}</creator>`);
  out.push('<encoding><software>Learn Piano (Claude transcription)</software></encoding></identification>');
  out.push('<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>');
  out.push('<part id="P1">');

  measuresIn.forEach((m, mi) => {
    const parts: string[] = [];
    const attrs: string[] = [];
    const time = parseTime(m.time);
    const timeChanged = !!time && (time[0] !== beats || time[1] !== beatType);
    if (time) [beats, beatType] = time;
    const keyChanged = m.key !== undefined && Number.isFinite(Number(m.key)) && Math.round(Number(m.key)) !== fifths;
    if (keyChanged) fifths = Math.max(-7, Math.min(7, Math.round(Number(m.key))));
    if (mi === 0) attrs.push(`<divisions>${DIV}</divisions>`);
    if (mi === 0 || keyChanged) attrs.push(`<key><fifths>${fifths}</fifths></key>`);
    if (mi === 0 || timeChanged) attrs.push(`<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`);
    if (mi === 0) {
      attrs.push(`<staves>${staves}</staves>`);
      if (staves === 2) {
        attrs.push('<clef number="1"><sign>G</sign><line>2</line></clef>');
        attrs.push('<clef number="2"><sign>F</sign><line>4</line></clef>');
      } else {
        attrs.push(singleClef === 'F' ? '<clef><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>');
      }
    }
    if (attrs.length) parts.push(`<attributes>${attrs.join('')}</attributes>`);
    if (mi === 0 && t.tempo && Number(t.tempo) > 0) {
      const bpm = Math.round(Number(t.tempo));
      parts.push(
        `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${bpm}"/></direction>`,
      );
    }

    const measureLen = Math.round(((beats * 4) / beatType) * DIV);
    const hands: [number, string[]][] = [[1, voicesOf(m.rh)]];
    if (staves === 2) hands.push([2, voicesOf(m.lh)]);
    else if (!hands[0][1].length) hands[0][1] = voicesOf(m.lh);

    let pos = 0; // position (divisions) after the last written event
    for (const [staff, voices] of hands) {
      const list = voices.length ? voices : ['r:m'];
      list.forEach((voiceText, vi) => {
        const voice = staff === 1 ? String(vi + 1) : String(vi + 5);
        if (pos > 0) {
          parts.push(`<backup><duration>${pos}</duration></backup>`);
          pos = 0;
        }
        const tieKey = `${staff}:${vi}`;
        let pending = pendingTies.get(tieKey) ?? new Set<number>();
        let tupletOpen = 0; // accumulated duration of the open triplet group
        let tupletTarget = 0;
        const tokens = voiceText.split(/\s+/).filter(Boolean);
        tokens.forEach((raw, ti) => {
          const tok = parseToken(raw);
          if (!tok) {
            badTokens++;
            if (badTokens <= 5) warnings.push(`такт ${mi + 1}: не понял «${raw}»`);
            return;
          }
          const dur = tok.measureRest ? measureLen : Math.max(1, Math.round(tok.quarters * DIV));
          // triplet brackets
          let tupletXml = '';
          if (tok.triplet) {
            if (!tupletOpen) {
              tupletTarget = dur * 3;
              tupletXml = '<tuplet type="start" bracket="no"/>';
            }
            tupletOpen += dur;
            const next = tokens[ti + 1] ? parseToken(tokens[ti + 1]) : null;
            if (tupletOpen >= tupletTarget || !next?.triplet) {
              tupletXml += '<tuplet type="stop"/>';
              tupletOpen = 0;
            }
          } else {
            tupletOpen = 0;
          }
          const typeXml =
            `<type>${tok.type}</type>` +
            '<dot/>'.repeat(tok.dots) +
            (tok.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '');
          if (tok.rest) {
            parts.push(
              `<note>${tok.measureRest ? '<rest measure="yes"/>' : '<rest/>'}<duration>${dur}</duration><voice>${voice}</voice>${tok.measureRest ? '' : typeXml}<staff>${staff}</staff>${tupletXml ? `<notations>${tupletXml}</notations>` : ''}</note>`,
            );
            pending = new Set();
          } else {
            const nextPending = new Set<number>();
            tok.pitches.forEach((p, pi) => {
              const midi = midiOf(p);
              const stop = pending.has(midi);
              const start = tok.tie;
              if (start) nextPending.add(midi);
              const notations: string[] = [];
              if (stop) notations.push('<tied type="stop"/>');
              if (start) notations.push('<tied type="start"/>');
              if (p.finger) notations.push(`<technical><fingering>${p.finger}</fingering></technical>`);
              if (pi === 0 && tupletXml) notations.push(tupletXml);
              parts.push(
                '<note>' +
                  (pi > 0 ? '<chord/>' : '') +
                  `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch>` +
                  `<duration>${dur}</duration>` +
                  (stop ? '<tie type="stop"/>' : '') +
                  (start ? '<tie type="start"/>' : '') +
                  `<voice>${voice}</voice>${typeXml}<staff>${staff}</staff>` +
                  (notations.length ? `<notations>${notations.join('')}</notations>` : '') +
                  '</note>',
              );
              notesCount++;
            });
            pending = nextPending;
          }
          pos += dur;
        });
        pendingTies.set(tieKey, pending);
      });
    }
    const implicit = pickup && mi === 0;
    out.push(`<measure number="${pickup ? mi : mi + 1}"${implicit ? ' implicit="yes"' : ''}>`);
    out.push(...parts);
    out.push('</measure>');
  });

  out.push('</part></score-partwise>');
  if (badTokens > 5) warnings.push(`…и ещё ${badTokens - 5} непонятных фрагментов`);
  return { xml: out.join('\n'), measures: measuresIn.length, notes: notesCount, warnings };
}

/** True when the first measure is shorter than the time signature (anacrusis). */
function isPickup(measures: TranscribedMeasure[], beats: number, beatType: number): boolean {
  const first = measures[0];
  const len = (beats * 4) / beatType;
  const voiceLen = (v: string) =>
    v
      .split(/\s+/)
      .map(parseToken)
      .reduce((a, t) => a + (t ? (t.measureRest ? len : t.quarters) : 0), 0);
  const all = [...voicesOf(first.rh), ...voicesOf(first.lh)];
  if (!all.length) return false;
  const max = Math.max(...all.map(voiceLen));
  return max > 0 && max < len - 1e-6;
}
