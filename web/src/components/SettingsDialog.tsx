import { useEffect, useState } from 'react';
import type { PieceSettings } from '../lib/model';
import type { Guide } from '../lib/piece';
import { saveFile } from '../lib/platform';
import type { PieceRecord } from '../lib/storage';

export function SettingsDialog(props: {
  rec: PieceRecord;
  guide: Guide;
  onClose: () => void;
  onChange: (s: PieceSettings) => void;
  onResetOverrides: () => void;
  onRename: (title: string) => void;
}) {
  const { rec, guide, onClose, onChange, onResetOverrides, onRename } = props;
  const s = rec.settings;
  const [title, setTitle] = useState(rec.title);
  const overrides = Object.keys(rec.overrides).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [exportNote, setExportNote] = useState('');
  const download = async (content: string, name: string, type: string) => {
    setExportNote('');
    const ok = await saveFile(name, content, type);
    if (!ok) {
      try {
        await navigator.clipboard.writeText(content);
        setExportNote('Скачивание недоступно — MusicXML скопирован в буфер обмена. Вставьте его в текстовый файл .musicxml.');
      } catch {
        setExportNote('Скачивание недоступно в этом окне.');
      }
    }
  };
  const safeName = (rec.title || 'score').replace(/[\\/:*?"<>|]+/g, '_');

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Настройки пьесы">
        <div className="modal-head">
          <h3>Настройки</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <label className="field">
          <span>Название</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && onRename(title.trim())} />
        </label>

        <div className="field">
          <span>Размер блоков</span>
          <div className="seg">
            {(['auto', 1, 2, 4, 8] as const).map((v) => (
              <button key={String(v)} className={s.blockSize === v ? 'on' : ''} onClick={() => onChange({ ...s, blockSize: v })}>
                {v === 'auto' ? 'Авто (по фразам)' : `${v} ${v === 1 ? 'такт' : v < 5 ? 'такта' : 'тактов'}`}
              </button>
            ))}
          </div>
          <small className="muted">
            Авто — блоки по музыкальным фразам с учётом плотности нот. Сейчас блоков: {guide.blocks.length}.
          </small>
        </div>

        <div className="field">
          <span>Размер руки (для аппликатуры)</span>
          <div className="seg">
            {(
              [
                ['small', 'Маленькая (ребёнок)'],
                ['medium', 'Средняя'],
                ['large', 'Большая'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} className={s.handSize === v ? 'on' : ''} onClick={() => onChange({ ...s, handSize: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Названия нот на клавишах</span>
          <div className="seg">
            <button className={s.noteNames === 'solfege' ? 'on' : ''} onClick={() => onChange({ ...s, noteNames: 'solfege' })}>
              до, ре, ми
            </button>
            <button className={s.noteNames === 'latin' ? 'on' : ''} onClick={() => onChange({ ...s, noteNames: 'latin' })}>
              C, D, E
            </button>
          </div>
        </div>

        <div className="field">
          <span>Аппликатура</span>
          <div className="row-actions">
            <button className="btn outline small" disabled={!overrides} onClick={onResetOverrides}>
              Сбросить мои изменения ({overrides})
            </button>
          </div>
        </div>

        <div className="field">
          <span>Экспорт</span>
          <div className="row-actions">
            <button className="btn outline small" onClick={() => void download(guide.renderXml, `${safeName}.musicxml`, 'application/vnd.recordare.musicxml+xml')}>
              MusicXML с аппликатурой
            </button>
            <button className="btn outline small" onClick={() => void download(rec.musicXml, `${safeName} (распознано).musicxml`, 'application/vnd.recordare.musicxml+xml')}>
              Исходный MusicXML
            </button>
          </div>
          {exportNote && <small className="export-note">{exportNote}</small>}
          <small className="muted">
            Если распознавание ошиблось, исправьте MusicXML в MuseScore и загрузите его снова — гайд пересоберётся.
          </small>
        </div>
      </div>
    </div>
  );
}
