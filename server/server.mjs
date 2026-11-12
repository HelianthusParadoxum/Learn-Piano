#!/usr/bin/env node
/**
 * Learn Piano server.
 *  - serves the built web app (dist/)
 *  - recognizes sheet music (PDF / images) with Audiveris OMR and returns MusicXML
 *
 * No external dependencies: plain Node.js (>= 18).
 *
 * Environment:
 *   PORT                 HTTP port (default 8000)
 *   HOST                 bind address (default 0.0.0.0)
 *   AUDIVERIS_CMD        Audiveris launcher, e.g. /opt/audiveris/bin/Audiveris (auto-detected if empty)
 *   DATA_DIR             where uploads, results and cache live (default ./data)
 *   MAX_UPLOAD_MB        upload limit (default 40)
 *   OMR_TIMEOUT_SEC      max recognition time per file (default 900)
 *   OMR_CONCURRENCY      parallel recognitions (default 1; Audiveris needs ~1–2 GB RAM each)
 *   CACHE_DAYS           keep recognition results for N days (default 14)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';
const DIST = resolve(process.env.STATIC_DIR || join(ROOT, 'dist'));
const DATA = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 40) * 1024 * 1024;
const TIMEOUT = Number(process.env.OMR_TIMEOUT_SEC || 900) * 1000;
const CONCURRENCY = Math.max(1, Number(process.env.OMR_CONCURRENCY || 1));
const CACHE_DAYS = Number(process.env.CACHE_DAYS || 14);

const JOBS_DIR = join(DATA, 'jobs');
const CACHE_DIR = join(DATA, 'cache');
mkdirSync(JOBS_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Audiveris detection                                                 */
/* ------------------------------------------------------------------ */

function splitCommand(cmd) {
  // simple shell-like split supporting quotes
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function detectAudiveris() {
  /** @type {string[][]} */
  const candidates = [];
  // AUDIVERIS_CMD may contain arguments; quote paths with spaces: "C:\\Program Files\\Audiveris\\Audiveris.exe"
  if (process.env.AUDIVERIS_CMD) candidates.push(splitCommand(process.env.AUDIVERIS_CMD));
  for (const p of [
    '/opt/audiveris/bin/Audiveris',
    '/opt/audiveris/bin/audiveris',
    '/usr/bin/audiveris',
    '/usr/local/bin/audiveris',
    'C:\\Program Files\\Audiveris\\Audiveris.exe',
    '/Applications/Audiveris.app/Contents/MacOS/Audiveris',
    'audiveris',
    'Audiveris',
  ]) {
    candidates.push([p]);
  }
  for (const argv of candidates) {
    if (!argv.length) continue;
    const bin = argv[0];
    const isPath = bin.includes('/') || bin.includes('\\');
    if (isPath && !existsSync(bin)) continue;
    if (!isPath) {
      if (process.platform === 'win32') continue;
      const which = spawnSync('sh', ['-c', `command -v "${bin.replace(/"/g, '')}"`], { encoding: 'utf8' });
      if (which.status !== 0) continue;
    }
    return argv;
  }
  return null;
}

const audiveris = detectAudiveris();
let audiverisVersion = process.env.AUDIVERIS_VERSION || '';
if (audiveris && !audiverisVersion) {
  try {
    const r = spawnSync(audiveris[0], [...audiveris.slice(1), '-help'], { encoding: 'utf8', timeout: 60_000 });
    const m = /Audiveris\s+(?:version\s+)?v?(\d+\.\d+(?:\.\d+)?)/i.exec(`${r.stdout}\n${r.stderr}`);
    if (m) audiverisVersion = m[1];
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

const STEPS = [
  'LOAD', 'BINARY', 'SCALE', 'GRID', 'HEADERS', 'STEM_SEEDS', 'BEAMS', 'LEDGERS', 'HEADS', 'STEMS', 'REDUCTION',
  'CUE_BEAMS', 'TEXTS', 'MEASURES', 'CHORDS', 'CURVES', 'SYMBOLS', 'LINKS', 'RHYTHMS', 'PAGE',
];
const STEP_RE = new RegExp(`\\b(${STEPS.join('|')})\\b`);

/** @type {Map<string, any>} */
const jobs = new Map();
/** @type {string[]} */
const queue = [];
let running = 0;

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.min(1, Math.max(0, job.progress)),
    stage: job.stage,
    message: job.message,
    error: job.error,
    pages: job.pages || undefined,
    queuePosition: job.status === 'queued' ? queue.indexOf(job.id) + running : undefined,
    results: job.results?.map((r, index) => ({ index, name: r.name })),
    log: job.log.slice(-15),
  };
}

function sniffType(buf) {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[3] === 0x2a)) return 'tif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

function cachedResults(hash) {
  const dir = join(CACHE_DIR, hash);
  const meta = join(dir, 'results.json');
  if (!existsSync(meta)) return null;
  try {
    const list = JSON.parse(readFileSync(meta, 'utf8'));
    if (list.every((r) => existsSync(join(dir, r.file)))) return list.map((r) => ({ ...r, path: join(dir, r.file) }));
  } catch {
    /* corrupted cache entry */
  }
  return null;
}

function createJob(buf, type, filename) {
  const hash = createHash('sha256').update(buf).digest('hex');
  const id = randomUUID();
  const job = {
    id,
    hash,
    filename,
    type,
    status: 'queued',
    progress: 0,
    stage: 'queued',
    message: '',
    error: undefined,
    results: undefined,
    log: [],
    createdAt: Date.now(),
    pages: 0,
  };
  jobs.set(id, job);
  const cached = cachedResults(hash);
  if (cached) {
    job.status = 'done';
    job.progress = 1;
    job.stage = 'done';
    job.message = 'Результат взят из кэша';
    job.results = cached;
    return job;
  }
  const dir = join(JOBS_DIR, id);
  mkdirSync(dir, { recursive: true });
  // the uploaded file gets a fixed, safe name; Audiveris derives the book name from it
  job.input = join(dir, `score.${type}`);
  writeFileSync(job.input, buf);
  job.dir = dir;
  queue.push(id);
  pump();
  return job;
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job) continue;
    running++;
    runAudiveris(job)
      .catch((e) => {
        job.status = 'error';
        job.error = String(e?.message || e);
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}

function friendlyError(job, code) {
  const text = job.log.join('\n');
  if (/interline|too low resolution|resolution is too low/i.test(text)) {
    return 'Слишком низкое разрешение изображения. Нужен скан примерно 300 dpi или PDF из нотного редактора.';
  }
  if (/no staff|no system|could not find any staff|staff lines/i.test(text)) {
    return 'Audiveris не нашёл нотных станов. Проверьте, что в файле напечатанные ноты (рукописные не распознаются).';
  }
  if (/OutOfMemory/i.test(text)) return 'Серверу не хватило памяти для распознавания. Попробуйте файл с меньшим числом страниц.';
  if (code === 'timeout') return `Распознавание заняло слишком много времени (больше ${Math.round(TIMEOUT / 60000)} мин).`;
  return 'Audiveris не смог распознать ноты в этом файле.';
}

function runAudiveris(job) {
  return new Promise((resolvePromise) => {
    if (!audiveris) {
      job.status = 'error';
      job.error = 'Audiveris не установлен на сервере';
      resolvePromise();
      return;
    }
    job.status = 'running';
    job.stage = 'LOAD';
    job.progress = 0.02;
    const out = join(job.dir, 'out');
    mkdirSync(out, { recursive: true });
    const args = [...audiveris.slice(1), '-batch', '-export', '-output', out, '--', job.input];
    const env = process.env.AUDIVERIS_JAVA_OPTIONS
      ? { ...process.env, JAVA_TOOL_OPTIONS: process.env.AUDIVERIS_JAVA_OPTIONS }
      : process.env;
    // Windows .bat/.cmd launchers can only be started through the shell (all arguments are ours)
    const shell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(audiveris[0]);
    const child = spawn(shell ? `"${audiveris[0]}"` : audiveris[0], shell ? args.map((a) => `"${a}"`) : args, {
      cwd: job.dir,
      env,
      shell,
    });
    let sheet = 1;
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    };
    const handleLine = (line) => {
      if (!line.trim()) return;
      job.log.push(line.length > 300 ? line.slice(0, 300) + '…' : line);
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
      const pages = /(\d+)\s+sheets?\b/i.exec(line) || /sheets?\s*(?:count|number)?\s*[:=]\s*(\d+)/i.exec(line);
      if (pages) job.pages = Math.max(job.pages, Number(pages[1]));
      const sheetMatch = /#(\d+)\]/.exec(line) || /sheet\s*#?(\d+)/i.exec(line);
      if (sheetMatch) sheet = Math.max(sheet, Number(sheetMatch[1]));
      const step = STEP_RE.exec(line);
      if (step) {
        const idx = STEPS.indexOf(step[1]);
        job.stage = step[1];
        const total = Math.max(job.pages || 1, sheet);
        const frac = ((sheet - 1) + (idx + 1) / STEPS.length) / total;
        job.progress = Math.max(job.progress, Math.min(0.95, 0.03 + frac * 0.92));
        job.message = total > 1 ? `страница ${sheet} из ${total}` : '';
      }
      if (/export/i.test(line) && /\.mxl|musicxml|Exporting/i.test(line)) {
        job.stage = 'EXPORT';
        job.progress = Math.max(job.progress, 0.96);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT);
    child.on('error', (e) => {
      job.log.push(String(e));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer) handleLine(buffer);
      const files = findResults(out);
      if (!files.length) {
        job.status = 'error';
        job.error = friendlyError(job, timedOut ? 'timeout' : code);
        console.warn(`[omr] job ${job.id} failed (code ${code}):\n  ${job.log.slice(-10).join('\n  ')}`);
        resolvePromise();
        return;
      }
      // move results to the cache
      const cdir = join(CACHE_DIR, job.hash);
      mkdirSync(cdir, { recursive: true });
      const list = files.map((f, i) => {
        const file = `movement-${i + 1}${extname(f)}`;
        writeFileSync(join(cdir, file), readFileSync(f));
        return { name: f.split(sep).pop(), file };
      });
      writeFileSync(join(cdir, 'results.json'), JSON.stringify(list));
      job.results = list.map((r) => ({ ...r, path: join(cdir, r.file) }));
      job.status = 'done';
      job.stage = 'done';
      job.progress = 1;
      job.message = '';
      try {
        rmSync(job.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolvePromise();
    });
  });
}

function findResults(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(mxl|musicxml|xml)$/i.test(name) && !/\.opus\./i.test(name)) out.push(p);
    }
  };
  walk(dir);
  const mvt = (p) => {
    const m = /\.mvt(\d+)\./i.exec(p);
    return m ? Number(m[1]) : 0;
  };
  // prefer compressed MusicXML when both exist
  const byBase = new Map();
  for (const p of out) {
    const base = p.replace(/\.(mxl|musicxml|xml)$/i, '');
    const prev = byBase.get(base);
    if (!prev || /\.mxl$/i.test(p)) byBase.set(base, p);
  }
  return Array.from(byBase.values()).sort((a, b) => mvt(a) - mvt(b) || a.localeCompare(b));
}

// periodic cleanup of old jobs and cache entries
function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 24 * 3600_000 && job.status !== 'running' && job.status !== 'queued') jobs.delete(id);
  }
  for (const [dir, maxAge] of [
    [JOBS_DIR, 24 * 3600_000],
    [CACHE_DIR, CACHE_DAYS * 24 * 3600_000],
  ]) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (jobs.get(name)?.status === 'running') continue;
        if (now - statSync(p).mtimeMs > maxAge) rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
setInterval(cleanup, 3600_000).unref();
cleanup();

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.xml': 'application/xml',
  '.mxl': 'application/vnd.recordare.musicxml',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST + sep) && file !== DIST) {
    res.writeHead(403).end();
    return;
  }
  let target = file;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    if (extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    target = join(DIST, 'index.html'); // SPA fallback
  }
  if (!existsSync(target)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Web app is not built yet. Run: npm run build');
    return;
  }
  const ext = extname(target).toLowerCase();
  const immutable = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(target);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (path === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        omr: !!audiveris,
        engine: 'Audiveris',
        version: audiverisVersion || undefined,
        message: audiveris ? undefined : 'Audiveris не найден (переменная AUDIVERIS_CMD)',
        queue: queue.length,
        running,
      });
    }
    if (path === '/api/jobs' && req.method === 'POST') {
      if (!audiveris) return sendJson(res, 503, { error: 'Распознавание PDF недоступно: на сервере не установлен Audiveris.' });
      let buf;
      try {
        buf = await readBody(req, MAX_UPLOAD);
      } catch (e) {
        if (e.code === 413) return sendJson(res, 413, { error: `Файл больше ${Math.round(MAX_UPLOAD / 1048576)} МБ` });
        throw e;
      }
      const type = sniffType(buf);
      if (!type) return sendJson(res, 415, { error: 'Нужен PDF или изображение с нотами (PNG, JPG, TIFF).' });
      let filename = 'score';
      try {
        filename = decodeURIComponent(String(req.headers['x-filename'] || 'score')).slice(0, 200);
      } catch {
        /* ignore */
      }
      const job = createJob(buf, type, filename);
      console.log(`[omr] job ${job.id} ${job.status} (${type}, ${(buf.length / 1024).toFixed(0)} KB, "${filename}")`);
      return sendJson(res, 202, publicJob(job));
    }
    const m = /^\/api\/jobs\/([0-9a-f-]{36})(\/result)?$/.exec(path);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'Задача не найдена (возможно, сервер был перезапущен)' });
      if (!m[2]) return sendJson(res, 200, publicJob(job));
      if (job.status !== 'done' || !job.results?.length) return sendJson(res, 409, { error: 'Результат ещё не готов' });
      const idx = Math.max(0, Math.min(job.results.length - 1, Number(url.searchParams.get('index') || 0)));
      const r = job.results[idx];
      const ext = extname(r.path).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="movement-${idx + 1}${ext}"`,
        'Cache-Control': 'no-store',
      });
      return createReadStream(r.path).pipe(res);
    }
    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res, path);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Learn Piano: http://localhost:${PORT}`);
  console.log(audiveris ? `OMR: ${audiveris.join(' ')}${audiverisVersion ? ` (v${audiverisVersion})` : ''}` : 'OMR: Audiveris not found — PDF recognition disabled (set AUDIVERIS_CMD)');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
