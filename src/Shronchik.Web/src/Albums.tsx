import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, mutate } from './api';
import { Modal } from './Dialogs';
import { Icon } from './Icon';
import { errorMessage } from './i18n';
import type { T } from './i18n';
import type { Language, Media, MediaPage } from './types';
import './albums.css';

type Album = { id: string; name: string; itemCount: number };
type AlbumEdit = { kind: 'create' } | { kind: 'rename' | 'delete'; album: Album };

const copy = {
  ru: {
    title: 'Личные альбомы', create: 'Создать альбом', rename: 'Переименовать', remove: 'Удалить альбом',
    name: 'Название альбома', empty: 'У тебя пока нет альбомов.',
    noItems: 'Альбом пуст. Открой файл в галерее и выбери «В альбом».',
    back: 'Все альбомы', picker: 'В альбом', pickerHint: 'Отметь альбомы, в которых должен быть этот файл.',
    removeHint: 'Файлы останутся в общей медиатеке.', count: 'Файлов',
  },
  en: {
    title: 'Personal albums', create: 'Create album', rename: 'Rename', remove: 'Delete album',
    name: 'Album name', empty: 'You have no albums yet.',
    noItems: 'This album is empty. Open an item in the gallery and choose “Add to album”.',
    back: 'All albums', picker: 'Add to album', pickerHint: 'Select the albums that should contain this item.',
    removeHint: 'Files will stay in the shared library.', count: 'Items',
  },
};

export function albumPickerLabel(language: Language) { return copy[language].picker; }

export function AlbumsPanel({ language, t, revision, pageSize, renderItems }: {
  language: Language; t: T; revision: number; pageSize: number; renderItems: (items: Media[]) => ReactNode;
}) {
  const labels = copy[language];
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [edit, setEdit] = useState<AlbumEdit | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const request = new AbortController();
    setError(null);
    void api<{ items: Album[] }>('/albums', { signal: request.signal })
      .then(result => { if (!request.signal.aborted) setAlbums(result.items); })
      .catch(err => { if (!request.signal.aborted) setError(err); });
    return () => request.abort();
  }, [revision]);

  const active = albums?.find(album => album.id === activeId);
  if (active) return <section className="albums-section">
    <button className="text-button" onClick={() => setActiveId(null)}><Icon name="back"/>{labels.back}</button>
    <h2>{active.name}</h2>
    <AlbumItems key={active.id} id={active.id} empty={labels.noItems} t={t}
      revision={revision} pageSize={pageSize} renderItems={renderItems}/>
  </section>;

  return <section className="albums-section">
    <div className="albums-heading">
      <h2>{labels.title}</h2>
      <button className="primary-button small" onClick={() => setEdit({ kind: 'create' })}><Icon name="plus"/>{labels.create}</button>
    </div>
    {Boolean(error) && <p className="error-text" role="alert">{errorMessage(error, t)}</p>}
    {!albums && !error && <p role="status" className="help-text">{t.loading}</p>}
    {albums?.length === 0 && <p className="help-text">{labels.empty}</p>}
    {!!albums?.length && <div className="albums-grid">
      {albums.map(album => <article className="album-card" key={album.id}>
        <button className="album-open" onClick={() => setActiveId(album.id)}>
          <Icon name="album"/><span><strong>{album.name}</strong><small>{labels.count} · {album.itemCount}</small></span>
        </button>
        <div className="album-actions">
          <button className="text-button" onClick={() => setEdit({ kind: 'rename', album })}>{labels.rename}</button>
          <button className="icon-button danger-text" aria-label={labels.remove} title={labels.remove}
            onClick={() => setEdit({ kind: 'delete', album })}><Icon name="trash"/></button>
        </div>
      </article>)}
    </div>}
    {edit && <AlbumEditor edit={edit} language={language} t={t} onClose={() => setEdit(null)} onSaved={album => {
      setAlbums(previous => {
        const items = previous ?? [];
        if (edit.kind === 'delete') return items.filter(item => item.id !== edit.album.id);
        if (!album) return items;
        return edit.kind === 'rename' ? items.map(item => item.id === album.id ? album : item) : [album, ...items];
      });
      setEdit(null);
    }}/>}
  </section>;
}

function AlbumItems({ id, empty, t, revision, pageSize, renderItems }: {
  id: string; empty: string; t: T; revision: number; pageSize: number; renderItems: (items: Media[]) => ReactNode;
}) {
  const [page, setPage] = useState<MediaPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const route = `/albums/${id}/items?limit=${pageSize}`;
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setBusy(true);
    void api<MediaPage>(route, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setPage(result); })
      .catch(err => { if (!controller.signal.aborted) setError(err); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => request.current?.abort();
  }, [route, revision, reload]);

  async function loadMore() {
    if (!page?.nextCursor || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const next = await api<MediaPage>(route + '&cursor=' + encodeURIComponent(page.nextCursor), { signal: controller.signal });
      if (!controller.signal.aborted) setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (err) {
      if (!controller.signal.aborted) setError(err);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <>
    {Boolean(error) && <div role="alert">
      <p className="error-text">{errorMessage(error, t)}</p>
      <button className="secondary-button" disabled={busy} onClick={() => setReload(value => value + 1)}>{t.retry}</button>
    </div>}
    {!page && !error && <p role="status" className="help-text">{t.loading}</p>}
    {page?.items.length === 0 && <p className="help-text">{empty}</p>}
    {!!page?.items.length && renderItems(page.items)}
    {page?.hasMore && !error && <button className="secondary-button album-more" disabled={busy} onClick={() => { void loadMore(); }}>{t.loadMore}</button>}
  </>;
}

function AlbumEditor({ edit, language, t, onClose, onSaved }: {
  edit: AlbumEdit; language: Language; t: T; onClose: () => void; onSaved: (album?: Album) => void;
}) {
  const labels = copy[language];
  const [name, setName] = useState(edit.kind === 'create' ? '' : edit.album.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const title = edit.kind === 'create' ? labels.create : edit.kind === 'rename' ? labels.rename : labels.remove;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (edit.kind === 'delete') {
        await mutate(`/albums/${edit.album.id}`, 'DELETE');
        onSaved();
      } else {
        const album = await mutate<Album>(edit.kind === 'create' ? '/albums' : `/albums/${edit.album.id}`,
          edit.kind === 'create' ? 'POST' : 'PATCH', { name: name.trim() });
        onSaved(album);
      }
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  return <Modal title={title} closeLabel={t.close} onClose={() => { if (!busy) onClose(); }} dismissOnBackdrop>
    <form onSubmit={event => { void submit(event); }}>
      {edit.kind === 'delete' ? <><strong>{edit.album.name}</strong><p className="help-text">{labels.removeHint}</p></> :
        <label>{labels.name}<input value={name} maxLength={80} onChange={event => setName(event.target.value)} required/></label>}
      {Boolean(error) && <p className="error-text" role="alert">{errorMessage(error, t)}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t.cancel}</button>
        <button className={edit.kind === 'delete' ? 'danger-button' : 'primary-button'}
          disabled={busy || (edit.kind !== 'delete' && !name.trim())}>{edit.kind === 'delete' ? t.confirm : t.save}</button>
      </div>
    </form>
  </Modal>;
}

export function AlbumPicker({ media, language, t, onClose, onChanged }: {
  media: Media; language: Language; t: T; onClose: () => void; onChanged: () => void;
}) {
  const labels = copy[language];
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [included, setIncluded] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([api<{ items: Album[] }>('/albums', options), api<{ albumIds: string[] }>(`/media/${media.id}/albums`, options)])
      .then(([list, memberships]) => {
        if (controller.signal.aborted) return;
        setAlbums(list.items);
        setIncluded(memberships.albumIds);
      })
      .catch(err => { if (!controller.signal.aborted) setError(err); });
    return () => controller.abort();
  }, [media.id]);

  async function change(action: () => Promise<void>, rollback?: () => void) {
    setBusy(true);
    setError(null);
    try { await action(); onChanged(); }
    catch (err) { rollback?.(); setError(err); }
    finally { setBusy(false); }
  }

  return <Modal title={labels.picker} closeLabel={t.close} onClose={() => { if (!busy) onClose(); }} dismissOnBackdrop>
    <p className="help-text">{labels.pickerHint}</p>
    {!albums && !error && <p role="status" className="help-text">{t.loading}</p>}
    {albums?.length === 0 && <p className="help-text">{labels.empty}</p>}
    <div className="album-memberships">
      {albums?.map(album => <label key={album.id}><input type="checkbox" checked={included.includes(album.id)}
        disabled={busy} onChange={event => {
          const checked = event.currentTarget.checked;
          const previous = included;
          setIncluded(checked ? [...included, album.id] : included.filter(id => id !== album.id));
          void change(async () => {
            await mutate(`/albums/${album.id}/items/${media.id}`, checked ? 'PUT' : 'DELETE');
          }, () => setIncluded(previous));
        }}/><span>{album.name}</span></label>)}
    </div>
    {albums && <form className="album-create-inline" onSubmit={event => {
      event.preventDefault();
      if (!name.trim() || busy) return;
      void change(async () => {
        const album = await mutate<Album>('/albums', 'POST', { name: name.trim() });
        setAlbums(previous => [...(previous ?? []), album]);
        setName('');
      });
    }}>
      <input aria-label={labels.name} placeholder={labels.name} maxLength={80} value={name}
        onChange={event => setName(event.target.value)} disabled={busy} required/>
      <button className="secondary-button" disabled={busy || !name.trim()}>{labels.create}</button>
    </form>}
    {Boolean(error) && <p className="error-text" role="alert">{errorMessage(error, t)}</p>}
    <div className="modal-actions"><button className="primary-button" disabled={busy} onClick={onClose}>{t.close}</button></div>
  </Modal>;
}
