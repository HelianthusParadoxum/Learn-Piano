import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { musicXmlFromBytes, parseScore } from '../web/src/lib/musicxml';

export function loadExample(name: string) {
  const bytes = readFileSync(resolve(__dirname, '../web/public/examples', name));
  return parseScore(musicXmlFromBytes(new Uint8Array(bytes), name));
}

export function loadFile(path: string) {
  const bytes = readFileSync(path);
  return parseScore(musicXmlFromBytes(new Uint8Array(bytes), path));
}
