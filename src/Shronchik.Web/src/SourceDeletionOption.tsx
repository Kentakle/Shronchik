import { useEffect, useId, useRef, useState } from 'react';
import { pickSourceDirectory, supportsSourceDeletion } from './sourceDeletion';
import type { SourceDirectory } from './sourceDeletion';
import type { Language } from './types';
import './source-deletion.css';

export function SourceDeletionOption({ language, directory, onChange, disabled = false, onBusyChange }: {
  language: Language; directory: SourceDirectory | null; onChange: (directory: SourceDirectory | null) => void;
  disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const descriptionId = useId();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const supported = supportsSourceDeletion();
  const text = (ru: string, en: string) => language === 'ru' ? ru : en;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function chooseDirectory() {
    if (disabled || picking || !supported) return;
    setError('');
    setPicking(true);
    onBusyChange?.(true);
    try {
      // Keep the picker in this click's user activation, before any await.
      const selected = await pickSourceDirectory();
      if (mounted.current) onChange(selected);
    } catch (err) {
      if (mounted.current && !(err instanceof Error && err.name === 'AbortError')) {
        setError(text('Не удалось получить доступ к папке. Выберите её ещё раз и разрешите изменение файлов.',
          'Could not access the folder. Choose it again and allow changes to its files.'));
      }
    } finally {
      if (mounted.current) setPicking(false);
      onBusyChange?.(false);
    }
  }

  return <div className="source-deletion-option">
    <label className="source-deletion-toggle">
      <input type="checkbox" checked={directory !== null} disabled={disabled || picking || !supported}
        aria-describedby={descriptionId} onChange={event => {
          if (event.target.checked) void chooseDirectory();
          else { setError(''); onChange(null); }
        }}/>
      <span>{text('Удалять оригиналы после загрузки', 'Delete originals after upload')}</span>
    </label>
    <p className="help-text" id={descriptionId}>{supported
      ? text('Выберите папку с исходниками. После успешного сохранения зашифрованной копии оригиналы удаляются без корзины. Вложенные папки не затрагиваются.',
        'Choose the source folder. Originals are deleted without the recycle bin after the encrypted copy is saved successfully. Subfolders are not affected.')
      : text('Для удаления нужен Edge или Chrome: откройте приложение через localhost или HTTPS.',
        'Deletion requires Edge or Chrome: open the app through localhost or HTTPS.')}</p>
    {(directory || picking) && <div className="source-deletion-folder">
      <span>{picking ? text('Выбираем папку…', 'Choosing a folder…') : directory?.name}</span>
      {directory && <button type="button" className="text-button" disabled={disabled || picking}
        onClick={() => { void chooseDirectory(); }}>{text('Сменить папку', 'Change folder')}</button>}
    </div>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
