import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import { ApiError, api, mutate, posterUrl, streamUrl, upload } from './api';
import { errorMessage } from './i18n';
import type { T } from './i18n';
import { acceptsImportFile, importFormats } from './importFormats';
import { Icon } from './Icon';
import { TagPicker } from './TagPicker';
import { PosterPicker } from './PosterPicker';
import { SourceDeletionOption } from './SourceDeletionOption';
import { deleteImportedSource, prepareSource } from './sourceDeletion';
import type { PreparedSource, SourceDirectory } from './sourceDeletion';
import type { ImportedMedia, Language, Media, MediaType } from './types';
import { videoToGif } from './videoToGif';
import './import-dialog.css';
import './modal-motion.css';

export function Modal({ title, closeLabel, onClose, children, wide = false, className = '', dismissOnBackdrop = false,
  animateClose = false, beforeClose }: {
  title: string; closeLabel: string; onClose: () => void; children: ReactNode; wide?: boolean;
  className?: string; dismissOnBackdrop?: boolean; animateClose?: boolean;
  beforeClose?: () => boolean | Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pressedBackdrop = useRef(false);
  const [closing, setClosing] = useState(false);
  const checkingClose = useRef(false);
  const finishClose = useRef(onClose);
  finishClose.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    const previouslyFocused = document.activeElement;
    element?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected)
        previouslyFocused.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    if (!closing) return;
    let cancelled = false;
    const animations = dialog.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!cancelled) finishClose.current();
    });
    return () => { cancelled = true; };
  }, [closing]);
  async function requestClose() {
    if (closing || checkingClose.current) return;
    if (beforeClose) {
      checkingClose.current = true;
      try { if (!await beforeClose()) return; }
      finally { checkingClose.current = false; }
    }
    const element = dialog.current;
    if (!animateClose || !element) {
      onClose();
      return;
    }
    // A dismissal can interrupt the opening animation. Start from the visible frame.
    const style = getComputedStyle(element);
    element.style.setProperty('--modal-close-opacity', style.opacity);
    element.style.setProperty('--modal-close-transform', style.transform);
    setClosing(true);
  }
  function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
    return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
  }
  return <dialog ref={dialog} className={`modal ${wide ? 'modal-wide' : ''} ${className}`}
    data-closing={closing || undefined} inert={closing || undefined}
    onCancel={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      requestClose();
    }}
    onPointerDown={dismissOnBackdrop ? event => { pressedBackdrop.current = event.button === 0 && isBackdrop(event); } : undefined}
    onPointerCancel={dismissOnBackdrop ? () => { pressedBackdrop.current = false; } : undefined}
    onClick={dismissOnBackdrop ? event => {
      const clickedBackdrop = pressedBackdrop.current && isBackdrop(event);
      pressedBackdrop.current = false;
      if (clickedBackdrop) requestClose();
    } : undefined}
    aria-labelledby={titleId}>
    <div className="modal-heading">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" onClick={requestClose} aria-label={closeLabel}><Icon name="close"/></button>
    </div>
    {children}
  </dialog>;
}

export function ImportDialog({ type, t, language, thumbnailCandidates, allowSourceDeletion = false, onClose, onImported }: {
  type: MediaType; t: T; language: Language; thumbnailCandidates: number; allowSourceDeletion?: boolean;
  onClose: () => void; onImported: (media: Media) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [convertVideo, setConvertVideo] = useState(false);
  const [conversionProgress, setConversionProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [objectSource, setObjectSource] = useState<{ file: File; url: string } | null>(null);
  const [poster, setPoster] = useState<Blob | null>(null);
  const [posterPending, setPosterPending] = useState(false);
  const [imported, setImported] = useState<Media | null>(null);
  const [savingPoster, setSavingPoster] = useState(false);
  const [sourceDirectory, setSourceDirectory] = useState<SourceDirectory | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [checkingSource, setCheckingSource] = useState(false);
  const [deletingSource, setDeletingSource] = useState(false);
  const [coverSaved, setCoverSaved] = useState(false);
  const sourceToDelete = useRef<PreparedSource | null>(null);
  const importToken = useRef<string | undefined>(undefined);
  const stopped = useRef(false);
  const submitting = useRef(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    stopped.current = false;
    return () => { stopped.current = true; cancelRef.current?.(); };
  }, []);
  const isVideo = type === 'video' && file !== null;
  useEffect(() => {
    if (!file || !isVideo) return;
    const url = URL.createObjectURL(file);
    setObjectSource({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file, isVideo]);
  const source = objectSource && objectSource.file === file ? objectSource.url : '';
  const displayProgress = conversionProgress ?? progress;
  const busy = displayProgress !== null || savingPoster || checkingSource || deletingSource || pickingDirectory;
  const fileType = convertVideo ? 'video' : type;
  const formats = importFormats[fileType];
  const text = (ru: string, en: string) => language === 'ru' ? ru : en;
  function selectFile(next: File | null) {
    setFile(next);
    setTitle(next ? next.name.replace(/\.[^.]+$/, '') : '');
    setPoster(null);
    setPosterPending(false);
  }
  function choose(files: FileList | null) {
    if (!files?.length) return;
    let reason = '';
    if (files.length !== 1) reason = t.oneFile;
    else if (!acceptsImportFile(files[0], fileType)) reason = convertVideo ? t.gifVideoRequired : t.importTypeMismatch;
    else if (files[0].size === 0) reason = t.emptyImportFile;
    setError(reason);
    selectFile(reason ? null : files[0]);
  }
  function changeMode(convert: boolean) {
    if (convertVideo === convert) return;
    setConvertVideo(convert);
    setSourceDirectory(null);
    setError('');
    selectFile(null);
  }
  function close() {
    stopped.current = true;
    cancelRef.current?.();
    if (imported) onImported(imported);
    else onClose();
  }
  async function saveCover(media: Media, image: Blob) {
    const controller = new AbortController();
    cancelRef.current = () => controller.abort();
    setSavingPoster(true);
    try {
      const updated = await api<Media>(`/media/${media.id}/poster`, { method: 'PUT', body: image, signal: controller.signal,
        headers: importToken.current ? { 'X-Import-Token': importToken.current } : undefined });
      if (!stopped.current && !controller.signal.aborted) {
        setImported(updated);
        setCoverSaved(true);
        return updated;
      }
    } catch (err) {
      if (!stopped.current && !controller.signal.aborted) {
        if (importToken.current && err instanceof ApiError && err.status === 403) {
          let current = media;
          try { current = await api<Media>(`/media/${media.id}`, { signal: controller.signal }); }
          catch { /* Keep the successfully imported video even if its current cover cannot be checked. */ }
          if (stopped.current || controller.signal.aborted) return null;
          setImported(current);
          setCoverSaved(true);
          importToken.current = undefined;
          if (current.posterVersion) return current;
          setPoster(null);
          setError(text('Видео уже добавлено. Добавить обложку сейчас не удалось: разрешение больше недоступно. Нажмите «Готово», чтобы завершить загрузку без обложки.',
            'The video was added. Cover upload is no longer allowed. Select Done to finish without a cover.'));
          return null;
        }
        setError(text('Видео уже добавлено. Не удалось сохранить обложку. Выберите кадр или изображение и попробуйте снова.',
          'The video was added. The cover could not be saved. Choose a frame or image and try again.'));
      }
    } finally {
      if (!stopped.current && !controller.signal.aborted) {
        cancelRef.current = null;
        setSavingPoster(false);
      }
    }
    return null;
  }
  async function finishImport(media: Media) {
    if (stopped.current) return;
    if (allowSourceDeletion && sourceToDelete.current) {
      setDeletingSource(true);
      try {
        if (!await deleteImportedSource(sourceToDelete.current, () => stopped.current)) return;
        sourceToDelete.current = null;
      } catch {
        if (!stopped.current) setError(text(
          'Файл уже добавлен. Оригинал не удалён: проверьте доступ к папке и убедитесь, что файл не изменился. Можно повторить удаление или закрыть окно.',
          'The file was added. The original was kept: check folder access and make sure the file has not changed. Retry deletion or close this window.'));
        return;
      } finally { if (!stopped.current) setDeletingSource(false); }
    }
    if (!stopped.current) onImported(media);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current || busy || posterPending || (isVideo && !source)) return;
    if (!file) { setError(t.selectFileError); return; }
    submitting.current = true;
    setError('');
    try {
      if (imported) {
        const media = poster && !coverSaved ? await saveCover(imported, poster) : imported;
        if (media) await finishImport(media);
        return;
      }
      let prepared: PreparedSource | null = null;
      if (!convertVideo && allowSourceDeletion && sourceDirectory) {
        setCheckingSource(true);
        try { prepared = await prepareSource(file, sourceDirectory, () => stopped.current); }
        catch {
          if (!stopped.current) setError(text(
            'Оригинал не найден в выбранной папке или изменился. Выберите его папку заново либо выключите удаление. Файл не загружен.',
            'The original is missing from the selected folder or has changed. Choose its folder again or turn deletion off. The file was not uploaded.'));
          return;
        } finally { if (!stopped.current) setCheckingSource(false); }
      }
      let uploadFile = prepared?.file ?? file;
      if (convertVideo) {
        const controller = new AbortController();
        cancelRef.current = () => controller.abort();
        setConversionProgress(0);
        try {
          uploadFile = await videoToGif(file, { signal: controller.signal, onProgress: setConversionProgress });
        } catch {
          if (!stopped.current) setError(t.gifConversionError);
          return;
        } finally {
          if (!stopped.current) setConversionProgress(null);
        }
      }
      if (stopped.current) return;
      setProgress(0);
      const request = upload<ImportedMedia>(uploadFile, type, title.trim() || file.name, tags, value => {
        if (!stopped.current) setProgress(value);
      });
      cancelRef.current = request.cancel;
      const result = await request.promise;
      if (stopped.current) return;
      cancelRef.current = null;
      setProgress(null);
      sourceToDelete.current = prepared;
      importToken.current = result.importToken;
      setImported(result);
      if (result.type === 'video' && poster) {
        const updated = await saveCover(result, poster);
        if (updated) await finishImport(updated);
      } else await finishImport(result);
    } catch (err) {
      if (!stopped.current) setError(errorMessage(err, t));
    } finally {
      submitting.current = false;
      cancelRef.current = null;
      if (!stopped.current) setProgress(null);
    }
  }
  const lockedFields = busy || imported !== null;
  return <Modal title={t.import} closeLabel={t.close} onClose={close}
    className={type === 'video' ? 'import-modal import-modal-video' : 'import-modal'} dismissOnBackdrop>
    <form className="import-form" onSubmit={event => { void submit(event); }}>
      <div className="import-panels">
        <section className="import-pane import-pane-file" aria-labelledby="import-file-heading">
          <h3 className="import-pane-title" id="import-file-heading">{t.file}</h3>
          {type === 'gif' && <div className="import-mode">
            <button type="button" className="secondary-button small" aria-pressed={!convertVideo} disabled={lockedFields}
              onClick={() => changeMode(false)}>{t.uploadGif}</button>
            <button type="button" className="secondary-button small" aria-pressed={convertVideo} disabled={lockedFields}
              onClick={() => changeMode(true)}>{t.convertGif}</button>
          </div>}
          <button type="button" className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
            disabled={lockedFields} onClick={() => input.current?.click()}
            onDragOver={event => { event.preventDefault(); if (!lockedFields) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => {
              event.preventDefault();
              setDragging(false);
              if (!lockedFields) choose(event.dataTransfer.files);
            }}>
            <span className="drop-icon"><Icon name={file ? 'check' : 'upload'} size={26}/></span>
            <strong>{file ? file.name : t.dropFile}</strong>
            <span>{file ? formatBytes(file.size) : t.chooseFile}</span>
            <small>{formats.label}</small>
          </button>
          <input ref={input} className="visually-hidden" type="file" accept={formats.extensions.join(',')} aria-label={t.chooseFile}
            onChange={event => { choose(event.target.files); event.target.value = ''; }} disabled={lockedFields}/>
          {convertVideo ? <p className="help-text">{t.gifConversionHelp}</p>
            : !sourceDirectory && <p className="help-text import-help"><Icon name="shield" size={16}/>{t.importHelp}</p>}
          {!convertVideo && allowSourceDeletion && <SourceDeletionOption language={language} directory={sourceDirectory} onChange={setSourceDirectory}
            disabled={lockedFields} onBusyChange={setPickingDirectory}/>}
          <label className="field-label" htmlFor="import-title">{t.title}</label>
          <input id="import-title" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} disabled={lockedFields} required/>
          {displayProgress !== null && <div className="upload-progress" role="status">
            <div><span>{conversionProgress !== null ? t.gifConverting : progress === 100 ? t.encrypting : t.uploading}</span><strong>{displayProgress}%</strong></div>
            <progress max={100} value={displayProgress}/>
          </div>}
          {savingPoster && <p className="help-text" role="status">{text('Сохраняем обложку…', 'Saving the cover…')}</p>}
          {checkingSource && <p className="help-text" role="status">{text('Проверяем оригинал…', 'Checking the original…')}</p>}
          {deletingSource && <p className="help-text" role="status">{text('Проверяем и удаляем оригинал…', 'Verifying and deleting the original…')}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </section>
        <div className="import-pane import-pane-tags">
          <TagPicker value={tags} onChange={setTags} language={language} disabled={lockedFields}/>
        </div>
        {type === 'video' && <div className="import-pane import-pane-cover">
          <PosterPicker key={source} source={source} language={language} count={thumbnailCandidates}
            onChange={setPoster} onBusyChange={setPosterPending} disabled={busy || coverSaved}/>
        </div>}
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={close}>{imported ? t.close : t.cancel}</button>
        <button className="primary-button" disabled={busy || !file || posterPending || (isVideo && !source)}>
          {busy ? <span className="spinner"/> : <Icon name={imported ? 'check' : 'plus'} size={18}/>}
          {imported ? (poster && !coverSaved ? t.retry : sourceToDelete.current ? text('Повторить удаление', 'Retry deletion') : text('Готово', 'Done'))
            : convertVideo ? t.convertAndImport : t.importShort}
        </button>
      </div>
    </form>
  </Modal>;
}

export function PosterDialog({ media, t, language, count, onClose, onSaved }: {
  media: Media; t: T; language: Language; count: number; onClose: () => void; onSaved: (item: Media) => void;
}) {
  const [poster, setPoster] = useState<Blob | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!poster || pending || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const item = await api<Media>(`/media/${media.id}/poster`, { method: 'PUT', body: poster, signal: controller.signal });
      if (!controller.signal.aborted) onSaved(item);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err, t));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <Modal title={t.editPoster} closeLabel={t.close} onClose={onClose} wide>
    <form onSubmit={event => { void submit(event); }}>
      {media.posterVersion && <div className="current-cover">
        <img src={posterUrl(media.id, media.posterVersion)} alt=""/>
        <span>{language === 'ru' ? 'Текущая обложка' : 'Current cover'}</span>
      </div>}
      <PosterPicker source={streamUrl(media.id)} language={language} count={count} onChange={setPoster}
        onBusyChange={setPending} disabled={busy}/>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>{t.cancel}</button>
        <button className="primary-button" disabled={busy || pending || !poster}>{busy && <span className="spinner"/>}{t.save}</button>
      </div>
    </form>
  </Modal>;
}

export { SettingsDialog } from './SettingsDialog';

export function TrashDialog({ t, onClose, onRestored }: { t: T; onClose: () => void; onRestored: () => void }) {
  const [items, setItems] = useState<Media[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const restoring = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void api<{ items: Media[] }>('/trash', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setItems(result.items); })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err, t)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [t, reload]);
  async function restore(id: string) {
    if (restoring.current) return;
    restoring.current = true;
    setRestoringId(id);
    setError('');
    try { await mutate(`/trash/${id}/restore`, 'POST'); setItems(list => list.filter(item => item.id !== id)); onRestored(); }
    catch (err) { setError(errorMessage(err, t)); }
    finally { restoring.current = false; setRestoringId(null); }
  }
  return <Modal title={t.trash} closeLabel={t.close} onClose={onClose}>
    {busy ? <div className="loading-block" role="status"><span className="spinner"/>{t.loading}</div>
      : items.length ? <div className="trash-list">{items.map(item => <div className="trash-item" key={item.id}>
        <span className="trash-type"><Icon name={item.type}/></span>
        <div><strong>{item.title}</strong><small>{formatBytes(item.size)}</small></div>
        <button className="secondary-button" disabled={restoringId !== null} onClick={() => { void restore(item.id); }}>
          {restoringId === item.id && <span className="spinner"/>}{t.restore}
        </button>
      </div>)}</div> : !error && <div className="empty-state compact"><Icon name="trash" size={32}/><h3>{t.trashEmpty}</h3><p>{t.trashEmptyText}</p></div>}
    {error && <div role="alert"><p className="error-text">{error}</p>
      <button className="secondary-button" disabled={restoringId !== null} onClick={() => setReload(value => value + 1)}>{t.retry}</button>
    </div>}
  </Modal>;
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
