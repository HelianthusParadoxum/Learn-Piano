/**
 * Turns an uploaded PDF or image into page canvases and cuts each page into strips, one per system
 * (a line of music: for piano, the treble and bass staves joined by a brace), so that the notes are
 * large enough when the strips are shown to Claude.
 */

import { IS_ARTIFACT } from '../platform';

const TARGET_WIDTH = 2000;
export const MAX_PAGES = 12;

export function isPdfFile(file: File) {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}

export async function renderDocument(file: File, onPage?: (page: number, pages: number) => void): Promise<HTMLCanvasElement[]> {
  if (!isPdfFile(file)) return [await imageToCanvas(file)];
  const pdfjs = await import('pdfjs-dist');
  let wasmUrl: string;
  let useWasm = true;
  if (IS_ARTIFACT) {
    // the artifact page may load scripts from the CDN but not fetch binaries: use the JS image decoders
    pdfjs.GlobalWorkerOptions.workerSrc = __CDN_PDF_WORKER__;
    wasmUrl = __CDN_PDF_WASM__;
    useWasm = false;
  } else {
    const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    wasmUrl = new URL('./pdfjs/wasm/', document.baseURI).href;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, useSystemFonts: true, wasmUrl, useWasm });
  const doc = await task.promise;
  try {
    const n = Math.min(doc.numPages, MAX_PAGES);
    const pages: HTMLCanvasElement[] = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: TARGET_WIDTH / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      pages.push(canvas);
      onPage?.(i, n);
    }
    return pages;
  } finally {
    void task.destroy();
  }
}

async function imageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

export interface Staff {
  top: number;
  bottom: number;
  spacing: number;
  left: number;
  right: number;
}

export interface StaffSystem {
  staves: Staff[];
  /** crop rectangle in page pixels */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageLayout {
  systems: StaffSystem[];
  /** area above the first system (title, composer) */
  header?: { x: number; y: number; w: number; h: number };
}

/** Finds the staves and systems of a page by looking for groups of five long horizontal lines. */
export function analyzePage(canvas: HTMLCanvasElement): PageLayout {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const px = ctx.getImageData(0, 0, W, H).data;
  const dark = new Uint8Array(W * H);
  // longest run of dark pixels in each row (gaps of up to 2 px are bridged): staff lines are long
  // and thin even on a short last line of music; text, notes and slurs are not
  const rowRun = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    let best = 0;
    let run = 0;
    let gap = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      if (lum < 150) {
        dark[y * W + x] = 1;
        if (run > 0) run += gap;
        run++;
        gap = 0;
        if (run > best) best = run;
      } else if (run > 0 && ++gap > 2) {
        run = 0;
        gap = 0;
      }
    }
    rowRun[y] = best;
  }
  const minRun = Math.max(60, Math.round(W * 0.1));
  const maxThickness = Math.max(4, Math.round(W / 400));

  // horizontal line candidates → thin lines (centre y); thick ones are beams
  const lines: number[] = [];
  for (let y = 0; y < H; ) {
    if (rowRun[y] >= minRun) {
      const start = y;
      while (y < H && rowRun[y] >= minRun) y++;
      if (y - start <= maxThickness) lines.push((start + y - 1) / 2);
    } else y++;
  }

  // five equally spaced lines make a staff (stray lines in between are skipped)
  const staves: Staff[] = [];
  const near = (target: number, tol: number, from: number) => {
    for (let k = from; k < lines.length && lines[k] <= target + tol; k++) {
      if (Math.abs(lines[k] - target) <= tol) return k;
    }
    return -1;
  };
  for (let i = 0; i < lines.length; ) {
    let found: number[] | null = null;
    for (let j = i + 1; j <= i + 3 && j < lines.length && !found; j++) {
      const sp = lines[j] - lines[i];
      if (sp < 4 || sp > 60) continue;
      const tol = Math.max(2, sp * 0.2);
      const idx = [i, j];
      for (let k = 2; k <= 4; k++) {
        const hit = near(lines[i] + k * sp, tol, idx[idx.length - 1] + 1);
        if (hit < 0) break;
        idx.push(hit);
      }
      if (idx.length === 5) found = idx;
    }
    if (found) {
      const top = lines[found[0]];
      const bottom = lines[found[4]];
      const [left, right] = lineExtent(dark, W, Math.round(top));
      staves.push({ top, bottom, spacing: (bottom - top) / 4, left, right });
      i = found[4] + 1;
    } else i++;
  }

  if (!staves.length) {
    return { systems: [{ staves: [], x: 0, y: 0, w: W, h: H }] };
  }

  // staves joined by a vertical line (system bar line or brace) belong to one system
  const groups: Staff[][] = [[staves[0]]];
  for (let i = 1; i < staves.length; i++) {
    const a = staves[i - 1];
    const b = staves[i];
    if (connected(dark, W, a, b)) groups[groups.length - 1].push(b);
    else groups.push([b]);
  }

  const systems: StaffSystem[] = groups.map((g) => {
    const sp = g.reduce((a, s) => a + s.spacing, 0) / g.length;
    const left = Math.max(0, Math.min(...g.map((s) => s.left)) - Math.round(sp * 3.5));
    const right = Math.min(W, Math.max(...g.map((s) => s.right)) + Math.round(sp * 2));
    return { staves: g, x: left, y: g[0].top - sp * 6, w: right - left, h: g[g.length - 1].bottom - g[0].top + sp * 12 };
  });
  // keep neighbouring systems apart: cut at the middle of the gap between them
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i];
    const firstTop = s.staves[0].top;
    const lastBottom = s.staves[s.staves.length - 1].bottom;
    let top = s.y;
    let bottom = s.y + s.h;
    if (i > 0) {
      const prevBottom = systems[i - 1].staves[systems[i - 1].staves.length - 1].bottom;
      top = Math.max(top, (prevBottom + firstTop) / 2);
    }
    if (i + 1 < systems.length) {
      const nextTop = systems[i + 1].staves[0].top;
      bottom = Math.min(bottom, (lastBottom + nextTop) / 2);
    }
    top = Math.max(0, Math.floor(top));
    bottom = Math.min(H, Math.ceil(bottom));
    s.y = top;
    s.h = bottom - top;
  }
  // the page header (title, composer) ends a little above the first staff
  const headerBottom = Math.floor(staves[0].top - staves[0].spacing * 2.5);
  const header = headerBottom > staves[0].spacing * 4 ? { x: 0, y: 0, w: W, h: headerBottom } : undefined;
  return { systems, header };
}

function lineExtent(dark: Uint8Array, W: number, y: number): [number, number] {
  // longest run of dark pixels on the line row (± 1 px)
  let bestStart = 0;
  let bestLen = 0;
  for (const yy of [y - 1, y, y + 1]) {
    let run = 0;
    for (let x = 0; x <= W; x++) {
      const d = x < W && dark[yy * W + x];
      if (d) run++;
      else {
        if (run > bestLen) {
          bestLen = run;
          bestStart = x - run;
        }
        run = 0;
      }
    }
  }
  return [bestStart, bestStart + bestLen];
}

function connected(dark: Uint8Array, W: number, a: Staff, b: Staff): boolean {
  const y0 = Math.ceil(a.bottom) + 2;
  const y1 = Math.floor(b.top) - 2;
  if (y1 <= y0) return true;
  if (y1 - y0 > (a.spacing + b.spacing) * 10) return false;
  const x0 = Math.min(a.left, b.left);
  for (let x = Math.max(0, x0 - 40); x < Math.min(W, x0 + 20); x++) {
    let c = 0;
    for (let y = y0; y <= y1; y++) if (dark[y * W + x]) c++;
    if (c / (y1 - y0 + 1) >= 0.85) return true;
  }
  return false;
}

/** Cuts a rectangle out of a page as a PNG. */
export function cropToBlob(canvas: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }, maxWidth = 2000): Promise<Blob> {
  const scale = Math.min(1, maxWidth / r.w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w * scale));
  c.height = Math.max(1, Math.round(r.h * scale));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}

/** A smaller copy of the page for the "original" tab. */
export function pagePreview(canvas: HTMLCanvasElement): Promise<Blob> {
  const scale = Math.min(1, 1400 / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.85));
}
