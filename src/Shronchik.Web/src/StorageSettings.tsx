import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, mutate, postJsonStream } from './api';
import { formatBytes, Modal } from './Dialogs';
import { errorMessage, strings } from './i18n';
import { Icon } from './Icon';
import type { Language } from './types';

type StorageInfo = { mediaRoot: string; databaseRoot: string; freeBytes: number | null; available: boolean; checkedAt?: string; sourceRetained?: boolean };
type FolderInfo = { path: string | null; parentPath: string | null; folders: { name: string; path: string }[]; isLibrary: boolean };
type StorageAction = 'move' | 'connect';
type MoveProgress = { phase: 'preparing' | 'copying' | 'verifying' | 'finishing' | 'completed'; bytesCompleted: number; totalBytes: number; filesCompleted: number; totalFiles: number; percent: number };
type MoveEvent = ({ type: 'progress' } & MoveProgress) | { type: 'complete'; storage: StorageInfo } | { type: 'error'; code: string };
const initialProgress: MoveProgress = { phase: 'preparing', bytesCompleted: 0, totalBytes: 0, filesCompleted: 0, totalFiles: 0, percent: 0 };

function storageError(error: unknown, language: Language) {
  const messages: Record<string, [string, string]> = {
    storage_busy: ['Хранилище сейчас переключается. Подождите и повторите попытку.', 'Storage is switching. Please wait and try again.'],
    invalid_storage_path: ['Выберите другую папку. Путь должен быть полным и не пересекаться с текущей библиотекой.', 'Choose another folder. Use a full path outside the current library.'],
    storage_not_empty: ['Для переноса нужна пустая или новая папка.', 'Choose an empty or new folder for the move.'],
    invalid_library: ['В этой папке нет поддерживаемой библиотеки. Выберите папку с library.json, db и vault.', 'This folder does not contain a supported library. Choose the folder containing library.json, db, and vault.'],
    library_in_use: ['Эта библиотека уже открыта другим экземпляром приложения.', 'This library is already open in another instance of the application.'],
    insufficient_storage: ['На выбранном диске недостаточно свободного места.', 'There is not enough free space on the selected drive.'],
    invalid_credentials: ['Неверный пароль Admin выбранной библиотеки.', 'Incorrect Admin password for the selected library.'],
    weak_library_passwords: ['Для подключения при HTTPS-хостинге сначала смените слабые пароли пользователей в выбранной библиотеке.', 'Before connecting this library while HTTPS hosting is enabled, change its weak user passwords.'],
    storage_unavailable: ['Не удалось открыть папку или перенести данные. Проверьте путь, доступ к диску и права записи.', 'Could not open the folder or move the data. Check the path, disk access, and write permissions.'],
    folder_picker_busy: ['Окно выбора папки уже открыто. Выберите папку или отмените выбор в этом окне.', 'The folder chooser is already open. Choose a folder or cancel in that window.'],
    folder_picker_unavailable: ['Не удалось открыть окно Windows. Выберите папку в списке ниже или введите полный путь.', 'Could not open the Windows folder chooser. Choose a folder from the list below or enter a full path.'],
    incomplete_storage_move: ['Связь с сервером прервалась до подтверждения переноса. Проверьте хранилище, чтобы узнать текущее расположение библиотеки.', 'The connection ended before the move was confirmed. Check storage to see the current library location.'],
  };
  const localized = error instanceof ApiError ? messages[error.code] : undefined;
  return localized ? localized[language === 'ru' ? 0 : 1] : errorMessage(error, strings(language));
}

export function StorageSettings({ language }: { language: Language }) {
  const [status, setStatus] = useState<StorageInfo | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<StorageAction | null>(null);
  const checking = useRef(false);
  const t = strings(language);
  const text = (ru: string, en: string) => language === 'ru' ? ru : en;
  useEffect(() => {
    const controller = new AbortController();
    void api<StorageInfo>('/storage', { signal: controller.signal }).then(setStatus)
      .catch(err => { if (!controller.signal.aborted) setError(storageError(err, language)); });
    return () => controller.abort();
  }, [language]);
  async function check() {
    if (checking.current) return;
    checking.current = true;
    setBusy(true); setError(''); setSuccess('');
    try { setStatus(await mutate<StorageInfo>('/storage/check', 'POST')); }
    catch (err) { setError(storageError(err, language)); }
    finally { checking.current = false; setBusy(false); }
  }
  return <div className="settings-storage-status">
    {status && <dl>
      <div><dt>{text('Каталог библиотеки на сервере', 'Library directory on the server')}</dt><dd>{status.mediaRoot}</dd></div>
      <div><dt>{text('Каталог базы данных на сервере', 'Database directory on the server')}</dt><dd>{status.databaseRoot}</dd></div>
      <div><dt>{text('Свободно на сервере', 'Free space on the server')}</dt><dd>{status.freeBytes == null ? '—' : formatBytes(status.freeBytes)}</dd></div>
      <div><dt>{text('Состояние', 'Status')}</dt><dd>{status.available ? text('Доступно', 'Available') : text('Недоступно', 'Unavailable')}</dd></div>
      {status.checkedAt && <div><dt>{text('Проверено', 'Checked')}</dt><dd>{new Date(status.checkedAt).toLocaleString(language)}</dd></div>}
    </dl>}
    <div className="storage-action-buttons">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void check(); }}>
        {busy ? t.loading : text('Проверить хранилище', 'Check storage')}
      </button>
      <button type="button" className="secondary-button" disabled={busy || !status} onClick={() => { setSuccess(''); setAction('move'); }}>
        <Icon name="arrow" size={16}/>{text('Перенести БД', 'Move database')}
      </button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { setSuccess(''); setAction('connect'); }}>
        <Icon name="album" size={16}/>{text('Подключить БД', 'Connect database')}
      </button>
    </div>
    <p className="help-text storage-action-help">{text(
      'Выберите папку на компьютере с сервером. Библиотека включает базу данных, медиафайлы, аккаунты и настройки.',
      'Choose a folder on the server computer. A library includes the database, media, accounts, and settings.')}</p>
    {error && <p className="error-text" role="alert">{error}</p>}
    {success && <p className="success-text" role="status"><Icon name="check" size={16}/>{success}</p>}
    {action && <StorageFolderDialog action={action} language={language} currentRoot={status?.mediaRoot ?? ''}
      onClose={() => setAction(null)} onMoved={value => {
        setStatus(value); setAction(null); setError('');
        setSuccess(value.sourceRetained ? text(
          'Библиотека перенесена по новому пути. Исходная папка очищена не полностью: проверьте оставшиеся файлы. Новый путь сохранён для следующих запусков.',
          'The library has moved to the new path. The original folder was not fully cleaned up: check the remaining files. The new path is saved for future launches.')
          : text('Библиотека перенесена. Новый путь сохранён для следующих запусков.', 'The library has been moved. The new path is saved for future launches.'));
      }}/>} 
  </div>;
}

function StorageFolderDialog({ action, language, currentRoot, onClose, onMoved }: {
  action: StorageAction; language: Language; currentRoot: string; onClose: () => void; onMoved: (status: StorageInfo) => void;
}) {
  const [folders, setFolders] = useState<FolderInfo | null>(null);
  const [path, setPath] = useState(currentRoot);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState<MoveProgress>(initialProgress);
  const request = useRef<AbortController | null>(null);
  const pickerRequest = useRef<AbortController | null>(null);
  const choosing = useRef(false);
  const submitting = useRef(false);
  const pathId = useId();
  const passwordId = useId();
  const progressId = useId();
  const t = strings(language);
  const text = (ru: string, en: string) => language === 'ru' ? ru : en;
  const moving = action === 'move';
  const navigating = loading || picking;

  async function pickFolder() {
    if (choosing.current || loading || submitting.current) return;
    choosing.current = true;
    const controller = new AbortController();
    pickerRequest.current = controller;
    setPicking(true); setError('');
    try {
      const result = await api<{ path: string | null }>('/storage/folders/pick', {
        method: 'POST', body: JSON.stringify({ path: path.trim() || undefined }), signal: controller.signal,
      });
      if (!controller.signal.aborted && result.path) {
        setPath(result.path);
        await browse(result.path);
      }
    } catch (err) { if (!controller.signal.aborted) setError(storageError(err, language)); }
    finally { choosing.current = false; if (!controller.signal.aborted) setPicking(false); }
  }

  async function browse(destination: string | null) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const value = await api<FolderInfo>(`/storage/folders${destination ? `?path=${encodeURIComponent(destination)}` : ''}`, { signal: controller.signal });
      if (!controller.signal.aborted) { setFolders(value); setPath(value.path ?? ''); }
    } catch (err) {
      if (!controller.signal.aborted) setError(storageError(err, language));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    void browse(currentRoot || null);
    return () => { request.current?.abort(); pickerRequest.current?.abort(); };
    // The initial directory belongs to this dialog; later navigation is explicit.
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !selectedPath || (!moving && !password)) return;
    submitting.current = true;
    setBusy(true); setError(''); setProgress(initialProgress);
    try {
      if (moving) {
        let result: StorageInfo | null = null;
        await postJsonStream<MoveEvent>('/storage/move', { path: selectedPath }, event => {
          if (!event || typeof event !== 'object') throw new ApiError(502, 'incomplete_storage_move');
          if (event.type === 'error') throw new ApiError(503, event.code);
          if (event.type === 'complete' && event.storage?.mediaRoot) { result = event.storage; return; }
          if (event.type !== 'progress' || !Number.isFinite(event.percent)) throw new ApiError(502, 'incomplete_storage_move');
          setProgress(previous => ({ ...event, percent: Math.max(previous.percent, Math.min(99, Math.max(0, event.percent))) }));
        });
        if (!result) throw new ApiError(502, 'incomplete_storage_move');
        setProgress(previous => ({ ...previous, phase: 'completed', percent: 100 }));
        onMoved(result);
      } else {
        await mutate<StorageInfo>('/storage/connect', 'POST', { path: selectedPath, password });
        setPassword('');
        window.location.reload();
      }
    } catch (err) { setError(storageError(err, language)); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <Modal title={moving ? text('Перенос БД', 'Move database') : text('Подключение БД', 'Connect database')}
    closeLabel={t.close} onClose={() => { if (!submitting.current && !choosing.current) onClose(); }} className="storage-folder-dialog">
    {selectedPath === null ? <>
      <p className="help-text">{moving ? text('Выберите пустую папку или укажите полный путь к новой папке.', 'Choose an empty folder or enter the full path to a new folder.')
        : text('Выберите папку существующей библиотеки с файлом library.json.', 'Choose the existing library folder containing library.json.')}</p>
      <form className="storage-path-form" onSubmit={event => { event.preventDefault(); if (!navigating) void browse(path.trim() || null); }}>
        <label htmlFor={pathId}>{text('Папка на сервере', 'Folder on the server')}</label>
        <div><input id={pathId} type="text" autoComplete="off" value={path} disabled={navigating} spellCheck={false}
          onChange={event => { setPath(event.target.value); setError(''); }}/>
          <button type="button" className="secondary-button" disabled={navigating} onClick={() => { void pickFolder(); }}>{picking && <span className="spinner"/>}{text('Открыть', 'Open')}</button></div>
        <button type="submit" className="text-button storage-go-path" disabled={navigating}>{text('Перейти по пути', 'Go to path')}</button>
      </form>
      {picking && <p className="help-text" role="status">{text('Выберите папку в открывшемся окне Windows.', 'Choose a folder in the Windows window that opened.')}</p>}
      <div className="storage-folder-nav">
        <button type="button" className="text-button" disabled={navigating} onClick={() => { void browse(null); }}>{text('Диски', 'Drives')}</button>
        <button type="button" className="text-button" disabled={navigating || !folders?.path} onClick={() => { void browse(folders?.parentPath ?? null); }}>
          <Icon name="back" size={16}/>{text('На уровень выше', 'Up one level')}
        </button>
      </div>
      <div className="storage-folder-list" aria-busy={loading} aria-label={text('Папки', 'Folders')}>
        {loading ? <p role="status"><span className="spinner"/>{t.loading}</p> : folders?.folders.length ? folders.folders.map(folder =>
          <button type="button" key={folder.path} disabled={picking} onClick={() => { void browse(folder.path); }} title={folder.path}>
            <Icon name="album" size={18}/><span>{folder.name}</span><Icon name="chevron" size={16}/>
          </button>) : <p className="help-text">{text('Вложенных папок нет.', 'No subfolders.')}</p>}
      </div>
      {!loading && folders?.isLibrary && path === folders.path && <p className="storage-library-found"><Icon name="check" size={16}/>{text('Найдена библиотека', 'Library found')}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={picking} onClick={onClose}>{t.cancel}</button>
        <button type="button" className="primary-button" disabled={navigating || !path.trim()} onClick={() => {
          request.current?.abort(); setSelectedPath(path.trim()); setPassword(''); setError('');
        }}>{text('Выбрать папку', 'Choose folder')}</button>
      </div>
    </> : <form onSubmit={event => { void submit(event); }}>
      {moving && <><p className="storage-path-caption">{text('Текущая библиотека', 'Current library')}</p><p className="storage-selected-path">{currentRoot}</p></>}
      <p className="storage-path-caption">{moving ? text('Перенести в папку', 'Move to folder') : text('Подключить библиотеку', 'Connect library')}</p>
      <p className="storage-selected-path">{selectedPath}</p>
      <p className="help-text">{moving ? text(
        'Все данные библиотеки будут перенесены вместе. Во время переноса воспроизведение и загрузки остановятся. Новый путь сохранится автоматически.',
        'All library data will move together. Playback and uploads will stop during the move. The new path will be saved automatically.') : text(
        'Введите пароль Admin выбранной библиотеки для проверки. Затем все сеансы завершатся: войдите с аккаунтом подключённой библиотеки. Её медиа и настройки загрузятся автоматически.',
        'Enter the selected library’s Admin password to verify it. All sessions will then end: sign in with an account from that library. Its media and settings will load automatically.')}</p>
      {!moving && <div className="storage-password-field"><label htmlFor={passwordId}>{text('Пароль Admin выбранной БД', 'Selected database Admin password')}</label>
        <input id={passwordId} type="password" value={password} disabled={busy} autoComplete="off" required maxLength={1024}
          onChange={event => { setPassword(event.target.value); setError(''); }}/></div>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {busy && moving && <div className="storage-move-progress">
        <div className="storage-progress-heading"><span id={progressId}>{progress.phase === 'preparing' ? text('Подготовка переноса', 'Preparing the move')
          : progress.phase === 'copying' ? text('Копирование файлов', 'Copying files')
            : progress.phase === 'verifying' ? text('Проверка скопированных данных', 'Verifying copied data')
              : text('Завершение переноса', 'Finishing the move')}</span><strong>{Math.round(progress.percent)}%</strong></div>
        <progress max={100} value={progress.percent} aria-labelledby={progressId}/>
        <p className="help-text" role="status">{progress.totalBytes > 0 ? `${formatBytes(progress.bytesCompleted)} / ${formatBytes(progress.totalBytes)}` : text('Подсчёт данных…', 'Counting data…')}
          {progress.totalFiles > 0 && <span>{text('Файлы', 'Files')}: {progress.filesCompleted} / {progress.totalFiles}</span>}</p>
      </div>}
      {busy && !moving && <p className="help-text" role="status">{text('Проверка и подключение библиотеки…', 'Verifying and connecting the library…')}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setSelectedPath(null); setPassword(''); setError(''); }}>{text('Назад', 'Back')}</button>
        <button type="submit" className="primary-button" disabled={busy || (!moving && !password)}>{busy && <span className="spinner"/>}{moving ? text('Перенести сюда', 'Move here') : text('Подключить', 'Connect')}</button>
      </div>
    </form>}
  </Modal>;
}
