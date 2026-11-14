#!/usr/bin/env python3
"""
Builds the étude library of the app from the Mutopia Project's LilyPond sources: editions with the editor's
fingering.

  J. F. F. Burgmüller, 25 Études faciles et progressives, Op. 100, Nos. 1–18 (Collection Litolff; public domain)
  C. Czerny, 160 Eight-Measure Exercises, Op. 821, Nos. 1–19 (Edition Peters, 1888; public domain)
  A. Diabelli, 28 Melodische Übungsstücke, Op. 149, and Jugendfreuden, Op. 163, Sonatinas 1 and 2 — piano duets,
    the primo part (typeset by Alberto Simões; CC BY-SA 3.0)
  R. Schumann, Album für die Jugend, Op. 68, the pieces with fingering: Nos. 1, 3, 5, 36 (Peters; typeset by
    Philippe Hézaine; CC BY-SA 2.5 and 3.0)

usage: python3 scripts/mutopia-etudes.py /path/to/mutopiaproject/ftp

The Mutopia sources: https://github.com/MutopiaProject/MutopiaProject (only the folders above are needed).
Writes web/src/examples/<id>.musicxml and web/src/examples/etudes.json. A piece is taken only if its source is
public domain or under a Creative Commons Attribution-ShareAlike license; then the MusicXML names the typesetter,
the license and what was changed, and is under the same license.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ly2musicxml import LyError, convert  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'web', 'src', 'examples')

BURGMULLER = [
    (1, 'Откровенность', 'La candeur'),
    (2, 'Арабеска', 'Arabesque'),
    (3, 'Пастораль', 'Pastorale'),
    (4, 'Маленькое собрание', 'Petite réunion'),
    (5, 'Невинность', 'Innocence'),
    (6, 'Успех', 'Progrès'),
    (7, 'Чистый ручеёк', 'Le courant limpide'),
    (8, 'Грациозная', 'La gracieuse'),
    (9, 'Охота', 'La chasse'),
    (10, 'Нежный цветок', 'Tendre fleur'),
    (11, 'Трясогузка', 'La bergeronnette'),
    (12, 'Прощание', 'Adieu'),
    (13, 'Утешение', 'Consolation'),
    (14, 'Штирийский танец', 'La styrienne'),
    (15, 'Баллада', 'Ballade'),
    (16, 'Нежная жалоба', 'Douce plainte'),
    (17, 'Болтунья', 'La babillarde'),
    (18, 'Беспокойство', 'Inquiétude'),
]

# Op. 149: the tempo or the dance of each piece, as printed
DIABELLI_149 = [
    (1, 'Andante', ''), (2, 'Andante cantabile', ''), (3, 'Moderato', ''), (4, 'Allegro', ''),
    (5, 'Allegretto', ''), (6, 'Allegro и трио', 'Allegro. Trio'), (7, 'Марш и трио', 'Marcia. Trio'),
    (8, 'Moderato', ''), (9, 'Allegretto', ''), (10, 'Allegro', ''), (11, 'Романс', 'Romanze. Andantino'),
    (12, 'Andante', ''), (13, 'Allegro', ''), (14, 'Полонез и трио', 'Polonaise. Allegretto. Trio'),
    (15, 'Andante cantabile', ''), (16, 'Скерцо и трио', 'Scherzo. Allegro vivace. Trio'),
    (17, 'Рондино', 'Rondino. Allegro'), (18, 'Andante cantabile', ''), (19, 'Allegretto', ''),
    (20, 'Венгерский танец', 'Hongroise'), (21, 'Andante amoroso', ''), (22, 'Allegretto', ''),
    (23, 'Полонез', 'Polonaise'), (24, 'Andante cantabile', ''), (25, 'Allegro', ''),
    (26, 'Alla turca', 'Alla Turca. Allegro'), (27, 'Andante', ''), (28, 'Allegro', ''),
]
DIABELLI_163 = [
    (1, 1, 'Andante', ''), (1, 2, 'Allegro moderato', ''), (1, 3, 'Романс', 'Romanze. Andantino'),
    (1, 4, 'Рондо', 'Rondo. Allegro vivace'),
    (2, 1, 'Andante maestoso', ''), (2, 2, 'Allegro moderato', ''), (2, 3, 'Andantino cantabile', ''),
    (2, 4, 'Рондо', 'Rondo. Allegro moderato'),
]
ROMAN = {1: 'I', 2: 'II', 3: 'III', 4: 'IV'}
# Op. 68: only these pieces of the Mutopia edition have fingering
SCHUMANN_68 = [
    (1, 'Мелодия', 'Melodie', 'schumann-op68-01-melodie'),
    (3, 'Песенка', 'Trällerliedchen', 'schumann-op68-03-chanson-fredonnee'),
    (5, 'Пьеска', 'Stückchen', 'schumann-op68-05-petite-piece'),
    (36, 'Песня итальянских моряков', 'Lied italienischer Marinari', 'schumann-op68-36-chant-de-marins-italiens'),
]


def header(src: str, key: str) -> str:
    m = re.search(rf'^\s*{key}\s*=\s*"([^"]*)"', src, re.M)
    return m.group(1).strip() if m else ''


def license_of(src: str) -> tuple[str, str] | None:
    """('public domain', '') or ('CC BY-SA 3.0', url), None for anything else."""
    text = (header(src, 'license') + ' ' + header(src, 'copyright')).lower()
    if 'public domain' in text:
        return ('public domain', '')
    m = re.search(r'creative commons attribution-sharealike (\d\.\d)', text)
    if m:
        return (f'CC BY-SA {m.group(1)}', f'https://creativecommons.org/licenses/by-sa/{m.group(1)}/')
    return None


def rights_text(lic: tuple[str, str], typesetter: str, reference: str, primo: bool):
    if lic[0] == 'public domain':
        return f'Public domain. Typeset by {typesetter} for the Mutopia Project (www.mutopiaproject.org).'
    version = lic[0].split()[-1]

    def text(ev) -> str:
        changes = ['converted from LilyPond to MusicXML']
        if primo:
            changes.append('only the primo part of the duet')
        if ev.fixed_chords:
            changes.append(f'the fingers of {ev.fixed_chords} chord(s) put in the order of the chord notes')
        return (f'Typeset by {typesetter} for the Mutopia Project (www.mutopiaproject.org'
                + (f', {reference}' if reference else '') + '), licensed under the Creative Commons '
                f'Attribution-ShareAlike {version} License ({lic[1]}). Adapted for Learn Piano: '
                + '; '.join(changes) + '. This adaptation is licensed under the same license.')
    return text


def build(ftp: str):
    collections = []
    jobs = [
        {
            'id': 'burgmuller-100',
            'title': '25 лёгких этюдов, соч. 100',
            'composer': 'И. Ф. Ф. Бургмюллер',
            'items': [(n, f'№ {n}', ru, fr, f'BurgmullerJFF/O100/25EF-{n:02d}/25EF-{n:02d}.ly', f'{ru} (соч. 100, № {n})')
                      for n, ru, fr in BURGMULLER],
        },
        {
            'id': 'czerny-821',
            'title': '160 восьмитактовых упражнений, соч. 821',
            'composer': 'К. Черни',
            'items': [(n, f'№ {n}', f'Упражнение № {n}', '',
                       f'CzernyC/Op_821/Czerny_Op_821_No_{n:03d}/Czerny_Op_821_No_{n:03d}.ly',
                       f'Упражнение № {n} (соч. 821)') for n in range(1, 20)],
        },
        {
            'id': 'diabelli-149',
            'title': '28 мелодических упражнений в четыре руки, соч. 149 — партия primo',
            'composer': 'А. Диабелли',
            'select': 'Primo',
            'items': [(n, f'№ {n}', ru, orig,
                       f'DiabelliA/O149/diabeli.op149.{n}/diabeli.op149.{n}.ly' if n <= 2 else
                       f'DiabelliA/O149/op149-{n}/op149-{n}.ly', f'{ru} (соч. 149, № {n}, primo)')
                      for n, ru, orig in DIABELLI_149],
        },
        {
            'id': 'diabelli-163',
            'title': '«Радости юности», сонатины № 1 и 2 в четыре руки, соч. 163 — партия primo',
            'composer': 'А. Диабелли',
            'select': 'Primo',
            'items': [(k * 10 + m, f'№ {k}, ч. {ROMAN[m]}', ru, orig,
                       f'DiabelliA/O163/diabeli.op163.s{k}-{m}/diabeli.op163.s{k}-{m}.ly',
                       f'Сонатина № {k}, ч. {ROMAN[m]}: {ru} (соч. 163, primo)')
                      for k, m, ru, orig in DIABELLI_163],
        },
        {
            'id': 'schumann-68',
            'title': 'Альбом для юношества, соч. 68',
            'composer': 'Р. Шуман',
            'items': [(n, f'№ {n}', ru, de, f'SchumannR/O68/{d}/{d}.ly', f'{ru} (соч. 68, № {n})')
                      for n, ru, de, d in SCHUMANN_68],
        },
    ]
    for job in jobs:
        items = []
        editions = set()
        typesetters = set()
        licenses: dict[tuple[str, str], list[str]] = {}
        fixed = 0
        for number, label, ru, original, rel, title in job['items']:
            path = os.path.join(ftp, rel)
            src = open(path, encoding='utf-8').read()
            lic = license_of(src)
            if lic is None:
                print(f'skip {rel}: neither public domain nor CC BY-SA', file=sys.stderr)
                continue
            edition = header(src, 'source')
            typesetter = header(src, 'maintainer')
            rights = rights_text(lic, typesetter, header(src, 'footer'), bool(job.get('select')))
            stats = {}

            def counted(ev, rights=rights, stats=stats):
                stats['fixed'] = ev.fixed_chords
                return rights(ev) if callable(rights) else rights
            try:
                xml = convert(src, title, job['composer'], counted, edition if edition.lower() != 'unknown' else '',
                              None, job.get('select'))
            except LyError as e:
                print(f'skip {rel}: {e}', file=sys.stderr)
                continue
            fixed += stats.get('fixed', 0)
            if edition and edition.lower() != 'unknown':
                # 'n.d.[1888]' and 'n.d.1888' are the same edition; the app adds the full stop
                editions.add(re.sub(r'[\[\]]', '', edition).rstrip('.'))
            typesetters.add(typesetter)
            licenses.setdefault(lic, []).append(label)
            file = f'{job["id"]}-{number:02d}.musicxml'
            with open(os.path.join(OUT, file), 'w', encoding='utf-8') as f:
                f.write(xml)
            items.append({'file': file, 'number': number, 'label': label, 'title': ru,
                          'original': original if original != ru else ''})
        free = [lic for lic in licenses if lic[0] != 'public domain']
        changes = ''
        if free:
            parts = ['ноты переведены из LilyPond в MusicXML']
            if job.get('select'):
                parts.append('взята только партия primo (ученика), без партии учителя')
            if fixed:
                parts.append('в нескольких аккордах пальцы записаны по порядку нот аккорда')
            changes = 'Изменения: ' + ', '.join(parts) + '. Ноты в приложении — под той же лицензией.'
        collections.append({
            'id': job['id'],
            'title': job['title'],
            'composer': job['composer'],
            'edition': '; '.join(sorted(editions)),
            'typeset': ', '.join(sorted(typesetters)),
            # no licenses: public domain; one license: all pieces; several: the pieces (labels) under each
            'licenses': [{'name': name, 'url': url, 'items': labels if len(free) > 1 else []}
                         for (name, url), labels in sorted(licenses.items()) if name != 'public domain'],
            'changes': changes,
            'items': items,
        })
        print(f'{job["id"]}: {len(items)} pieces', file=sys.stderr)
    with open(os.path.join(OUT, 'etudes.json'), 'w', encoding='utf-8') as f:
        json.dump({'collections': collections}, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    build(sys.argv[1])
