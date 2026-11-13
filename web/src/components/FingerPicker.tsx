import { useEffect, useRef } from 'react';
import type { NoteEvent } from '../lib/model';
import type { NoteEdit } from '../lib/noteEdit';
import { FINGER_NAMES, fullNoteName, type NameStyle } from '../lib/noteNames';

/**
 * Popup for a clicked note: choose its finger and fix the note itself (a recognition error): one line
 * or space up or down, an octave, ♭ ♮ ♯, delete it or add a chord note above.
 */
export function FingerPicker(props: {
  note: NoteEvent;
  rect: DOMRect;
  nameStyle: NameStyle;
  onPick: (finger: number | null) => void;
  onClose: () => void;
  /** fix the note (absent: fingers only) */
  onEdit?: (edit: NoteEdit) => void;
  /** the last note edit can be undone */
  canUndo?: boolean;
  onUndo?: () => void;
  /** what the last edit did ("ля → соль♯") */
  lastEdit?: string;
}) {
  const { note, rect, onPick, onClose, onEdit, canUndo, onUndo, lastEdit } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const n = Number(e.key);
      if (n >= 1 && n <= 5) onPick(n);
      if (!onEdit) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        onEdit({ kind: e.shiftKey ? 'octave' : 'step', by: e.key === 'ArrowUp' ? 1 : -1 });
      } else if (e.key === 'Delete') onEdit({ kind: 'delete' });
    };
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, onPick, onEdit]);

  const height = onEdit ? 330 : 150;
  const left = Math.min(window.innerWidth - 300, Math.max(8, rect.left + rect.width / 2 - 145));
  const top = rect.bottom + 10 + height > window.innerHeight ? Math.max(8, rect.top - height - 10) : rect.bottom + 10;
  const handName = note.hand === 'L' ? 'левая рука' : 'правая рука';
  const source =
    note.fingerSource === 'user' ? 'выбран вами' : note.fingerSource === 'score' ? 'из нот' : 'подобран автоматически';

  return (
    <div ref={ref} className={`finger-picker hand-${note.hand}`} style={{ left, top }} role="dialog" aria-label="Палец и нота">
      <div className="fp-title">
        {fullNoteName(note)} — {handName}
      </div>
      <div className="fp-sub">
        Палец: {note.finger ?? '—'} ({FINGER_NAMES[note.finger ?? 0] || '—'}), {source}
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

      {onEdit && (
        <div className="fp-edit">
          <div className="fp-section">Нота распознана неверно? Исправьте её:</div>
          <div className="fp-row">
            <button className="btn small" onClick={() => onEdit({ kind: 'step', by: 1 })} title="На линию или промежуток выше (↑)">
              ▲ выше
            </button>
            <button className="btn small" onClick={() => onEdit({ kind: 'step', by: -1 })} title="На линию или промежуток ниже (↓)">
              ▼ ниже
            </button>
            <button className="btn small" onClick={() => onEdit({ kind: 'octave', by: 1 })} title="На октаву выше (Shift+↑)">
              +8
            </button>
            <button className="btn small" onClick={() => onEdit({ kind: 'octave', by: -1 })} title="На октаву ниже (Shift+↓)">
              −8
            </button>
          </div>
          <div className="fp-row">
            {(
              [
                [-1, '♭', 'бемоль'],
                [0, '♮', 'без знака (бекар)'],
                [1, '♯', 'диез'],
              ] as const
            ).map(([alter, sign, title]) => (
              <button
                key={alter}
                className={`btn small fp-sign ${note.alter === alter ? 'on' : ''}`}
                onClick={() => onEdit({ kind: 'alter', alter })}
                title={title}
              >
                {sign}
              </button>
            ))}
            <button className="btn small" onClick={() => onEdit({ kind: 'addAbove' })} title="Добавить в аккорд ноту на терцию выше">
              + нота в аккорд
            </button>
          </div>
          <div className="fp-row">
            <button className="btn small danger-outline" onClick={() => onEdit({ kind: 'delete' })} title="Удалить ноту (Delete)">
              Удалить ноту
            </button>
            {canUndo && onUndo && (
              <button className="btn small ghost" onClick={onUndo} title="Отменить последнюю правку">
                ↶ Отменить
              </button>
            )}
          </div>
          {lastEdit && <div className="fp-last muted small">{lastEdit}</div>}
          <div className="muted small">Правка сохраняется в пьесе; все правки можно сбросить в «Настройках».</div>
        </div>
      )}
    </div>
  );
}
