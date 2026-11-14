#!/usr/bin/env python3
"""
Builds the étude library of the app from the Mutopia Project's LilyPond sources: public-domain editions with the
editor's fingering.

  J. F. F. Burgmüller, 25 Études faciles et progressives, Op. 100, Nos. 1–18 (Collection Litolff, 19th century)
  C. Czerny, 160 Eight-Measure Exercises, Op. 821, Nos. 1–19 (Edition Peters, 1888)

usage: python3 scripts/mutopia-etudes.py /path/to/mutopiaproject/ftp

The Mutopia sources: https://github.com/MutopiaProject/MutopiaProject (only the two folders above are needed).
Writes web/src/examples/<id>.musicxml and web/src/examples/etudes.json. Pieces whose source is not marked
public domain are skipped.
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


def header(src: str, key: str) -> str:
    m = re.search(rf'^\s*{key}\s*=\s*"([^"]*)"', src, re.M)
    return m.group(1).strip() if m else ''


def public_domain(src: str) -> bool:
    return 'public domain' in (header(src, 'license') + ' ' + header(src, 'copyright')).lower()


def build(ftp: str):
    collections = []
    jobs = [
        {
            'id': 'burgmuller-100',
            'title': '25 лёгких этюдов, соч. 100',
            'composer': 'И. Ф. Ф. Бургмюллер',
            'items': [(n, ru, fr, f'BurgmullerJFF/O100/25EF-{n:02d}/25EF-{n:02d}.ly') for n, ru, fr in BURGMULLER],
            'piece_title': lambda n, ru: f'{ru} (соч. 100, № {n})',
        },
        {
            'id': 'czerny-821',
            'title': '160 восьмитактовых упражнений, соч. 821',
            'composer': 'К. Черни',
            'items': [(n, f'Упражнение № {n}', '', f'CzernyC/Op_821/Czerny_Op_821_No_{n:03d}/Czerny_Op_821_No_{n:03d}.ly')
                      for n in range(1, 20)],
            'piece_title': lambda n, ru: f'{ru} (соч. 821)',
        },
    ]
    for job in jobs:
        items = []
        editions = set()
        typesetters = set()
        for n, ru, original, rel in job['items']:
            path = os.path.join(ftp, rel)
            src = open(path, encoding='utf-8').read()
            if not public_domain(src):
                print(f'skip {rel}: not public domain', file=sys.stderr)
                continue
            edition = header(src, 'source')
            typesetter = header(src, 'maintainer')
            editions.add(edition)
            typesetters.add(typesetter)
            rights = f'Public domain. Typeset by {typesetter} for the Mutopia Project (www.mutopiaproject.org).'
            try:
                xml = convert(src, job['piece_title'](n, ru), job['composer'], rights, edition, None)
            except LyError as e:
                print(f'skip {rel}: {e}', file=sys.stderr)
                continue
            file = f'{job["id"]}-{n:02d}.musicxml'
            with open(os.path.join(OUT, file), 'w', encoding='utf-8') as f:
                f.write(xml)
            items.append({'file': file, 'number': n, 'title': ru, 'original': original})
        collections.append({
            'id': job['id'],
            'title': job['title'],
            'composer': job['composer'],
            'edition': '; '.join(sorted(editions)),
            'typeset': ', '.join(sorted(typesetters)),
            'items': items,
        })
        print(f'{job["id"]}: {len(items)} pieces')
    with open(os.path.join(OUT, 'etudes.json'), 'w', encoding='utf-8') as f:
        json.dump({'collections': collections}, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    build(sys.argv[1])
