import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, upload } from './api';
import { formatBytes, Modal } from './Dialogs';
import { Icon } from './Icon';
import { errorMessage } from './i18n';
import { acceptsImportFile, importFormats } from './importFormats';
import type { T } from './i18n';
import { TagPicker } from './TagPicker';
import { SourceDeletionOption } from './SourceDeletionOption';
import { deleteImportedSource, prepareSource } from './sourceDeletion';
import type { PreparedSource, SourceDirectory } from './sourceDeletion';
import type { Language, Media } from './types';
import './album-import.css';

type Photo = { id: number; file: File; status: 'pending' | 'uploading' | 'done' | 'error'; progress: number;
  error?: string; sourceToDelete?: PreparedSource; sourceError?: string; sourceDeleted?: boolean };
type UploadRun = { stopped: boolean; cancel: (() => void) | null };

export function albumImportLabel(language: Language) {
  return language === 'ru' ? 'Загрузить альбом' : 'Upload album';
}

export function AlbumImportDialog({ t, language, allowSourceDeletion = false, onClose }: {
  t: T; language: Language; allowSourceDeletion?: boolean; onClose: (imported: number) => void;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tags, setTags] = useState('');
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [sourceDirectory, setSourceDirectory] = useState<SourceDirectory | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const imported = useRef(0);
  const activeRun = useRef<UploadRun | null>(null);
  const mounted = useRef(true);
  const text = (ru: string, en: string) => language === 'ru' ? ru : en;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const run = activeRun.current;
      if (run) { run.stopped = true; run.cancel?.(); }
    };
  }, []);

  function choose(files: FileList | null) {
    if (!files?.length || started) return;
    const selected = Array.from(files);
    if (selected.some(file => !acceptsImportFile(file, 'photo'))) {
      setError(text('Для альбома выберите только фотографии PNG, JPEG или WebP.', 'Choose only PNG, JPEG or WebP photos for the album.'));
      return;
    }
    if (selected.some(file => file.size === 0)) {
      setError(text('В подборке есть пустой файл. Выберите фотографии ещё раз.', 'The selection contains an empty file. Choose the photos again.'));
      return;
    }
    setError('');
    setPhotos(previous => {
      const keys = new Set(previous.map(photo => fileKey(photo.file)));
      const additions = selected.filter(file => {
        const key = fileKey(file);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      }).map(file => ({ id: nextId.current++, file, status: 'pending' as const, progress: 0 }));
      return [...previous, ...additions];
    });
  }
  function update(id: number, patch: Partial<Photo>) {
    if (mounted.current) setPhotos(previous => previous.map(photo => photo.id === id ? { ...photo, ...patch } : photo));
  }
  function stop() {
    const run = activeRun.current;
    if (run) { run.stopped = true; run.cancel?.(); }
  }
  function close() { stop(); onClose(imported.current); }
  async function removeSource(photo: Photo, prepared: PreparedSource, run: UploadRun) {
    if (!allowSourceDeletion) return;
    try {
      if (await deleteImportedSource(prepared, () => run.stopped)) {
        update(photo.id, { sourceToDelete: undefined, sourceError: undefined, sourceDeleted: true });
        return;
      }
    } catch { /* The import stays successful; retry only the source deletion. */ }
    update(photo.id, { sourceToDelete: prepared, sourceError: text(
      'Оригинал сохранён. Проверьте доступ к папке и убедитесь, что файл не изменился.',
      'Original kept. Check folder access and make sure the file has not changed.') });
  }
  async function retryDeletion() {
    if (!allowSourceDeletion || activeRun.current) return;
    const run: UploadRun = { stopped: false, cancel: null };
    activeRun.current = run;
    setBusy(true);
    try {
      for (const photo of photos) {
        if (run.stopped) break;
        if (photo.status === 'done' && photo.sourceToDelete) await removeSource(photo, photo.sourceToDelete, run);
      }
    } finally {
      activeRun.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (activeRun.current || pickingDirectory || !photos.length) return;
    const pending = photos.filter(photo => photo.status !== 'done');
    if (!pending.length) { close(); return; }
    const tagList = tags.split(',').map(tag => tag.trim()).filter(Boolean);
    if (tagList.length > 30 || tagList.some(tag => tag.length > 64)) {
      setError(text('Выберите до 30 тегов длиной не более 64 символов каждый.', 'Choose up to 30 tags, each at most 64 characters long.'));
      return;
    }
    setError('');
    setStarted(true);
    setBusy(true);
    const run: UploadRun = { stopped: false, cancel: null };
    activeRun.current = run;
    // The server encrypts one original at a time. Keep the album in this same queue.
    try {
      for (const photo of pending) {
        if (run.stopped) break;
        update(photo.id, { status: 'uploading', progress: 0, error: undefined });
        const title = photo.file.name.replace(/\.[^.]+$/, '').trim().slice(0, 200) || photo.file.name.slice(0, 200);
        try {
          let prepared: PreparedSource | null = null;
          if (allowSourceDeletion && sourceDirectory) {
            try { prepared = await prepareSource(photo.file, sourceDirectory, () => run.stopped); }
            catch {
              update(photo.id, { status: run.stopped ? 'pending' : 'error', progress: 0, error: run.stopped ? undefined : text(
                'Оригинал не найден в выбранной папке или изменился. Файл не загружен.',
                'The original is missing from the selected folder or has changed. The file was not uploaded.') });
              continue;
            }
          }
          if (run.stopped) { update(photo.id, { status: 'pending', progress: 0 }); break; }
          const request = upload<Media>(prepared?.file ?? photo.file, 'photo', title, tags, progress => {
            if (!run.stopped) update(photo.id, { progress });
          });
          run.cancel = request.cancel;
          await request.promise;
          run.cancel = null;
          imported.current++;
          update(photo.id, { status: 'done', progress: 100, sourceToDelete: prepared ?? undefined });
          if (prepared) await removeSource(photo, prepared, run);
        } catch (err) {
          update(photo.id, { status: run.stopped ? 'pending' : 'error', progress: 0,
            error: run.stopped ? undefined : errorMessage(err, t) });
          // A locked/expired session, full disk or unavailable server cannot accept the rest.
          if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 423 || err.status === 0 ||
            err.code === 'low_disk_space' || err.code === 'import_busy')) {
            if (!run.stopped && mounted.current) setError(errorMessage(err, t));
            break;
          }
        } finally { run.cancel = null; }
      }
    } finally {
      activeRun.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  const done = photos.filter(photo => photo.status === 'done').length;
  const failed = photos.filter(photo => photo.status === 'error').length;
  const totalBytes = photos.reduce((sum, photo) => sum + photo.file.size, 0);
  const uploadedBytes = photos.reduce((sum, photo) => sum + photo.file.size * photo.progress / 100, 0);
  const progress = totalBytes ? Math.floor(uploadedBytes / totalBytes * 100) : 0;
  const complete = photos.length > 0 && done === photos.length;
  const retainedSources = photos.filter(photo => photo.status === 'done' && photo.sourceToDelete).length;

  return <Modal title={albumImportLabel(language)} closeLabel={t.close} onClose={close} className="album-import-modal" wide>
    <form className="album-import-form" onSubmit={event => { void submit(event); }}>
      <p className="help-text album-import-intro">{text('Выберите все фотографии и задайте теги один раз — они будут добавлены к каждому фото.',
        'Select all photos and choose tags once — they will be applied to every photo.')}</p>
      <div className="album-import-panels">
        <section className="album-import-files" aria-label={text('Фотографии альбома', 'Album photos')}>
          <button type="button" className={`drop-zone ${dragging ? 'dragging' : ''}`} disabled={started}
            onClick={() => input.current?.click()}
            onDragOver={event => { event.preventDefault(); if (!started) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}>
            <span className="drop-icon"><Icon name="album" size={26}/></span>
            <strong>{text('Перетащите фотографии сюда', 'Drop photos here')}</strong>
            <span>{text('Выбрать несколько фотографий', 'Choose multiple photos')}</span>
            <small>{importFormats.photo.label}</small>
          </button>
          <input ref={input} className="visually-hidden" type="file" multiple accept={importFormats.photo.extensions.join(',')}
            aria-label={text('Выбрать фотографии альбома', 'Choose album photos')} disabled={started}
            onChange={event => { choose(event.target.files); event.target.value = ''; }}/>
          {allowSourceDeletion && <SourceDeletionOption language={language} directory={sourceDirectory} onChange={setSourceDirectory}
            disabled={busy} onBusyChange={setPickingDirectory}/>}
          {photos.length > 0 && <>
            <div className="album-import-summary"><strong>{text('Фотографий', 'Photos')}: {photos.length}</strong><span>{formatBytes(totalBytes)}</span></div>
            <ul className="album-import-list">{photos.map(photo => <li key={photo.id} className="album-import-photo" data-status={photo.status}
              data-source-error={photo.sourceError ? true : undefined}>
              <PhotoPreview file={photo.file}/>
              <div className="album-import-photo-info"><strong title={photo.file.name}>{photo.file.name}</strong>
                <small>{photo.status === 'done' ? `${text('Добавлено', 'Added')}${photo.sourceDeleted ? text(' · оригинал удалён', ' · original deleted') : photo.sourceError ? ` · ${photo.sourceError}` : ''}` : photo.status === 'error' ? photo.error
                  : photo.status === 'uploading' ? `${photo.progress === 100 ? t.encrypting : t.uploading} · ${photo.progress}%`
                    : text('В очереди', 'Queued')}</small>
              </div>
              {photo.status === 'done' ? <Icon name="check" size={18}/>
                : photo.status === 'uploading' ? <span className="spinner"/>
                  : !started && <button type="button" className="icon-button" aria-label={`${text('Убрать', 'Remove')} ${photo.file.name}`}
                    onClick={() => setPhotos(previous => previous.filter(item => item.id !== photo.id))}><Icon name="close" size={16}/></button>}
            </li>)}</ul>
          </>}
        </section>
        <section className="album-import-tags" aria-label={text('Общие теги', 'Shared tags')}>
          <TagPicker value={tags} onChange={setTags} language={language} disabled={started}/>
          {started && !complete && <p className="help-text">{text('Теги сохранены для всей подборки, включая повторную загрузку.', 'These tags also apply when retrying this selection.')}</p>}
        </section>
      </div>
      {started && <div className="upload-progress album-import-progress" role="status" aria-live="polite">
        <div><span>{text('Добавлено', 'Added')}: {done} / {photos.length}{failed > 0 ? ` · ${text('Ошибок', 'Failed')}: ${failed}` : ''}</span><strong>{progress}%</strong></div>
        <progress max={100} value={progress} aria-label={text('Загрузка альбома', 'Album upload')}/>
      </div>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions">
        {busy ? <button type="button" className="secondary-button" onClick={stop}>{text('Остановить', 'Stop')}</button>
          : <button type="button" className="secondary-button" onClick={close}>{started ? t.close : t.cancel}</button>}
        {allowSourceDeletion && retainedSources > 0 && <button type="button" className="secondary-button" disabled={busy}
          onClick={() => { void retryDeletion(); }}>{text('Повторить удаление', 'Retry deletion')}</button>}
        <button className="primary-button" disabled={busy || pickingDirectory || !photos.length}>
          {busy ? <span className="spinner"/> : <Icon name={complete ? 'check' : 'upload'} size={18}/>}
          {complete ? text('Готово', 'Done') : started ? text('Повторить незагруженные', 'Retry remaining') : text('Загрузить фотографии', 'Upload photos')}
        </button>
      </div>
    </form>
  </Modal>;
}

function fileKey(file: File) { return `${file.name}\0${file.size}\0${file.lastModified}`; }

function PhotoPreview({ file }: { file: File }) {
  const [source, setSource] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return source ? <img src={source} alt="" loading="lazy" decoding="async"/> : <span className="album-import-placeholder"><Icon name="photo"/></span>;
}
