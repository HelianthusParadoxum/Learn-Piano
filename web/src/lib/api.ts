/** Client for the recognition server (PDF → MusicXML via Audiveris). */

export interface ServerHealth {
  ok: boolean;
  omr: boolean;
  engine?: string;
  version?: string;
  message?: string;
}

export interface JobStatus {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  stage: string;
  message?: string;
  error?: string;
  queuePosition?: number;
  pages?: number;
  results?: { index: number; name: string }[];
  log?: string[];
}

const BASE = './api';

export async function getHealth(): Promise<ServerHealth> {
  try {
    const r = await fetch(`${BASE}/health`, { cache: 'no-store' });
    if (!r.ok) return { ok: false, omr: false, message: `Сервер ответил ${r.status}` };
    return await r.json();
  } catch {
    return { ok: false, omr: false, message: 'Сервер распознавания недоступен' };
  }
}

export async function submitPdf(file: File): Promise<JobStatus> {
  const r = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

export async function getJob(id: string): Promise<JobStatus> {
  const r = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

export async function getJobResult(id: string, index = 0): Promise<Uint8Array> {
  const r = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}/result?index=${index}`);
  if (!r.ok) throw new Error(await errorText(r));
  return new Uint8Array(await r.arrayBuffer());
}

async function errorText(r: Response): Promise<string> {
  try {
    const j = await r.json();
    return j.error || j.message || `Ошибка ${r.status}`;
  } catch {
    return `Ошибка сервера ${r.status}`;
  }
}
