// Copies Salamander Grand Piano samples (CC-BY 3.0, Alexander Holm) from node_modules into web/public/piano.
// File names with "#" are renamed ("D#4" -> "Ds4") so they are safe in URLs.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@audio-samples/piano-mp3-velocity8/package.json'));
const src = join(pkgDir, 'audio');
const dst = join(root, 'web', 'public', 'piano');
mkdirSync(dst, { recursive: true });
const names = [];
for (const f of readdirSync(src)) {
  const m = /^([A-G]#?)(\d)v\d+\.mp3$/.exec(f);
  if (!m) continue;
  const name = `${m[1].replace('#', 's')}${m[2]}.mp3`;
  const target = join(dst, name);
  if (!existsSync(target)) copyFileSync(join(src, f), target);
  names.push(name.replace('.mp3', ''));
}
writeFileSync(join(dst, 'samples.json'), JSON.stringify(names.sort()));
console.log(`piano samples: ${names.length} files in web/public/piano`);
