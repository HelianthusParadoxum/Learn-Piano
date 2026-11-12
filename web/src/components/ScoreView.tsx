import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { useEffect, useRef, useState } from 'react';
import type { Block, Hand, Score } from '../lib/model';

export interface ScoreViewProps {
  xml: string;
  score: Score;
  /** [first, last] measure index to draw; undefined draws the whole piece */
  range?: [number, number];
  zoom?: number;
  /** ids of notes to highlight (sounding now) */
  activeIds?: ReadonlySet<number>;
  /** ids of notes to mark as "selected" (e.g. fingering editor) */
  selectedId?: number | null;
  blocks?: Block[];
  currentBlock?: number;
  learned?: ReadonlySet<number>;
  onBlockClick?: (index: number) => void;
  onNoteClick?: (noteId: number, anchor: DOMRect) => void;
  /** measure to keep visible (auto-scroll during playback) */
  followMeasure?: number | null;
  compact?: boolean;
}

interface Overlay {
  block: number;
  left: number;
  top: number;
  width: number;
  height: number;
  first: boolean;
}

interface MeasureBox {
  left: number;
  top: number;
  width: number;
  height: number;
  system: unknown;
}

export const BLOCK_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316'];

export function ScoreView(props: ScoreViewProps) {
  const {
    xml, score, range, zoom = 1, activeIds, selectedId, blocks, currentBlock, learned,
    onBlockClick, onNoteClick, followMeasure, compact,
  } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const loadedXml = useRef<string | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const version = useRef(0);
  const noteEls = useRef(new Map<number, Element[]>());
  const elToNote = useRef(new Map<Element, number>());
  const highlighted = useRef(new Set<Element>());
  const measureBoxes = useRef(new Map<number, MeasureBox>());
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [measureLabels, setMeasureLabels] = useState<{ left: number; top: number; text: string }[]>([]);
  const [width, setWidth] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [layout, setLayout] = useState(0);
  const [error, setError] = useState('');

  // create the OSMD instance once (the library is loaded lazily: it is big)
  const ready = useRef<Promise<void> | null>(null);
  useEffect(() => {
    let disposed = false;
    ready.current = import('opensheetmusicdisplay').then(({ OpenSheetMusicDisplay }) => {
      if (disposed || !hostRef.current) return;
      const osmd = new OpenSheetMusicDisplay(hostRef.current, {
      backend: 'svg',
      autoResize: false,
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawLyricist: false,
      drawCredits: false,
      drawPartNames: false,
      drawPartAbbreviations: false,
      drawMeasureNumbers: true,
      measureNumberInterval: 1,
      drawFingerings: true,
      fingeringInsideStafflines: false,
      drawLyrics: false,
      disableCursor: true,
      pageFormat: 'Endless',
      newSystemFromXML: false,
      stretchLastSystemLine: false,
      });
      osmd.EngravingRules.PageLeftMargin = 1;
      osmd.EngravingRules.PageRightMargin = 1;
      osmd.EngravingRules.PageTopMargin = 1;
      osmd.EngravingRules.PageBottomMargin = 1;
      osmdRef.current = osmd;
    });
    return () => {
      disposed = true;
      try {
        osmdRef.current?.clear();
      } catch {
        /* ignore */
      }
      osmdRef.current = null;
    };
  }, []);

  // observe width changes (re-layout)
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidth((prev) => (Math.abs(prev - w) > 12 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const r0 = range?.[0];
  const r1 = range?.[1];

  useEffect(() => {
    if (!width) return;
    const my = ++version.current;
    chain.current = chain.current.then(async () => {
      await ready.current;
      const osmd = osmdRef.current;
      if (!osmd || my !== version.current) return;
      try {
        if (loadedXml.current !== xml) {
          setStatus('loading');
          await osmd.load(xml);
          loadedXml.current = xml;
          if (my !== version.current) return;
        }
        const rules = osmd.EngravingRules;
        rules.MinMeasureToDrawIndex = r0 ?? 0;
        rules.MinMeasureToDrawNumber = 0;
        rules.MaxMeasureToDrawIndex = r1 ?? Number.MAX_VALUE;
        rules.MaxMeasureToDrawNumber = Number.MAX_VALUE;
        const fragment = r0 !== undefined;
        // in fragments we draw our own measure numbers (OSMD's look exactly like fingering digits)
        rules.RenderMeasureNumbers = !fragment;
        rules.RenderMeasureNumbersOnlyAtSystemStart = true;
        rules.StretchLastSystemLine = fragment;
        rules.CompactMode = !!compact;
        osmd.Zoom = zoom;
        osmd.render();
        if (my !== version.current) return;
        buildMaps(osmd);
        setStatus('ready');
        setLayout((v) => v + 1);
      } catch (e) {
        console.error(e);
        setError(String((e as Error)?.message || e));
        setStatus('error');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml, r0, r1, zoom, width, compact]);

  function buildMaps(osmd: OpenSheetMusicDisplay) {
    // index the score's notes by (measure, staff, position, pitch)
    const index = new Map<string, { id: number; hand: Hand | null }[]>();
    const add = (k: string, id: number, hand: Hand | null) => {
      const list = index.get(k);
      if (list) list.push({ id, hand });
      else index.set(k, [{ id, hand }]);
    };
    for (const n of score.notes) {
      if (n.grace) continue;
      add(`${n.measureIndex}|${n.staffIndex}|${Math.round(n.onsetInMeasure * 1000)}|${n.midi}`, n.id, n.hand);
      for (const c of n.tieContinuations) {
        add(`${c.measureIndex}|${n.staffIndex}|${Math.round(c.onsetInMeasure * 1000)}|${n.midi}`, n.id, n.hand);
      }
    }
    const notes = new Map<number, Element[]>();
    const back = new Map<Element, number>();
    const boxes = new Map<number, MeasureBox>();
    const unit = 10 * osmd.Zoom;
    const host = hostRef.current!;
    const wrap = wrapRef.current!;
    const svg = host.querySelector('svg');
    const wr = wrap.getBoundingClientRect();
    const sr = svg?.getBoundingClientRect() ?? wr;
    const offX = sr.left - wr.left;
    const offY = sr.top - wr.top;

    for (const list of osmd.GraphicSheet.MeasureList) {
      const gms = (list || []).filter(Boolean);
      if (!gms.length) continue;
      const mIdx = gms[0].parentSourceMeasure.measureListIndex;
      // measure box (union of all staves)
      let top = Infinity;
      let bottom = -Infinity;
      let left = Infinity;
      let right = -Infinity;
      for (const gm of gms) {
        const ps = gm.PositionAndShape;
        if (!ps || !gm.ParentMusicSystem) continue;
        let x = ps.AbsolutePosition.x;
        const begin = gm.beginInstructionsWidth || 0;
        if (begin > 0) {
          // skip clef / key / time signature, but never cut off the first note
          const se = gm.staffEntries[0];
          const seLeft = se ? se.PositionAndShape.AbsolutePosition.x + se.PositionAndShape.BorderLeft - 0.9 : x + begin;
          x = Math.max(ps.AbsolutePosition.x, Math.min(x + begin, seLeft));
        }
        const y = ps.AbsolutePosition.y;
        left = Math.min(left, x);
        right = Math.max(right, ps.AbsolutePosition.x + ps.Size.width);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + 4);
      }
      if (Number.isFinite(left)) {
        boxes.set(mIdx, {
          left: offX + left * unit,
          top: offY + (top - 2.5) * unit,
          width: (right - left) * unit,
          height: (bottom - top + 5) * unit,
          system: gms[0].ParentMusicSystem,
        });
      }
      for (const gm of gms) {
        const staffIdx = gm.ParentStaff.idInMusicSheet;
        for (const se of gm.staffEntries) {
          for (const gve of se.graphicalVoiceEntries) {
            const pitched = gve.notes.filter((g) => g.sourceNote && !g.sourceNote.isRest() && g.sourceNote.Pitch);
            const sortedByPitch = pitched.slice().sort((a, b) => a.sourceNote.halfTone - b.sourceNote.halfTone);
            for (const gn of pitched) {
              const note = gn.sourceNote;
              if (note.IsGraceNote) continue;
              const rel = note.ParentVoiceEntry.Timestamp.RealValue * 4;
              const midi = note.halfTone + 12;
              const ids = index.get(`${mIdx}|${staffIdx}|${Math.round(rel * 1000)}|${midi}`);
              if (!ids?.length) continue;
              let els: Element[] = [];
              try {
                const heads = (gn as unknown as { getNoteheadSVGs(): Element[] }).getNoteheadSVGs?.() ?? [];
                if (heads.length === sortedByPitch.length) els = [heads[sortedByPitch.indexOf(gn)]].filter(Boolean);
                else els = heads;
                if (!els.length) {
                  const g = (gn as unknown as { getSVGGElement(): Element | null }).getSVGGElement?.();
                  if (g) els = [g];
                }
              } catch {
                /* graphical note without svg */
              }
              for (const { id, hand } of ids) {
                const cur = notes.get(id) ?? [];
                for (const el of els) {
                  cur.push(el);
                  back.set(el, id);
                  el.classList.add('lp-note', hand ? `lp-hand-${hand}` : 'lp-hand-x');
                }
                notes.set(id, cur);
              }
            }
          }
        }
      }
    }
    noteEls.current = notes;
    elToNote.current = back;
    measureBoxes.current = boxes;
    if (r0 !== undefined) {
      const labels: { left: number; top: number; text: string }[] = [];
      for (const [idx, b] of boxes) {
        if (idx < r0 || idx > (r1 ?? idx)) continue;
        labels.push({ left: b.left, top: b.top, text: score.measures[idx]?.number ?? String(idx + 1) });
      }
      setMeasureLabels(labels);
    } else {
      setMeasureLabels([]);
    }
    highlighted.current = new Set();
    computeOverlays();
  }

  function computeOverlays() {
    if (!blocks) {
      setOverlays([]);
      return;
    }
    const out: Overlay[] = [];
    for (const b of blocks) {
      let group: MeasureBox[] = [];
      let first = true;
      const flush = () => {
        if (!group.length) return;
        const left = Math.min(...group.map((g) => g.left));
        const right = Math.max(...group.map((g) => g.left + g.width));
        const top = Math.min(...group.map((g) => g.top));
        const bottom = Math.max(...group.map((g) => g.top + g.height));
        out.push({ block: b.index, left, top, width: right - left, height: bottom - top, first });
        first = false;
        group = [];
      };
      for (let m = b.startMeasure; m <= b.endMeasure; m++) {
        const box = measureBoxes.current.get(m);
        if (!box) continue;
        if (group.length && group[group.length - 1].system !== box.system) flush();
        group.push(box);
      }
      flush();
    }
    setOverlays(out);
  }

  // recompute overlays when the block structure changes without re-rendering the score
  useEffect(() => {
    if (status === 'ready') computeOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // highlight sounding notes
  useEffect(() => {
    const next = new Set<Element>();
    activeIds?.forEach((id) => noteEls.current.get(id)?.forEach((el) => next.add(el)));
    for (const el of highlighted.current) if (!next.has(el)) el.classList.remove('lp-on');
    for (const el of next) if (!highlighted.current.has(el)) el.classList.add('lp-on');
    highlighted.current = next;
  }, [activeIds, layout]);

  // selected note (fingering editor)
  useEffect(() => {
    hostRef.current?.querySelectorAll('.lp-selected').forEach((el) => el.classList.remove('lp-selected'));
    if (selectedId !== null && selectedId !== undefined) {
      noteEls.current.get(selectedId)?.forEach((el) => el.classList.add('lp-selected'));
    }
  }, [selectedId, layout]);

  // auto-scroll to the measure being played
  const lastFollow = useRef<number | null>(null);
  useEffect(() => {
    if (followMeasure === null || followMeasure === undefined || followMeasure === lastFollow.current) return;
    lastFollow.current = followMeasure;
    const box = measureBoxes.current.get(followMeasure);
    const wrap = wrapRef.current;
    if (!box || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const top = r.top + box.top;
    const bottom = top + box.height;
    const vh = window.innerHeight;
    if (top < 80 || bottom > vh - 40) {
      window.scrollTo({ top: window.scrollY + top - vh * 0.28, behavior: 'smooth' });
    }
  }, [followMeasure, layout]);

  const handleClick = (e: React.MouseEvent) => {
    if (!onNoteClick) return;
    const target = e.target as Element;
    const head = target.closest('.lp-note');
    let id = head ? elToNote.current.get(head) : undefined;
    if (id === undefined) {
      const group = target.closest('.vf-stavenote');
      if (group) {
        for (const [el, nid] of elToNote.current) {
          if (group.contains(el)) {
            id = nid;
            break;
          }
        }
      }
    }
    if (id !== undefined) {
      const el = noteEls.current.get(id)?.[0];
      onNoteClick(id, (el ?? target).getBoundingClientRect());
    }
  };

  const maxWidth = range ? Math.max(420, 150 + (range[1] - range[0] + 1) * 330) : undefined;

  return (
    <div
      ref={wrapRef}
      className={`score-view ${onNoteClick ? 'editable' : ''} ${range ? 'fragment' : ''}`}
      onClick={handleClick}
      style={maxWidth ? { maxWidth } : undefined}
    >
      {status === 'loading' && <div className="score-loading">Рисую ноты…</div>}
      {status === 'error' && <div className="score-error">Не удалось отрисовать ноты: {error}</div>}
      <div ref={hostRef} className="score-host" />
      {measureLabels.map((l, i) => (
        <span key={i} className="measure-label" style={{ left: l.left }} title={`Такт ${l.text}`}>
          такт {l.text}
        </span>
      ))}
      {overlays.map((o, i) => {
        const color = BLOCK_COLORS[o.block % BLOCK_COLORS.length];
        const isCurrent = o.block === currentBlock;
        const isLearned = learned?.has(o.block);
        return (
          <button
            key={i}
            type="button"
            className={`block-overlay ${isCurrent ? 'current' : ''} ${isLearned ? 'learned' : ''}`}
            style={{ left: o.left, top: o.top, width: o.width, height: o.height, ['--block-color' as string]: color }}
            title={`Блок ${o.block + 1}: такты ${score.measures[blocks![o.block].startMeasure].number}–${score.measures[blocks![o.block].endMeasure].number}. Нажмите, чтобы открыть шаг гайда`}
            onClick={(e) => {
              e.stopPropagation();
              onBlockClick?.(o.block);
            }}
          >
            {o.first && (
              <span className="block-badge">
                {isLearned ? '✓ ' : ''}
                {o.block + 1}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
