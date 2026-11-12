#!/usr/bin/env node
// TEST DOUBLE for Audiveris — used only by automated tests of the job queue and UI flow.
// It does NOT recognize anything: it prints Audiveris-like progress lines and copies a
// pre-made MusicXML file (chosen by the SHA-256 of the input) into the output folder.
//   FAKE_OMR_MAP   JSON file: { "<sha256 of input>": "/path/to/result.musicxml" }
//   FAKE_OMR_DELAY milliseconds between progress lines (default 60)
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('-help')) {
  console.log('Audiveris version 5.11.0 (fake test double)');
  process.exit(0);
}
const out = args[args.indexOf('-output') + 1];
const input = args[args.indexOf('--') + 1];
const delay = Number(process.env.FAKE_OMR_DELAY || 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = createHash('sha256').update(readFileSync(input)).digest('hex');
const map = process.env.FAKE_OMR_MAP ? JSON.parse(readFileSync(process.env.FAKE_OMR_MAP, 'utf8')) : {};
const result = map[hash];
const book = basename(input).replace(/\.[^.]+$/, '');
console.log(`INFO  []  Main | Audiveris version 5.11.0 (fake)`);
console.log(`INFO  [${book}]  Book | Loading book with 1 sheet`);
for (const step of ['LOAD', 'BINARY', 'SCALE', 'GRID', 'HEADERS', 'STEM_SEEDS', 'BEAMS', 'LEDGERS', 'HEADS', 'STEMS', 'REDUCTION', 'CUE_BEAMS', 'TEXTS', 'MEASURES', 'CHORDS', 'CURVES', 'SYMBOLS', 'LINKS', 'RHYTHMS', 'PAGE']) {
  console.log(`INFO  [${book}#1]  StepMonitor | Step ${step} starting`);
  await sleep(delay);
}
if (!result) {
  console.error(`WARN  [${book}#1]  Sheet | No staff found in sheet`);
  process.exit(1);
}
const target = join(out, `${book}.musicxml`);
copyFileSync(result, target);
console.log(`INFO  [${book}]  BookExporter | Exporting book to ${target}`);
