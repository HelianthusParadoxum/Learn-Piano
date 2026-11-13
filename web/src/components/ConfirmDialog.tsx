import { useEffect } from 'react';

/** In-page confirmation (window.confirm is not available in sandboxed hosts). */
export function ConfirmDialog(props: {
  title: string;
  text?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { title, text, confirmLabel, danger, onConfirm, onCancel } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal small-modal" role="alertdialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {text && <p className="muted">{text}</p>}
        <div className="row-actions end">
          <button className="btn outline" onClick={onCancel}>
            Отмена
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
