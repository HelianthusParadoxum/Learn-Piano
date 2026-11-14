#!/usr/bin/env python3
"""
LilyPond -> MusicXML for the typeset piano editions of the Mutopia Project, keeping the edition's fingering.

It understands the part of LilyPond those sources use: variables, absolute and \\relative pitches, Dutch and
English note names, chords (also with a fingering per chord note), voices (<< { } \\\\ { } >>, \\new Voice),
tuplets (\\times, \\tuplet), grace notes, \\repeat volta with \\alternative (written once, with repeat signs and
endings) and \\repeat unfold, \\partial, key / time / clef changes, \\change Staff, tempo and fingerings (c-1,
c^2, c_3, <c-1 e-3>). Markup, dynamics, articulations, slurs, overrides and other layout commands are skipped.
Anything else stops the conversion with an error instead of guessing, and every bar check (|) of the source must
fall on a barline. Of several \\score blocks it takes the first printed one (with \\layout); --score Primo takes the
printed scores whose text contains "Primo" (one part of a piano duet), one after another.

usage: python3 scripts/ly2musicxml.py input.ly output.musicxml --title "..." --composer "..." [--rights "..."]
       [--source "..."] [--tempo 100] [--score Primo]
"""
from __future__ import annotations

import argparse
import math
import re
import sys
from dataclasses import dataclass, field
from fractions import Fraction as F
from xml.sax.saxutils import escape


class LyError(Exception):
    pass


# ---------------------------------------------------------------- tokens

@dataclass
class Tok:
    kind: str
    val: str
    pos: int


TOKEN_SPEC = [
    ('ws', r'\s+'),
    ('bcomment', r'%\{.*?%\}'),
    ('comment', r'%[^\n]*'),
    ('string', r'"(?:\\.|[^"\\])*"'),
    ('dbl', r'<<|>>'),
    ('voicesep', r'\\\\'),
    ('cmd', r'\\[a-zA-Z](?:[a-zA-Z_\-]*[a-zA-Z])?'),
    ('special', r'\\[<>!()\[\]~=+]'),
    ('number', r'\d+'),
    ('word', r'[a-zA-Z]+'),
    ('sym', r"[{}<>()\[\]~|=\-^_.'!,*/:?+@&;]"),
    ('other', r'.'),
]
MASTER = re.compile('|'.join(f'(?P<{k}>{p})' for k, p in TOKEN_SPEC), re.S)


def skip_scheme(src: str, i: int) -> int:
    """Index just after the Scheme datum that starts at src[i] (right after '#' or '$')."""
    n = len(src)
    if i < n and src[i] == '#':
        i += 1
    while i < n and src[i] in "'`,":
        i += 1
    if i < n and src[i] == '(':
        depth = 0
        while i < n:
            c = src[i]
            if c == '"':
                i += 1
                while i < n and src[i] != '"':
                    i += 2 if src[i] == '\\' else 1
            elif c == ';':
                while i < n and src[i] != '\n':
                    i += 1
            elif c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        raise LyError('unbalanced Scheme expression')
    if i < n and src[i] == '"':
        i += 1
        while i < n and src[i] != '"':
            i += 2 if src[i] == '\\' else 1
        return i + 1
    if i < n and src[i] == '{':
        j = src.find('#}', i)
        if j < 0:
            raise LyError('unterminated #{')
        return j + 2
    m = re.compile(r'[^\s(){}\[\]"]+').match(src, i)
    return m.end() if m else i


def tokenize(src: str) -> list[Tok]:
    toks: list[Tok] = []
    i, n = 0, len(src)
    while i < n:
        if src[i] in '#$':
            j = skip_scheme(src, i + 1)
            toks.append(Tok('scheme', src[i:j], i))
            i = j
            continue
        m = MASTER.match(src, i)
        assert m
        kind = m.lastgroup
        if kind not in ('ws', 'comment', 'bcomment'):
            toks.append(Tok(kind, m.group(), i))
        i = m.end()
    return toks


# ---------------------------------------------------------------- note names

STEPS = 'cdefgab'


def note_names(lang: str) -> dict[str, tuple[int, int]]:
    names: dict[str, tuple[int, int]] = {}
    for s, L in enumerate(STEPS):
        if lang == 'nederlands':
            names[L] = (s, 0)
            names[L + 'is'] = (s, 1)
            names[L + 'isis'] = (s, 2)
            names[L + 'es'] = (s, -1)
            names[L + 'eses'] = (s, -2)
        elif lang == 'english':
            names[L] = (s, 0)
            for suf, a in (('s', 1), ('sharp', 1), ('ss', 2), ('x', 2), ('sharpsharp', 2), ('f', -1), ('flat', -1),
                           ('ff', -2), ('flatflat', -2)):
                names[L + suf] = (s, a)
        else:
            raise LyError(f'note-name language {lang} is not supported')
    if lang == 'nederlands':
        names.update({'as': (5, -1), 'ases': (5, -2), 'es': (2, -1), 'eses': (2, -2)})
    return names


# ---------------------------------------------------------------- AST

@dataclass
class Dur:
    length: F  # in whole notes, multipliers included
    base: F  # 1 whole, 2 half, 4 quarter ... (1/2 for a breve)
    dots: int


@dataclass
class Pitch:
    step: int
    alter: int
    marks: int  # octave marks (' = +1, , = -1); resolved: MusicXML octave
    resolved: bool = False

    def dia(self) -> int:
        return self.marks * 7 + self.step

    def midi(self) -> int:
        return (self.marks + 1) * 12 + [0, 2, 4, 5, 7, 9, 11][self.step] + self.alter


@dataclass
class Post:
    fingers: list[int] = field(default_factory=list)
    tie: bool = False
    below: bool = False  # the (last) fingering was written below (_)
    # fingers written after a whole chord (<c e g>4-1): given to its notes once the pitches are known
    chord_fingers: list[int] = field(default_factory=list)


@dataclass
class Node:
    kind: str
    args: tuple = ()


DYNAMICS = {'ppppp', 'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'fffff', 'fp', 'sf', 'sff', 'sp',
            'spp', 'sfz', 'rfz', 'fz', 'sfp', 'cr', 'decr', 'cresc', 'dim', 'decresc', 'crescHairpin', 'espressivo',
            'n'}
ARTICULATIONS = {'staccato', 'staccatissimo', 'accent', 'marcato', 'tenuto', 'portato', 'fermata', 'shortfermata',
                 'longfermata', 'verylongfermata', 'trill', 'turn', 'reverseturn', 'mordent', 'prall', 'prallprall',
                 'upprall', 'downprall', 'lineprall', 'prallmordent', 'prallup', 'pralldown', 'upmordent',
                 'downmordent', 'upbow', 'downbow', 'flageolet', 'thumb', 'open', 'stopped', 'snappizzicato', 'segno',
                 'coda', 'varcoda', 'arpeggio', 'glissando', 'laissezVibrer', 'repeatTie', 'startTrillSpan',
                 'stopTrillSpan', 'sustainOn', 'sustainOff', 'sostenutoOn', 'sostenutoOff', 'unaCorda', 'treCorde',
                 'startTextSpan', 'stopTextSpan', 'startGroup', 'stopGroup', 'harmonic', 'halfopen', 'lheel',
                 'rheel', 'ltoe', 'rtoe', 'signumcongruentiae', 'tied', 'noBeam', 'sustainDown', 'sustainUp'}
# commands without arguments that only change the layout
TOGGLES = {'voiceOne', 'voiceTwo', 'voiceThree', 'voiceFour', 'oneVoice', 'stemUp', 'stemDown', 'stemNeutral',
           'slurUp', 'slurDown', 'slurNeutral', 'slurDashed', 'slurDotted', 'slurSolid', 'tieUp', 'tieDown',
           'tieNeutral', 'tieDashed', 'tieDotted', 'tieSolid', 'dynamicUp', 'dynamicDown', 'dynamicNeutral',
           'phrasingSlurUp', 'phrasingSlurDown', 'phrasingSlurNeutral', 'tupletUp', 'tupletDown', 'tupletNeutral',
           'autoBeamOn', 'autoBeamOff', 'break', 'noBreak', 'pageBreak', 'noPageBreak', 'mergeDifferentlyHeadedOn',
           'mergeDifferentlyHeadedOff', 'mergeDifferentlyDottedOn', 'mergeDifferentlyDottedOff', 'shiftOn', 'shiftOnn',
           'shiftOnnn', 'shiftOff', 'showStaffSwitch', 'hideStaffSwitch', 'teeny', 'tiny', 'small', 'normalsize',
           'large', 'huge', 'textLengthOn', 'textLengthOff', 'arpeggioUp', 'arpeggioDown', 'arpeggioNormal',
           'arpeggioArrowUp', 'arpeggioArrowDown', 'arpeggioBracket', 'numericTimeSignature',
           'defaultTimeSignature', 'compressFullBarRests', 'expandFullBarRests', 'compressEmptyMeasures',
           'expandEmptyMeasures', 'hideNotes', 'unHideNotes', 'easyHeadsOn', 'easyHeadsOff', 'crescTextCresc',
           'dimTextDim', 'dimTextDecresc', 'dimTextDecr', 'crescHairpin', 'dimHairpin', 'breathe', 'fermataMarkup',
           'mergeDifferentlyHeaded', 'deadNotesOn', 'deadNotesOff', 'xNotesOn', 'xNotesOff', 'harmonicsOn',
           'harmonicsOff', 'italianChords', 'germanChords', 'semiGermanChords', 'frenchChords', 'cadenzaOff',
           'sustainOn', 'sustainOff', 'startStaff', 'stopStaff', 'balloonLengthOn', 'balloonLengthOff', 'oneVoiceOn',
           'staffUp', 'staffDown', 'tabFullNotation', 'predefinedFretboardsOn', 'predefinedFretboardsOff',
           'improvisationOn', 'improvisationOff', 'palmMuteOn', 'palmMuteOff', 'bassFigureStaffAlignmentUp',
           'setTextCresc', 'setTextDecresc', 'setTextDecr', 'setTextDim', 'setHairpinCresc', 'setHairpinDecresc',
           'setHairpinDim', 'deprecatedcresc', 'deprecateddim', 'deprecatedendcresc', 'deprecatedenddim',
           'textSpannerUp', 'textSpannerDown', 'textSpannerNeutral',
           'pointAndClickOff', 'pointAndClickOn', 'ignoreClick'}
SKIP_CONTEXTS = {'Dynamics', 'Lyrics', 'FiguredBass', 'ChordNames', 'FretBoards', 'NullVoice', 'TabStaff',
                 'TabVoice', 'RhythmicStaff', 'DrumStaff', 'DrumVoice', 'Devnull'}


class Parser:
    def __init__(self, src: str, select: str | None = None):
        self.src = src
        self.toks = tokenize(src)
        self.i = 0
        # the printed scores (\score with \layout) whose text contains `select`, one after another; without it,
        # the first printed score
        self.select = select.lower() if select else None
        self.scores: list[tuple[Node, bool, str]] = []
        self.vars: dict[str, tuple[str, object]] = {}
        self.lang = 'nederlands'
        self.names = note_names(self.lang)
        self.last_dur = Dur(F(1, 4), F(4), 0)
        self.score: Node | None = None
        self.midi_tempo: float | None = None

    # -- token helpers
    def peek(self, k: int = 0) -> Tok | None:
        j = self.i + k
        return self.toks[j] if j < len(self.toks) else None

    def next(self) -> Tok:
        t = self.peek()
        if t is None:
            raise LyError('unexpected end of file')
        self.i += 1
        return t

    def at(self, kind: str, val: str | None = None, k: int = 0) -> bool:
        t = self.peek(k)
        return t is not None and t.kind == kind and (val is None or t.val == val)

    def expect(self, kind: str, val: str | None = None) -> Tok:
        t = self.next()
        if t.kind != kind or (val is not None and t.val != val):
            raise LyError(f'expected {val or kind}, got {t.val!r} at {t.pos}')
        return t

    def skip_block(self):
        """Skips a balanced { ... } block."""
        self.expect('sym', '{')
        depth = 1
        while depth:
            t = self.next()
            if t.kind == 'sym' and t.val == '{':
                depth += 1
            elif t.kind == 'sym' and t.val == '}':
                depth -= 1

    def skip_markup(self):
        """Skips one markup expression (after \\markup, or a markup argument)."""
        t = self.peek()
        if t is None:
            return
        if t.kind == 'sym' and t.val == '{':
            self.skip_block()
        elif t.kind in ('string', 'word', 'number', 'scheme'):
            self.next()
        elif t.kind == 'cmd':
            self.next()
            name = t.val[1:]
            if name in self.vars:
                return
            # a markup command: skip its arguments (Scheme values and numbers), then the markup it applies to
            while self.at('scheme') or self.at('number'):
                self.next()
            if name in ('char', 'hspace', 'vspace', 'abs-fontsize', 'fontsize', 'with-color', 'override',
                        'with-url', 'magnify', 'translate', 'raise', 'lower', 'pad-markup', 'rotate'):
                while self.at('scheme') or self.at('number') or self.at('string'):
                    t2 = self.peek()
                    if t2.kind == 'string' and name not in ('with-url',):
                        break
                    self.next()
                if name in ('char', 'hspace', 'vspace'):
                    return
            if name in ('dynamic', 'italic', 'bold', 'upright', 'sans', 'roman', 'typewriter', 'large', 'small',
                        'huge', 'tiny', 'teeny', 'normalsize', 'concat', 'line', 'column', 'center-column',
                        'right-column', 'left-column', 'abs-fontsize', 'fontsize', 'with-color', 'override', 'box',
                        'circle', 'with-url', 'magnify', 'center-align', 'right-align', 'left-align', 'general-align',
                        'halign', 'smaller', 'larger', 'caps', 'smallCaps', 'fromproperty', 'translate', 'raise',
                        'lower', 'finger', 'musicglyph', 'number', 'pad-markup', 'underline', 'whiteout', 'rotate',
                        'wordwrap', 'justify', 'fill-line', 'medium', 'normal-text', 'text', 'tied-lyric', 'sub',
                        'super', 'combine', 'overlay', 'note', 'note-by-number', 'arrow-head', 'draw-line',
                        'draw-circle', 'epsfile', 'score', 'parenthesize', 'bracket', 'hbracket', 'rounded-box',
                        'doublesharp', 'doubleflat', 'sharp', 'flat', 'natural', 'semisharp', 'semiflat',
                        'concat-markup', 'path', 'filled-box', 'null', 'strut', 'beam', 'fraction', 'char'):
                if name in ('doublesharp', 'doubleflat', 'sharp', 'flat', 'natural', 'semisharp', 'semiflat',
                            'null', 'strut', 'fromproperty', 'musicglyph', 'note-by-number', 'arrow-head',
                            'draw-line', 'draw-circle', 'filled-box', 'path', 'epsfile', 'beam'):
                    return
                if name in ('combine', 'overlay', 'fraction'):
                    self.skip_markup()
                self.skip_markup()
            else:
                self.skip_markup()

    # -- file level
    def parse_file(self) -> Node:
        while self.peek() is not None:
            t = self.next()
            if t.kind == 'cmd':
                c = t.val[1:]
                if c == 'version':
                    self.expect('string')
                elif c == 'language':
                    self.set_lang(self.expect('string').val.strip('"'))
                elif c == 'include':
                    f = self.expect('string').val.strip('"')
                    lang = f.replace('.ly', '')
                    if lang in ('english', 'nederlands'):
                        self.set_lang(lang)
                    elif lang in ('deutsch', 'italiano', 'espanol', 'catalan', 'portugues', 'suomi', 'svenska',
                                  'vlaams', 'norsk'):
                        raise LyError(f'note-name language {lang} is not supported')
                elif c in ('header', 'paper', 'layout', 'midi'):
                    if c == 'midi':
                        self.read_midi_block()
                    else:
                        self.skip_block()
                elif c == 'score':
                    self.parse_score()
                elif c == 'book' or c == 'bookpart':
                    self.expect('sym', '{')
                elif c == 'pointAndClickOff' or c == 'pointAndClickOn':
                    pass
                else:
                    raise LyError(f'unexpected top-level command {t.val} at {t.pos}')
            elif t.kind == 'word' and (self.at('sym', '=') or self.at('sym', '_') or self.at('sym', '-')):
                name = t.val
                while (self.at('sym', '_') or self.at('sym', '-')) and self.at('word', None, 1) \
                        and self.peek().pos == t.pos + len(name):
                    name += self.next().val + self.next().val
                self.expect('sym', '=')
                self.vars[name] = self.parse_value()
            elif t.kind == 'sym' and t.val == '}':
                pass  # end of \book
            elif t.kind == 'scheme':
                pass
            else:
                raise LyError(f'unexpected {t.val!r} at top level ({t.pos})')
        self.score = self.pick_score()
        return self.score

    def pick_score(self) -> Node:
        if not self.scores:
            raise LyError('no \\score')
        printed = [s for s in self.scores if s[1]] or self.scores
        if not self.select:
            return printed[0][0]
        chosen = [m for m, _, text in printed if self.select in text.lower()]
        if not chosen:
            raise LyError(f'no \\score with {self.select!r}')
        return chosen[0] if len(chosen) == 1 else Node('seq', (chosen,))

    def set_lang(self, lang: str):
        self.lang = lang
        self.names = note_names(lang)

    def read_midi_block(self):
        self.expect('sym', '{')
        depth = 1
        while depth:
            t = self.next()
            if t.kind == 'sym' and t.val == '{':
                depth += 1
            elif t.kind == 'sym' and t.val == '}':
                depth -= 1
            elif t.kind == 'cmd' and t.val == '\\tempo':
                tempo = self.parse_tempo()
                if tempo:
                    self.midi_tempo = tempo

    def parse_value(self):
        t = self.peek()
        if t.kind == 'string':
            self.next()
            return ('string', t.val)
        if t.kind == 'scheme':
            self.next()
            return ('scheme', t.val)
        if t.kind == 'number':
            self.next()
            return ('number', t.val)
        if t.kind == 'cmd' and t.val == '\\markup':
            self.next()
            self.skip_markup()
            return ('markup', None)
        if t.kind == 'cmd' and t.val == '\\markuplist':
            self.next()
            self.skip_markup()
            return ('markup', None)
        if t.kind == 'cmd' and t.val in ('\\header', '\\layout', '\\paper', '\\midi'):
            self.next()
            self.skip_block()
            return ('block', None)
        return ('music', self.parse_music())

    def parse_score(self):
        start = self.expect('sym', '{').pos
        music = None
        has_layout = False
        while not self.at('sym', '}'):
            t = self.peek()
            if t.kind == 'cmd' and t.val in ('\\layout', '\\header', '\\paper'):
                self.next()
                has_layout |= t.val == '\\layout'
                self.skip_block()
            elif t.kind == 'cmd' and t.val == '\\midi':
                self.next()
                self.read_midi_block()
            else:
                m = self.parse_music()
                if music is None:
                    music = m
        end = self.next().pos
        if music is not None:
            self.scores.append((music, has_layout, self.src[start:end]))

    # -- music
    def parse_music(self) -> Node:
        t = self.peek()
        if t is None:
            raise LyError('unexpected end of file in music')
        if t.kind == 'sym' and t.val == '{':
            self.next()
            items = []
            while not self.at('sym', '}'):
                self.parse_into(items)
            self.next()
            return Node('seq', (items,))
        if t.kind == 'dbl' and t.val == '<<':
            self.next()
            groups: list[list[Node]] = [[]]
            while not self.at('dbl', '>>'):
                if self.at('voicesep'):
                    self.next()
                    groups.append([])
                    continue
                self.parse_into(groups[-1])
            self.next()
            if len(groups) > 1:
                return Node('sim', ([Node('seq', (g,)) for g in groups], True))
            return Node('sim', (groups[0], False))
        if t.kind == 'sym' and t.val == '<':
            return self.parse_chord()
        if t.kind == 'word':
            return self.parse_note()
        if t.kind == 'cmd':
            return self.parse_command()
        if t.kind == 'sym' and t.val == '|':
            self.next()
            return Node('barcheck')
        if t.kind == 'scheme':
            self.next()
            m = re.fullmatch(r'#\(set-octavation\s+(-?\d+)\s*\)', t.val.strip())  # the old \ottava
            return Node('ottava', (int(m.group(1)),)) if m else Node('nothing')
        raise LyError(f'unexpected {t.val!r} in music at {t.pos}')

    def parse_into(self, items: list[Node]):
        """Parses one music item into the list; loose post-events (a tie or slur after a space) join the last item."""
        t = self.peek()
        if t.kind in ('sym', 'special') and t.val in ('~', '(', ')', '[', ']', '\\(', '\\)', '\\<', '\\>', '\\!',
                                                     '\\~', '\\[', '\\]') or (t.kind == 'sym' and t.val in '-^_'
                                                                               and not self.at('sym', '<', 1)):
            post = self.parse_post()
            for it in reversed(items):
                if it.kind in ('note', 'chord', 'rest'):
                    it.args[-1].fingers.extend(post.fingers)
                    it.args[-1].tie |= post.tie
                    break
            return
        if t.kind == 'cmd' and self.is_post_cmd(t.val[1:]):
            self.parse_post()
            return
        items.append(self.parse_music())

    def is_post_cmd(self, c: str) -> bool:
        if c in DYNAMICS or c in ARTICULATIONS:
            return True
        v = self.vars.get(c)
        return v is not None and v[0] in ('markup', 'string')

    def parse_pitch(self) -> Pitch:
        t = self.expect('word')
        if t.val not in self.names:
            raise LyError(f'unknown note name {t.val!r} at {t.pos}')
        step, alter = self.names[t.val]
        marks = 0
        while self.at('sym', "'") or self.at('sym', ','):
            marks += 1 if self.next().val == "'" else -1
        while self.at('sym', '!') or self.at('sym', '?'):
            self.next()
        if self.at('sym', '='):  # octave check
            self.next()
            while self.at('sym', "'") or self.at('sym', ','):
                self.next()
        return Pitch(step, alter, marks)

    def parse_duration(self) -> Dur | None:
        t = self.peek()
        if t is not None and t.kind == 'number' and t.val in ('1', '2', '4', '8', '16', '32', '64', '128'):
            self.next()
            base = F(int(t.val))
        elif t is not None and t.kind == 'cmd' and t.val in ('\\breve', '\\longa'):
            self.next()
            base = F(1, 2) if t.val == '\\breve' else F(1, 4)
        else:
            return None
        dots = 0
        while self.at('sym', '.'):
            self.next()
            dots += 1
        length = (1 / base) * (2 - F(1, 2 ** dots))
        while self.at('sym', '*'):
            self.next()
            num = int(self.expect('number').val)
            den = 1
            if self.at('sym', '/'):
                self.next()
                den = int(self.expect('number').val)
            length *= F(num, den)
        d = Dur(length, base, dots)
        self.last_dur = d
        return d

    def parse_post(self) -> Post:
        post = Post()
        while True:
            t = self.peek()
            if t is None:
                break
            if t.kind == 'sym' and t.val in '-^_':
                nt = self.peek(1)
                if nt is None:
                    break
                if nt.kind == 'sym' and nt.val == '<':
                    break  # not a post-event
                self.next()
                a = self.next()
                if a.kind == 'number':
                    post.fingers.extend(int(ch) for ch in a.val if ch in '12345')
                    post.below = t.val == '_'
                elif a.kind == 'sym' and a.val == '~':
                    post.tie = True
                elif a.kind == 'sym' and a.val in ".->!_^+()[]|":
                    pass
                elif a.kind == 'special':
                    pass
                elif a.kind == 'string':
                    pass
                elif a.kind == 'cmd':
                    c = a.val[1:]
                    if c == 'markup':
                        self.skip_markup()
                    elif c == 'finger':
                        arg = self.next()
                        digits = re.findall(r'[1-5]', arg.val)
                        if digits:
                            post.fingers.append(int(digits[0]))
                    elif c == 'tweak':
                        self.skip_tweak()
                        self.i -= 0
                        continue
                    elif c in DYNAMICS or c in ARTICULATIONS or c in self.vars:
                        pass
                    else:
                        raise LyError(f'unknown post-event {a.val} at {a.pos}')
                else:
                    raise LyError(f'unexpected {a.val!r} after a direction at {a.pos}')
                continue
            if t.kind == 'sym' and t.val == '~':
                self.next()
                post.tie = True
                continue
            if t.kind == 'sym' and t.val in '()[]':
                self.next()
                continue
            if t.kind == 'special':
                self.next()
                continue
            if t.kind == 'sym' and t.val == ':':
                self.next()
                if self.at('number'):
                    self.next()
                continue
            if t.kind == 'cmd':
                c = t.val[1:]
                if self.is_post_cmd(c):
                    self.next()
                    continue
                if c == 'finger':
                    self.next()
                    arg = self.next()
                    digits = re.findall(r'[1-5]', arg.val)
                    if digits:
                        post.fingers.append(int(digits[0]))
                    continue
                if c == 'tweak':
                    self.next()
                    self.skip_tweak()
                    continue
            break
        return post

    def skip_tweak(self):
        # \tweak property value
        if self.at('scheme'):
            self.next()
        else:
            self.expect('word')
            while self.at('sym', '.'):
                self.next()
                self.expect('word')
        self.next()  # the value

    def parse_note(self) -> Node:
        t = self.peek()
        if t.val in ('r', 's', 'R'):
            self.next()
            d = self.parse_duration() or self.last_dur
            post = self.parse_post()
            return Node('rest', (t.val, d, post))
        if t.val == 'q':
            self.next()
            d = self.parse_duration() or self.last_dur
            post = self.parse_post()
            return Node('q', (d, post))
        p = self.parse_pitch()
        d = self.parse_duration() or self.last_dur
        # LilyPond also takes octave marks written after the duration (f8')
        while self.at('sym', "'") or self.at('sym', ','):
            p.marks += 1 if self.next().val == "'" else -1
        if self.at('cmd', '\\rest'):  # a rest placed at a pitch
            self.next()
            return Node('rest', ('r', d, self.parse_post()))
        post = self.parse_post()
        return Node('note', (p, d, post))

    def parse_chord(self) -> Node:
        self.expect('sym', '<')
        notes = []
        while not self.at('sym', '>'):
            p = self.parse_pitch()
            post = self.parse_post()
            notes.append((p, post))
        self.next()
        d = self.parse_duration() or self.last_dur
        post = self.parse_post()
        if not notes:
            return Node('nothing')
        if post.fingers:
            if len(post.fingers) > len(notes):
                raise LyError('more fingerings than chord notes')
            # in \relative the pitches are not known yet: the evaluator gives these fingers to the notes
            post.chord_fingers, post.fingers = post.fingers, []
        if post.tie:
            for _, np in notes:
                np.tie = True
        return Node('chord', (notes, d, post))

    def parse_tempo(self) -> float | None:
        """Parses the arguments of \\tempo; returns quarter notes per minute if given."""
        if self.at('string'):
            self.next()
        elif self.at('cmd', '\\markup'):
            self.next()
            self.skip_markup()
        if self.at('number'):
            d = self.parse_duration()
            self.expect('sym', '=')
            n = int(self.expect('number').val)
            if self.at('sym', '-'):
                self.next()
                n2 = int(self.expect('number').val)
                n = (n + n2) / 2
            return float(n) * float(d.length * 4) if d else float(n)
        return None

    def parse_command(self) -> Node:
        t = self.next()
        c = t.val[1:]
        if c == 'relative':
            ref = None
            if self.at('word') and self.peek().val in self.names:
                ref = self.parse_pitch()
            return Node('relative', (ref, self.parse_music()))
        if c == 'absolute':
            return self.parse_music()
        if c == 'applyMusic':  # a Scheme function over the music, e.g. #unfold-repeats in a MIDI-only score
            if not self.at('scheme'):
                raise LyError(f'\\applyMusic without a Scheme function at {t.pos}')
            self.next()
            return self.parse_music()
        if c == 'unfoldRepeats':  # only in MIDI scores, which are not converted
            return self.parse_music()
        if c == 'fixed':
            ref = self.parse_pitch()
            return Node('fixed', (ref, self.parse_music()))
        if c == 'times':
            num = int(self.expect('number').val)
            self.expect('sym', '/')
            den = int(self.expect('number').val)
            return Node('times', (F(num, den), self.parse_music(), (den, num)))
        if c == 'tuplet':
            num = int(self.expect('number').val)
            self.expect('sym', '/')
            den = int(self.expect('number').val)
            if self.at('number'):
                self.parse_duration()
            return Node('times', (F(den, num), self.parse_music(), (num, den)))
        if c in ('grace', 'acciaccatura', 'appoggiatura', 'slashedGrace'):
            return Node('grace', (self.parse_music(),))
        if c == 'afterGrace':
            main = self.parse_music()
            self.parse_music()  # the grace notes after the main note are left out
            return main
        if c == 'repeat':
            kind = self.next().val.strip('"') if self.at('string') else self.expect('word').val
            n = int(self.expect('number').val)
            body = self.parse_music()
            alts = []
            if self.at('cmd', '\\alternative'):
                self.next()
                self.expect('sym', '{')
                while not self.at('sym', '}'):
                    alts.append(self.parse_music())
                self.next()
            if kind == 'tremolo':  # the same notes as played: the body n times
                kind = 'unfold'
            if kind not in ('volta', 'unfold', 'percent'):
                raise LyError(f'\\repeat {kind} is not supported')
            return Node('repeat', (kind, n, body, alts))
        if c == 'alternative':
            raise LyError('\\alternative without \\repeat')
        if c == 'partial':
            d = self.parse_duration()
            if d is None:
                raise LyError('\\partial without a duration')
            return Node('partial', (d,))
        if c == 'key':
            p = self.parse_pitch()
            mode = self.expect('cmd').val[1:]
            return Node('key', (p.step, p.alter, mode))
        if c == 'time':
            num = int(self.expect('number').val)
            while self.at('sym', ','):  # 2,2,3/8
                self.next()
                num += int(self.expect('number').val)
            self.expect('sym', '/')
            den = int(self.expect('number').val)
            return Node('time', (num, den))
        if c == 'clef':
            a = self.next()
            return Node('clef', (a.val.strip('"'),))
        if c == 'bar':
            return Node('bar', (self.expect('string').val.strip('"'),))
        if c in ('new', 'context'):
            ctype = self.expect('word').val
            name = None
            if self.at('sym', '='):
                self.next()
                name = self.next().val.strip('"')
            if self.at('cmd', '\\with'):
                self.next()
                self.skip_block()
            return Node('context', (ctype, name, self.parse_music()))
        if c == 'change':
            self.expect('word', 'Staff')
            self.expect('sym', '=')
            return Node('change', (self.next().val.strip('"'),))
        if c == 'tempo':
            q = self.parse_tempo()
            return Node('tempo', (q,))
        if c == 'mark':
            if self.at('cmd', '\\default'):
                self.next()
            elif self.at('cmd', '\\markup'):
                self.next()
                self.skip_markup()
            else:
                self.next()
            return Node('nothing')
        if c == 'markup':
            self.skip_markup()
            return Node('nothing')
        if c in ('set', 'unset', 'override', 'revert', 'temporary', 'undo', 'omit', 'hide'):
            return self.skip_property(c) or Node('nothing')
        if c == 'once':
            return self.parse_music()  # applies to the next command
        if c == 'tweak':
            self.skip_tweak()
            return self.parse_music()  # the tweaked item
        if c == 'shape':
            self.next()
            self.next()
            return Node('nothing')
        if c == 'ottava':  # \ottava #1, \ottava 1, \ottava #-1, \ottava -1
            v = self.next()
            sign = 1
            if v.kind == 'sym' and v.val == '-' and self.at('number'):
                sign, v = -1, self.next()
            m = re.fullmatch(r'#?\s*(-?\d+)', v.val.strip()) if v.kind in ('scheme', 'number') else None
            if not m:
                raise LyError(f'\\ottava {v.val} is not supported ({v.pos})')
            return Node('ottava', (sign * int(m.group(1)),))
        if c == 'accidentalStyle':
            self.next()
            while self.at('sym', '.'):
                self.next()
                self.next()
            return Node('nothing')
        if c in ('tag', 'keepWithTag', 'removeWithTag'):
            self.next()
            return Node('seq', ([self.parse_music()],)) if c == 'tag' else Node('nothing')
        if c in TOGGLES:
            return Node('nothing')
        if c == 'cadenzaOn':
            raise LyError('\\cadenzaOn is not supported')
        if c in ('transpose', 'partcombine', 'partCombine'):
            raise LyError(f'\\{c} is not supported')
        if c in self.vars:
            kind, val = self.vars[c]
            if kind == 'music':
                return val
            return Node('nothing')
        if c in DYNAMICS or c in ARTICULATIONS:
            return Node('nothing')
        raise LyError(f'unknown command {t.val} at {t.pos}')

    def skip_property(self, c: str) -> Node | None:
        # \set Staff.prop = value | \override Grob.prop = value | \override Grob #'prop = value | \revert Grob.prop
        if c in ('omit', 'hide'):
            self.expect('word')
            while self.at('sym', '.'):
                self.next()
                self.expect('word')
            return None
        if self.at('cmd', '\\once'):
            self.next()
        prop = self.expect('word').val
        while self.at('sym', '.') or self.at('scheme'):
            if self.at('scheme'):
                self.next()
            else:
                self.next()
                prop = self.expect('word').val
        if c in ('unset', 'revert'):
            return None
        self.expect('sym', '=')
        v = self.next()
        if c == 'set' and prop in ('measureLength', 'measurePosition'):
            # a shorter measure or an upbeat written with the Timing properties instead of \partial
            m = re.fullmatch(r'#\(ly:make-moment\s+(-?\d+)(?:\s*/\s*(\d+)|\s+(\d+))?\s*\)', v.val.strip())
            if not m:
                raise LyError(f'\\set {prop} = {v.val} is not supported ({v.pos})')
            return Node('timing', (prop, F(int(m.group(1)), int(m.group(2) or m.group(3) or 1))))
        if v.kind == 'cmd' and v.val == '\\markup':
            self.skip_markup()
        elif v.kind == 'cmd':
            pass
        elif v.kind == 'sym' and v.val == '{':
            self.i -= 1
            self.skip_block()
        return None


# ---------------------------------------------------------------- relative pitches

def resolve(node: Node, ref: Pitch | None) -> tuple[Node, Pitch | None]:
    """Returns the node with absolute pitches; `ref` is the relative reference (None: absolute mode)."""
    k = node.kind
    if k == 'note':
        p, d, post = node.args
        ap, ref = resolve_pitch(p, ref)
        return Node('note', (ap, d, post)), ref
    if k == 'chord':
        notes, d, post = node.args
        out = []
        first = None
        r = ref
        for p, np in notes:
            ap, r = resolve_pitch(p, r)
            out.append((ap, np))
            if first is None:
                first = ap
        return Node('chord', (out, d, post)), (first if ref is not None else None)
    if k == 'seq':
        items = []
        for it in node.args[0]:
            it2, ref = resolve(it, ref)
            items.append(it2)
        return Node('seq', (items,)), ref
    if k == 'sim':
        items = []
        for it in node.args[0]:
            it2, ref = resolve(it, ref)
            items.append(it2)
        return Node('sim', (items, node.args[1])), ref
    if k == 'relative':
        r0, music = node.args
        start = r0 if r0 is not None else Pitch(3, 0, 0)  # LilyPond: f (the F below middle C)
        start_abs = Pitch(start.step, start.alter, start.marks + 3, True)
        music2, last = resolve(music, start_abs)
        return music2, (last if ref is not None else ref)
    if k == 'fixed':
        raise LyError('\\fixed is not supported')
    if k == 'times':
        f, music, ratio = node.args
        m2, ref = resolve(music, ref)
        return Node('times', (f, m2, ratio)), ref
    if k == 'grace':
        m2, ref = resolve(node.args[0], ref)
        return Node('grace', (m2,)), ref
    if k == 'repeat':
        kind, n, body, alts = node.args
        b2, ref = resolve(body, ref)
        a2 = []
        for a in alts:
            x, ref = resolve(a, ref)
            a2.append(x)
        return Node('repeat', (kind, n, b2, a2)), ref
    if k == 'context':
        ctype, name, music = node.args
        m2, ref = resolve(music, ref)
        return Node('context', (ctype, name, m2)), ref
    return node, ref


def resolve_pitch(p: Pitch, ref: Pitch | None) -> tuple[Pitch, Pitch | None]:
    if p.resolved:
        return p, (p if ref is not None else None)
    if ref is None:
        return Pitch(p.step, p.alter, p.marks + 3, True), None
    # the octave closest to the previous note (at most a fourth away by note names), then the octave marks
    best = None
    for octv in range(ref.marks - 2, ref.marks + 3):
        d = octv * 7 + p.step - ref.dia()
        if -3 <= d <= 3:
            best = octv
            break
    assert best is not None
    ap = Pitch(p.step, p.alter, best + p.marks, True)
    return ap, ap


# ---------------------------------------------------------------- evaluation

@dataclass
class OutNote:
    staff: int
    voice: str
    onset: F
    dur: F
    pitch: Pitch | None
    fingers: list[int]
    tie: bool
    grace: bool
    base: F
    dots: int
    tuplet: tuple[int, int] | None
    tuplet_group: int | None
    chord: int


@dataclass
class Cursor:
    time: F
    staff: int
    voice: str
    factor: F = F(1)
    grace: bool = False
    tuplet: tuple[int, int] | None = None
    tuplet_group: int | None = None
    last_chord: list | None = None
    mlen: F | None = None  # \set Timing.measureLength in effect (None: from the time signature)


class Evaluator:
    def __init__(self):
        self.notes: list[OutNote] = []
        self.staves: dict[str, int] = {}
        self.anon_staves = 0
        self.keys: list[tuple[F, int, str]] = []
        self.times: list[tuple[F, int, int]] = []
        self.clefs: list[tuple[int, F, str]] = []
        self.partial: F | None = None
        self.mid_partials: dict[F, F] = {}  # a shorter measure starts here (before and after a repeat sign)
        self.measure_lengths: dict[F, F] = {}  # \set Timing.measureLength: the length of the measures from here on
        self.measure_starts: set[F] = set()  # \set Timing.measurePosition = 0: a measure starts here
        self.ottavas: list[tuple[int, F, int]] = []  # (staff, time, octaves): notes printed octaves lower (8va)
        self.bars: list[tuple[F, str]] = []
        self.repeat_starts: set[F] = set()
        self.repeat_ends: set[F] = set()
        self.endings: list[tuple[int, F, F, bool]] = []
        self.barchecks: list[F] = []
        self.tempos: list[tuple[F, float]] = []
        self.chord_id = 0
        self.group_id = 0
        self.voice_n = 0
        self.end = F(0)

    def new_voice(self, base: str) -> str:
        self.voice_n += 1
        return f'{base}#{self.voice_n}'

    def run(self, node: Node):
        # staves are numbered in order of appearance (a voice may switch to a staff that comes later)
        def walk(n: Node):
            if n.kind == 'context' and n.args[0] == 'Staff':
                name = n.args[1]
                if name is None:
                    self.anon_staves += 1
                    name = f'#anon{self.anon_staves}'
                    n.args = (n.args[0], name, n.args[2])
                if name not in self.staves:
                    self.staves[name] = len(self.staves) + 1
            for a in n.args:
                if isinstance(a, Node):
                    walk(a)
                elif isinstance(a, list):
                    for x in a:
                        if isinstance(x, Node):
                            walk(x)
        walk(node)
        if len(self.staves) > 2:
            raise LyError('more than two staves (only a piano part is supported)')
        cur = Cursor(F(0), 1, self.new_voice('top'))
        self.eval(node, cur)

    def eval(self, node: Node, cur: Cursor):
        k = node.kind
        if k == 'seq':
            for it in node.args[0]:
                self.eval(it, cur)
        elif k == 'sim':
            items, voices = node.args
            start = cur.time
            end = start
            for idx, it in enumerate(items):
                c2 = Cursor(start, cur.staff, cur.voice if (not voices and idx == 0 and False) else
                            self.new_voice(cur.voice), cur.factor, cur.grace, cur.tuplet, cur.tuplet_group,
                            cur.last_chord, cur.mlen)
                self.eval(it, c2)
                end = max(end, c2.time)
                mlen = c2.mlen
                if c2.staff != cur.staff and len(items) == 1:
                    cur.staff = c2.staff
            cur.time = end
            if items:
                cur.mlen = mlen  # the measure length is the same for all staves (Timing)
        elif k == 'context':
            ctype, name, music = node.args
            if ctype in SKIP_CONTEXTS:
                return
            if ctype == 'Staff':
                c2 = Cursor(cur.time, self.staves[name], self.new_voice(f'S{self.staves[name]}'), cur.factor,
                            mlen=cur.mlen)
                self.eval(music, c2)
                cur.time = max(cur.time, c2.time)
                cur.mlen = c2.mlen
            elif ctype == 'Voice':
                c2 = Cursor(cur.time, cur.staff, self.new_voice(name or 'V'), cur.factor, cur.grace, cur.tuplet,
                            cur.tuplet_group, cur.last_chord, cur.mlen)
                self.eval(music, c2)
                cur.time = max(cur.time, c2.time)
                cur.mlen = c2.mlen
            elif ctype in ('PianoStaff', 'GrandStaff', 'StaffGroup', 'Score', 'ChoirStaff'):
                self.eval(music, cur)
            else:
                raise LyError(f'context {ctype} is not supported')
        elif k in ('note', 'chord', 'q'):
            if k == 'note':
                p, d, post = node.args
                notes = [(p, post)]
            elif k == 'chord':
                notes, d, post = node.args
                cur.last_chord = [p for p, _ in notes]
            else:
                d, post = node.args
                if not cur.last_chord:
                    raise LyError('q without a previous chord')
                notes = [(p, Post(tie=post.tie)) for p in cur.last_chord]
                if post.fingers and len(post.fingers) <= len(notes):  # q-1: a finger for the repeated chord
                    post = Post([], post.tie, post.below, list(post.fingers))
            length = d.length * cur.factor
            self.chord_id += 1
            if k != 'note' and post.chord_fingers:
                notes = self.place_chord_fingers(notes, post.chord_fingers, post.below, cur.staff)
            notes = self.fix_chord_fingers(notes, cur.staff)
            for p, np in notes:
                self.notes.append(OutNote(cur.staff, cur.voice, cur.time, F(0) if cur.grace else length, p,
                                          list(np.fingers), np.tie or post.tie, cur.grace, d.base, d.dots,
                                          cur.tuplet, cur.tuplet_group, self.chord_id))
            if not cur.grace:
                cur.time += length
                self.end = max(self.end, cur.time)
        elif k == 'rest':
            kind, d, post = node.args
            if not cur.grace:
                cur.time += d.length * cur.factor
                self.end = max(self.end, cur.time)
        elif k == 'times':
            f, music, ratio = node.args
            self.group_id += 1
            saved = (cur.factor, cur.tuplet, cur.tuplet_group)
            cur.factor *= f
            cur.tuplet = ratio
            cur.tuplet_group = self.group_id
            self.eval(music, cur)
            cur.factor, cur.tuplet, cur.tuplet_group = saved
        elif k == 'grace':
            saved = cur.grace
            cur.grace = True
            self.eval(node.args[0], cur)
            cur.grace = saved
        elif k == 'repeat':
            kind, n, body, alts = node.args
            if kind == 'unfold' or kind == 'percent':
                if alts:
                    raise LyError('\\repeat unfold with \\alternative is not supported')
                for _ in range(n):
                    self.eval(body, cur)
                return
            self.repeat_starts.add(cur.time)
            self.eval(body, cur)
            if not alts:
                self.repeat_ends.add(cur.time)
                return
            start_len = cur.mlen
            for idx, alt in enumerate(alts):
                s = cur.time
                if idx and cur.mlen != start_len:
                    # every ending starts with the measure length the first one had (editors shorten the last measure
                    # of the first ending and do not always set it back for the next one)
                    if start_len is None:
                        tsig = [(tt, a, b) for tt, a, b in self.times if tt <= s]
                        self.measure_lengths[s] = F(tsig[-1][1], tsig[-1][2]) if tsig else F(1)
                    else:
                        self.measure_lengths[s] = start_len
                    cur.mlen = start_len
                self.eval(alt, cur)
                last = idx == len(alts) - 1
                self.endings.append((idx + 1, s, cur.time, last))
                if not last:
                    self.repeat_ends.add(cur.time)
        elif k == 'partial':
            length = node.args[0].length
            if cur.time == 0:
                self.partial = length
            elif self.mid_partials.setdefault(cur.time, length) != length:
                raise LyError('two different \\partial at the same time')
        elif k == 'key':
            step, alter, mode = node.args
            self.keys.append((cur.time, fifths_of(step, alter, mode), mode))
        elif k == 'time':
            self.times.append((cur.time, node.args[0], node.args[1]))
            cur.mlen = None
        elif k == 'timing':
            prop, value = node.args
            if prop == 'measureLength':  # set twice at the same time (end of a repeat, next upbeat): the last counts
                if value <= 0:
                    raise LyError(f'measureLength {value} at {cur.time}')
                self.measure_lengths[cur.time] = value
                cur.mlen = value
            elif value < 0:  # an upbeat: the measure has -value left
                if cur.time == 0:
                    self.partial = -value
                elif self.mid_partials.setdefault(cur.time, -value) != -value:
                    raise LyError('two different upbeats at the same time')
            elif value == 0:
                self.measure_starts.add(cur.time)
            else:
                raise LyError('\\set Timing.measurePosition to a positive moment is not supported')
        elif k == 'clef':
            self.clefs.append((cur.staff, cur.time, node.args[0]))
        elif k == 'ottava':
            self.ottavas.append((cur.staff, cur.time, node.args[0]))
        elif k == 'bar':
            self.bars.append((cur.time, node.args[0]))
        elif k == 'change':
            name = node.args[0]
            if name not in self.staves:
                raise LyError(f'\\change Staff = {name}: no such staff')
            cur.staff = self.staves[name]
        elif k == 'barcheck':
            self.barchecks.append(cur.time)
        elif k == 'tempo':
            if node.args[0]:
                self.tempos.append((cur.time, node.args[0]))
        elif k in ('nothing',):
            pass
        elif k == 'relative':
            raise LyError('unresolved \\relative')
        else:
            raise LyError(f'cannot evaluate {k}')


def _fix_chord_fingers(self, notes, staff: int):
    """
    Fingers of a chord go up with the pitch in the right hand and down in the left. Some typesetters attached the
    printed column of fingers to the chord notes in the opposite order, which no hand can play: put it right.
    """
    fingered = sorted([(p.midi(), j) for j, (p, np) in enumerate(notes) if np.fingers], key=lambda x: x[0])
    if len(fingered) < 2:
        return notes
    fs = [notes[j][1].fingers[0] for _, j in fingered]
    rising = all(fs[i] > fs[i - 1] for i in range(1, len(fs)))
    falling = all(fs[i] < fs[i - 1] for i in range(1, len(fs)))
    wrong = falling if staff == 1 else rising
    if not wrong:
        return notes
    self.fixed_chords += 1
    out = [(p, Post(list(np.fingers), np.tie, np.below)) for p, np in notes]
    for (_, j), f in zip(fingered, reversed(fs)):
        out[j][1].fingers[0] = f
    return out


def _place_chord_fingers(self, notes, fingers: list[int], below: bool, staff: int):
    """
    Fingers written after a chord, not after its notes. One finger: the thumb and the fifth finger belong to the
    outer notes (the thumb is the lowest note in the right hand and the highest in the left), another finger to the
    top note, or to the bottom one when written below. Several: from the bottom up (from the top down when below).
    """
    order = sorted(range(len(notes)), key=lambda j: notes[j][0].midi())
    rh = staff == 1
    if len(fingers) == 1:
        f = fingers[0]
        if f == 1:
            target = [order[0] if rh else order[-1]]
        elif f == 5:
            target = [order[-1] if rh else order[0]]
        else:
            target = [order[0] if below else order[-1]]
    else:
        target = order[::-1][:len(fingers)] if below else order[:len(fingers)]
    out = [(p, Post(list(np.fingers), np.tie, np.below)) for p, np in notes]
    for j, f in zip(target, fingers):
        if not out[j][1].fingers:
            out[j][1].fingers.append(f)
    return out


Evaluator.fix_chord_fingers = _fix_chord_fingers
Evaluator.place_chord_fingers = _place_chord_fingers
Evaluator.fixed_chords = 0


def fifths_of(step: int, alter: int, mode: str) -> int:
    base = {0: 0, 1: 2, 2: 4, 3: -1, 4: 1, 5: 3, 6: 5}[step] + 7 * alter
    if mode == 'minor':
        base -= 3
    elif mode in ('major', 'ionian'):
        pass
    elif mode == 'dorian':
        base -= 2
    elif mode == 'mixolydian':
        base -= 1
    else:
        raise LyError(f'mode {mode} is not supported')
    return base


# ---------------------------------------------------------------- MusicXML

TYPES = {F(1, 2): 'breve', F(1): 'whole', F(2): 'half', F(4): 'quarter', F(8): 'eighth', F(16): '16th', F(32): '32nd',
         F(64): '64th', F(128): '128th'}
CLEFS = {'treble': ('G', 2, 0), 'violin': ('G', 2, 0), 'G': ('G', 2, 0), 'G2': ('G', 2, 0), 'bass': ('F', 4, 0),
         'F': ('F', 4, 0), 'alto': ('C', 3, 0), 'tenor': ('C', 4, 0), 'treble_8': ('G', 2, -1),
         'bass_8': ('F', 4, -1), 'soprano': ('C', 1, 0)}


def lcm(a: int, b: int) -> int:
    return a * b // math.gcd(a, b)


def note_values(length: F) -> list[tuple[F, int]]:
    """Splits a length (whole notes) into note values (base, dots), largest first."""
    out = []
    rest = length
    for base in (F(1), F(2), F(4), F(8), F(16), F(32), F(64), F(128)):
        for dots in (2, 1, 0):
            v = (1 / base) * (2 - F(1, 2 ** dots))
            while rest >= v:
                out.append((base, dots))
                rest -= v
    if rest != 0:
        raise LyError(f'cannot write a length of {length} with note values')
    return out


def beat_of(num: int, den: int) -> F:
    if den == 8 and num % 3 == 0:
        return F(3, 8)
    return F(1, den) if den >= 4 else F(1, 4)


class Writer:
    def __init__(self, ev: Evaluator, title: str, composer: str, rights: str, source: str, tempo: float | None):
        self.ev = ev
        self.title, self.composer, self.rights, self.source, self.tempo = title, composer, rights, source, tempo

    def measures(self) -> list[tuple[F, F, int, int]]:
        ev = self.ev
        times = sorted(dict.fromkeys(ev.times), key=lambda x: x[0])  # the later of two at the same time counts
        if not times or times[0][0] != 0:
            times.insert(0, (F(0), 4, 4))
        end = ev.end
        out = []
        t = F(0)
        ti = 0
        num, den = times[0][1], times[0][2]
        first = True
        lengths = sorted(ev.measure_lengths.items())
        while t < end:
            while ti + 1 < len(times) and times[ti + 1][0] <= t:
                ti += 1
                num, den = times[ti][1], times[ti][2]
            length = F(num, den)
            # \set Timing.measureLength after the last time signature (at the same time: after it)
            set_len = [(tl, ln) for tl, ln in lengths if times[ti][0] <= tl <= t]
            if set_len:
                length = set_len[-1][1]
            if first and ev.partial:
                length = ev.partial
            elif t in ev.mid_partials:
                length = ev.mid_partials[t]
            first = False
            nxt = t + length
            # a measure length set inside this measure: the barline comes when the measure reaches it, or right
            # there if the measure is already that long (a short measure before an upbeat)
            for tl, ln in lengths:
                if t < tl < nxt:
                    nxt = t + ln if t + ln > tl else tl
                    break
            if any(t < pt < nxt for pt in ev.mid_partials):
                raise LyError('\\partial inside a measure is not supported')
            # \set Timing.measurePosition = 0: a new measure starts there
            for ts in sorted(ev.measure_starts):
                if t < ts < nxt:
                    nxt = ts
                    break
            # a time signature change inside this measure ends it there
            for tt, n, d in times:
                if t < tt < nxt:
                    nxt = tt
            out.append((t, min(nxt, end) if nxt > end else nxt, num, den))
            t = nxt
        return out

    def write(self) -> str:
        ev = self.ev
        meas = self.measures()
        bounds = {m[0] for m in meas} | {meas[-1][1]}
        bad = [t for t in ev.barchecks if t not in bounds]
        if bad:
            raise LyError(f'{len(bad)} bar checks off the barlines, first at {bad[0]} (whole notes)')
        # divisions per quarter note
        div = 1
        for n in ev.notes:
            for v in (n.onset, n.dur):
                div = lcm(div, (v * 4).denominator)
        for s, e, _, _ in meas:
            div = lcm(div, (s * 4).denominator)
            div = lcm(div, (e * 4).denominator)
        self.div = div

        def dur_div(x: F) -> int:
            v = x * 4 * div
            assert v.denominator == 1
            return int(v)

        # voices: (voice, staff), in order of appearance
        vkeys: list[tuple[str, int]] = []
        for n in sorted(ev.notes, key=lambda n: (n.onset, n.staff)):
            k = (n.voice, n.staff)
            if k not in vkeys:
                vkeys.append(k)
        vnum = {k: str(i + 1) for i, k in enumerate(sorted(vkeys, key=lambda k: (k[1], vkeys.index(k))))}

        keys = sorted(dict.fromkeys(ev.keys), key=lambda k: k[0])
        # in the order of the source (a stable sort): of two clefs at the same moment the later one counts
        clefs = sorted(dict.fromkeys(ev.clefs), key=lambda c: (c[1], c[0]))
        parts: list[str] = []
        pending_ties: dict[tuple[str, int, int], bool] = {}
        carry: dict[tuple[str, int], list[OutNote]] = {}
        last_key = None
        last_time = None
        clef_now = {1: 'treble', 2: 'bass'}
        for st in (1, 2):
            first = [c for c in clefs if c[0] == st and c[1] == 0]
            if first:
                clef_now[st] = first[-1][2]
        # 8va / 8vb lines: (time, direction) per staff; the pitches stay the sounding ones
        shifts: dict[int, list[tuple[F, str]]] = {1: [], 2: []}
        for st in (1, 2):
            now = 0
            for _, t0, n in sorted((o for o in ev.ottavas if o[0] == st), key=lambda o: o[1]):
                if n == now:
                    continue
                if now:
                    shifts[st].append((t0, self.shift_xml(st, now, stop=True)))
                if n:
                    shifts[st].append((t0, self.shift_xml(st, n)))
                now = n
            if now:
                shifts[st].append((ev.end, self.shift_xml(st, now, stop=True)))
        # an upbeat: \partial, or a first measure shortened with \set Timing.measureLength
        pickup = ev.partial is not None or (len(meas) > 1 and meas[0][1] - meas[0][0] < F(meas[0][2], meas[0][3]))
        for mi, (ms, me, num, den) in enumerate(meas):
            mlen = me - ms
            implicit = mi == 0 and pickup
            number = 0 if implicit else (mi if pickup else mi + 1)
            # a shorter measure in the middle (before and after a repeat sign) keeps its length in the app only
            # when marked implicit
            implicit_attr = ' implicit="yes"' if implicit or (0 < mi < len(meas) - 1 and mlen < F(num, den)) else ''
            x = [f'<measure number="{number}"{implicit_attr}>']
            # left barline: repeat start, ending start
            left = []
            if ms in ev.repeat_starts and ms != 0:
                left.append('<repeat direction="forward"/>')
            for no, s, e, lastend in ev.endings:
                if s == ms:
                    left.append(f'<ending number="{no}" type="start"/>')
            if left:
                x.append('<barline location="left">' + ''.join(left) + '</barline>')
            # attributes
            attrs = []
            if mi == 0:
                attrs.append(f'<divisions>{div}</divisions>')
            key_here = [k for k in keys if (k[0] == ms or (mi == 0 and k[0] <= ms))]
            if key_here and key_here[-1][1:] != last_key:
                last_key = key_here[-1][1:]
                attrs.append(f'<key><fifths>{last_key[0]}</fifths><mode>{"minor" if last_key[1] == "minor" else "major"}</mode></key>')
            elif mi == 0 and not key_here:
                last_key = (0, 'major')
                attrs.append('<key><fifths>0</fifths><mode>major</mode></key>')
            if (num, den) != last_time and not (implicit and False):
                last_time = (num, den)
                attrs.append(f'<time><beats>{num}</beats><beat-type>{den}</beat-type></time>')
            if mi == 0:
                attrs.append('<staves>2</staves>')
                for st in (1, 2):
                    attrs.append(self.clef_xml(st, clef_now[st]))
            if attrs:
                x.append('<attributes>' + ''.join(attrs) + '</attributes>')
            if mi == 0:
                tempo = self.tempo or (ev.tempos[0][1] if ev.tempos else None)
                if tempo:
                    x.append(f'<direction placement="above"><direction-type><words/></direction-type>'
                             f'<sound tempo="{tempo:g}"/></direction>')
            # staves
            first_part = True
            for st in (1, 2):
                st_keys = [k for k in vkeys if k[1] == st]
                streams = []
                for vk in st_keys:
                    items = carry.pop(vk, [])
                    items += [n for n in ev.notes if (n.voice, n.staff) == vk and ms <= n.onset < me]
                    if items:
                        streams.append((vk, items))
                shift_here = [sh for sh in shifts[st] if ms <= sh[0] < me or (mi == len(meas) - 1 and sh[0] == me)]
                if not streams:
                    if not first_part:
                        x.append(f'<backup><duration>{dur_div(mlen)}</duration></backup>')
                    x.extend(xml for _, xml in shift_here)
                    x.extend(self.rests(mlen, '1' if st == 1 else '5', st, dur_div))
                    first_part = False
                    continue
                for si, (vk, items) in enumerate(streams):
                    if not first_part:
                        x.append(f'<backup><duration>{dur_div(mlen)}</duration></backup>')
                    first_part = False
                    clef_changes = [c for c in clefs if c[0] == st and ms <= c[1] < me and not (c[1] == 0)]
                    x.extend(self.voice_xml(vk, vnum[vk], items, ms, me, num, den, si == 0, clef_changes,
                                            pending_ties, carry, dur_div, shift_here if si == 0 else []))
            # right barline
            right = []
            for no, s, e, lastend in ev.endings:
                if e == me:
                    right.append(f'<ending number="{no}" type="{"discontinue" if lastend else "stop"}"/>')
            if me in ev.repeat_ends:
                right.append('<repeat direction="backward"/>')
            final = mi == len(meas) - 1
            style = None
            for t, b in ev.bars:
                if t == me:
                    style = {'|.': 'light-heavy', '||': 'light-light', ':|.': 'light-heavy', '.|': 'heavy-light',
                             ':|': 'light-heavy', '|.|': 'light-heavy'}.get(b)
            if final:
                style = 'light-heavy'
            if me in ev.repeat_ends:
                style = 'light-heavy'
            if right or style:
                x.append('<barline location="right">' + (f'<bar-style>{style}</bar-style>' if style else '') +
                         ''.join(right) + '</barline>')
            x.append('</measure>')
            parts.append(''.join(x))
        if carry:
            raise LyError('a note runs past the end of the piece')
        head = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
                '"http://www.musicxml.org/dtds/partwise.dtd">\n'
                '<score-partwise version="4.0">'
                f'<work><work-title>{escape(self.title)}</work-title></work>'
                '<identification>'
                f'<creator type="composer">{escape(self.composer)}</creator>'
                + (f'<rights>{escape(self.rights)}</rights>' if self.rights else '') +
                '<encoding><software>ly2musicxml (Learn Piano)</software></encoding>'
                + (f'<source>{escape(self.source)}</source>' if self.source else '') +
                '</identification>'
                '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
                '<part id="P1">')
        return head + '\n'.join(parts) + '</part></score-partwise>\n'

    @staticmethod
    def shift_xml(st: int, octaves: int, stop: bool = False) -> str:
        size = {1: 8, 2: 15, 3: 22}.get(abs(octaves))
        if size is None:
            raise LyError(f'\\ottava #{octaves} is not supported')
        if stop:
            return (f'<direction><direction-type><octave-shift type="stop" size="{size}"/></direction-type>'
                    f'<staff>{st}</staff></direction>')
        kind, place = ('down', 'above') if octaves > 0 else ('up', 'below')
        return (f'<direction placement="{place}"><direction-type><octave-shift type="{kind}" size="{size}"/>'
                f'</direction-type><staff>{st}</staff></direction>')

    def clef_xml(self, st: int, name: str) -> str:
        if name not in CLEFS:
            raise LyError(f'clef {name} is not supported')
        sign, line, oc = CLEFS[name]
        return (f'<clef number="{st}"><sign>{sign}</sign><line>{line}</line>' +
                (f'<clef-octave-change>{oc}</clef-octave-change>' if oc else '') + '</clef>')

    def rests(self, length: F, voice: str, staff: int, dur_div, whole_measure: bool = True) -> list[str]:
        if whole_measure:
            return [f'<note><rest measure="yes"/><duration>{dur_div(length)}</duration><voice>{voice}</voice>'
                    f'<staff>{staff}</staff></note>']
        out = []
        for base, dots in note_values(length):
            v = (1 / base) * (2 - F(1, 2 ** dots))
            out.append(f'<note><rest/><duration>{dur_div(v)}</duration><voice>{voice}</voice>'
                       f'<type>{TYPES[base]}</type>' + '<dot/>' * dots + f'<staff>{staff}</staff></note>')
        return out

    def gap(self, length: F, voice: str, staff: int, visible: bool, dur_div) -> list[str]:
        if length <= 0:
            return []
        try:
            if visible:
                return self.rests(length, voice, staff, dur_div, whole_measure=False)
        except LyError:
            pass
        return [f'<forward><duration>{dur_div(length)}</duration><voice>{voice}</voice><staff>{staff}</staff>'
                f'</forward>']

    def voice_xml(self, vk, vno, items, ms, me, num, den, primary, clef_changes, pending_ties, carry, dur_div,
                  shifts=()):
        staff = vk[1]
        shifts = list(shifts)
        out = []
        # group into events: (onset, grace, chord id) -> notes
        events: dict[tuple, list[OutNote]] = {}
        order = []
        for n in items:
            key = (n.onset, 0 if n.grace else 1, n.chord)
            if key not in events:
                events[key] = []
                order.append(key)
            events[key].append(n)
        order.sort()
        t = ms
        beats = self.beams([events[k] for k in order], ms, num, den)
        clefs = list(clef_changes)
        for idx, key in enumerate(order):
            group = events[key]
            n0 = group[0]
            if n0.onset > t:
                if n0.onset - t > 0 and not n0.grace or n0.onset > t:
                    out.extend(self.gap(n0.onset - t, vno, staff, primary, dur_div))
                t = n0.onset
            while clefs and clefs[0][1] <= t:
                out.append('<attributes>' + self.clef_xml(staff, clefs.pop(0)[2]) + '</attributes>')
            while shifts and shifts[0][0] <= t:
                out.append(shifts.pop(0)[1])
            length = n0.dur
            split = None
            if not n0.grace and n0.onset + length > me:
                split = n0.onset + length - me
                length = me - n0.onset
            values = [(n0.base, n0.dots)] if split is None and n0.tuplet is None or n0.grace else None
            if values is None and split is None:
                values = [(n0.base, n0.dots)]
            if values is None:
                if n0.tuplet is not None:
                    raise LyError('a tuplet across a barline is not supported')
                values = note_values(length)
            # write each value (normally one); ties join the pieces
            for vi, (base, dots) in enumerate(values):
                v = length if len(values) == 1 else (1 / base) * (2 - F(1, 2 ** dots))
                last_piece = vi == len(values) - 1
                for ci, n in enumerate(group):
                    p = n.pitch
                    midi = p.midi()
                    tk = (vk[0], staff, midi)
                    tie_stop = pending_ties.pop(tk, False) or vi > 0
                    tie_start = (n.tie and last_piece and split is None) or not last_piece or (last_piece and split is not None)
                    if tie_start:
                        pending_ties[tk] = True
                    s = ['<note>']
                    if n.grace:
                        s.append('<grace/>')
                    if ci > 0:
                        s.append('<chord/>')
                    s.append(f'<pitch><step>{"CDEFGAB"[p.step]}</step>' + (f'<alter>{p.alter}</alter>' if p.alter else '')
                             + f'<octave>{p.marks}</octave></pitch>')
                    if not n.grace:
                        s.append(f'<duration>{dur_div(v)}</duration>')
                    if tie_stop:
                        s.append('<tie type="stop"/>')
                    if tie_start:
                        s.append('<tie type="start"/>')
                    s.append(f'<voice>{vno}</voice>')
                    if base not in TYPES:
                        raise LyError(f'note value 1/{base} is not supported')
                    s.append(f'<type>{TYPES[base]}</type>' + '<dot/>' * dots)
                    if n.tuplet is not None and len(values) == 1:
                        s.append(f'<time-modification><actual-notes>{n.tuplet[0]}</actual-notes>'
                                 f'<normal-notes>{n.tuplet[1]}</normal-notes></time-modification>')
                    s.append(f'<staff>{staff}</staff>')
                    if ci == 0 and vi == 0 and not n.grace:
                        b = beats.get(idx)
                        if b:
                            s.extend(f'<beam number="{lv}">{kind}</beam>' for lv, kind in b)
                    notations = []
                    if tie_stop:
                        notations.append('<tied type="stop"/>')
                    if tie_start:
                        notations.append('<tied type="start"/>')
                    if ci == 0 and n.tuplet is not None and len(values) == 1:
                        prev_same = idx > 0 and events[order[idx - 1]][0].tuplet_group == n.tuplet_group
                        next_same = idx + 1 < len(order) and events[order[idx + 1]][0].tuplet_group == n.tuplet_group
                        if not prev_same:
                            notations.append('<tuplet type="start" bracket="no"/>')
                        if not next_same:
                            notations.append('<tuplet type="stop"/>')
                    if n.fingers and vi == 0:
                        notations.append(f'<technical><fingering>{n.fingers[0]}</fingering></technical>')
                    if notations:
                        s.append('<notations>' + ''.join(notations) + '</notations>')
                    s.append('</note>')
                    out.append(''.join(s))
                if not n0.grace:
                    t += v
            if split is not None:
                for n in group:
                    cont = OutNote(n.staff, n.voice, me, split, n.pitch, [], n.tie, False, n.base, n.dots, None,
                                   None, n.chord)
                    carry.setdefault(vk, []).append(cont)
        if t < me:
            out.extend(self.gap(me - t, vno, staff, primary, dur_div))
        out.extend(xml for _, xml in shifts)  # a line that ends after the last note of the measure
        return out

    def beams(self, groups: list[list[OutNote]], ms: F, num: int, den: int) -> dict[int, list[tuple[int, str]]]:
        """Beams for the notes of one voice in one measure: notes of a beat with flags are beamed together."""
        beat = beat_of(num, den)
        if num == 3 and den == 8:
            beat = F(3, 8)
        runs: list[list[int]] = []
        cur: list[int] = []
        cur_beat = None
        end_prev = None
        for i, g in enumerate(groups):
            n = g[0]
            flagged = not n.grace and n.base >= 8 and n.onset + n.dur <= ms + 100
            b = (n.onset - ms) // beat
            if not flagged or cur_beat is not None and (b != cur_beat or end_prev != n.onset):
                if len(cur) > 1:
                    runs.append(cur)
                cur = []
                cur_beat = None
            if flagged:
                if not cur:
                    cur_beat = b
                cur.append(i)
                end_prev = n.onset + n.dur
        if len(cur) > 1:
            runs.append(cur)
        out: dict[int, list[tuple[int, str]]] = {}
        for run in runs:
            for level in (1, 2, 3):
                min_base = {1: 8, 2: 16, 3: 32}[level]
                members = [i for i in run if groups[i][0].base >= min_base]
                if not members:
                    break
                # consecutive stretches at this level
                stretches: list[list[int]] = []
                for i in members:
                    if stretches and run.index(i) == run.index(stretches[-1][-1]) + 1:
                        stretches[-1].append(i)
                    else:
                        stretches.append([i])
                for sidx, s in enumerate(stretches):
                    if len(s) == 1:
                        if level == 1:
                            continue
                        i = s[0]
                        pos = run.index(i)
                        kind = 'backward hook' if pos > 0 else 'forward hook'
                        out.setdefault(i, []).append((level, kind))
                        continue
                    for j, i in enumerate(s):
                        kind = 'begin' if j == 0 else 'end' if j == len(s) - 1 else 'continue'
                        out.setdefault(i, []).append((level, kind))
        return out


def convert(src: str, title: str, composer: str, rights, source: str, tempo: float | None,
            select: str | None = None) -> str:
    """`rights` is the text, or a function of the evaluated music (e.g. to name the fixes it made)."""
    p = Parser(src, select)
    music = p.parse_file()
    music, _ = resolve(music, None)
    ev = Evaluator()
    ev.run(music)
    if not ev.notes:
        raise LyError('no notes')
    if ev.fixed_chords:
        print(f'  fingers of {ev.fixed_chords} chord(s) were in an order no hand can play; reversed', file=sys.stderr)
    w = Writer(ev, title, composer, rights(ev) if callable(rights) else rights, source, tempo or p.midi_tempo)
    return w.write()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--title', default='')
    ap.add_argument('--composer', default='')
    ap.add_argument('--rights', default='')
    ap.add_argument('--source', default='')
    ap.add_argument('--tempo', type=float, default=None)
    ap.add_argument('--score', default=None,
                    help='take the printed scores whose text contains this (e.g. Primo), one after another')
    a = ap.parse_args()
    src = open(a.input, encoding='utf-8').read()
    try:
        xml = convert(src, a.title, a.composer, a.rights, a.source, a.tempo, a.score)
    except LyError as e:
        print(f'{a.input}: {e}', file=sys.stderr)
        sys.exit(1)
    open(a.output, 'w', encoding='utf-8').write(xml)


if __name__ == '__main__':
    main()
