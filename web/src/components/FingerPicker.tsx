import { useEffect, useRef } from 'react';
import type { NoteEvent } from '../lib/model';
import { FINGER_NAMES, fullNoteName, type NameStyle } from '../lib/noteNames';

export function FingerPicker(props: {
  note: NoteEvent;
  rect: DOMRect;
  nameStyle: NameStyle;
  onPick: (finger: number | null) => void;
  onClose: () => void;
}) {
  const { note, rect, onPick, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const n = Number(e.key);
      if (n >= 1 && n <= 5) onPick(n);
    };
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, onPick]);

  const left = Math.min(window.innerWidth - 270, Math.max(8, rect.left + rect.width / 2 - 130));
  const top = rect.bottom + 10 + 150 > window.innerHeight ? rect.top - 160 : rect.bottom + 10;
  const handName = note.hand === 'L' ? 'левая рука' : 'правая рука';
  const source =
    note.fingerSource === 'user' ? 'выбран вами' : note.fingerSource === 'score' ? 'из нот' : 'подобран автоматически';

  return (
    <div ref={ref} className={`finger-picker hand-${note.hand}`} style={{ left, top }} role="dialog" aria-label="Выбор пальца">
      <div className="fp-title">
        {fullNoteName(note)} — {handName}
      </div>
      <div className="fp-sub">
        Сейчас: {note.finger ?? '—'} ({FINGER_NAMES[note.finger ?? 0] || '—'}), {source}
      </div>
      <div className="fp-buttons">
        {[1, 2, 3, 4, 5].map((f) => (
          <button key={f} className={note.finger === f ? 'on' : ''} onClick={() => onPick(f)} title={FINGER_NAMES[f]}>
            {f}
          </button>
        ))}
      </div>
      <div className="fp-actions">
        {note.fingerSource === 'user' && (
          <button className="btn small ghost" onClick={() => onPick(null)}>
            Вернуть автоматический
          </button>
        )}
        <span className="muted small">Остальные пальцы пересчитаются под ваш выбор.</span>
      </div>
    </div>
  );
}
