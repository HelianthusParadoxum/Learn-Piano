// Integration test of the recognition server. Audiveris is replaced by the test double
// server/test/fake-audiveris.mjs (it only replays progress and returns a known MusicXML).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

const pdf = readFileSync(join(ROOT, 'samples/pdf/ode-to-joy.pdf'));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-test-'));
  const map = { [createHash('sha256').update(pdf).digest('hex')]: join(ROOT, 'web/public/examples/ode-to-joy.musicxml') };
  writeFileSync(join(dir, 'map.json'), JSON.stringify(map));
  server = spawn(process.execPath, [join(ROOT, 'server/server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: join(dir, 'data'),
      AUDIVERIS_CMD: `"${process.execPath}" "${join(ROOT, 'server/test/fake-audiveris.mjs')}"`,
      FAKE_OMR_MAP: join(dir, 'map.json'),
      FAKE_OMR_DELAY: '5',
    },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

afterAll(() => {
  server?.kill();
});

async function waitJob(id: string) {
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (st.status === 'done' || st.status === 'error') return st;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

describe('recognition server', () => {
  it('reports OMR availability', async () => {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    expect(h.ok).toBe(true);
    expect(h.omr).toBe(true);
  });

  it('recognizes a PDF and serves the MusicXML, then answers from cache', async () => {
    const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: pdf, headers: { 'X-Filename': 'ode.pdf' } });
    expect(r.status).toBe(202);
    const job = await r.json();
    const st = await waitJob(job.id);
    expect(st.status).toBe('done');
    expect(st.results).toHaveLength(1);
    const xml = await (await fetch(`${BASE}/api/jobs/${job.id}/result?index=0`)).text();
    expect(xml).toContain('<score-partwise');
    const again = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', body: pdf })).json();
    expect(again.status).toBe('done');
  });

  it('rejects files that are not sheet music images or PDFs', async () => {
    const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: 'hello' });
    expect(r.status).toBe(415);
  });

  it('reports a readable error when nothing is recognized', async () => {
    const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: Buffer.from('%PDF-1.4\n%empty\n') });
    const st = await waitJob((await r.json()).id);
    expect(st.status).toBe('error');
    expect(st.error).toMatch(/нотных станов/);
  });

  it('does not serve files outside the web root', async () => {
    const r = await fetch(`${BASE}/..%2f..%2fpackage.json`);
    expect([403, 404]).toContain(r.status);
  });
});
