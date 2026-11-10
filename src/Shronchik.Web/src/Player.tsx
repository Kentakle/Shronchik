import { useEffect, useId, useRef, useState } from 'react';
import { api, mutate, posterUrl, streamUrl } from './api';
import { AlbumPicker, albumPickerLabel } from './Albums';
import { matchesHotkey, isTypingTarget } from './hotkeys';
import { tagLabel } from './tags';
import { errorMessage } from './i18n';
import type { T } from './i18n';
import { Icon } from './Icon';
import { formatBytes, PosterDialog } from './Dialogs';
import { VideoThumbnail } from './VideoThumbnail';
import { ThumbnailTags } from './ThumbnailTags';
import { useVideoPoster } from './useVideoPoster';
import { VideoControls, toggleVideoFullscreen } from './VideoControls';
import { savePlaybackVolume } from './playbackVolume';
import type { Language, Media, Settings } from './types';
import './player-loading.css';
import './player-rating.css';

export type OpenMedia = { media: Media; time: number; volume: number; muted?: boolean; playSessionId: string | null; counted: boolean };
export type MediaUpdate = Pick<Media, 'id'> & Partial<Media>;
export function Player({ context, t, language, admin, accountId, settings, closing, onOpenRelated, onNavigate, onBack, onUpdate, onTimeline, onPlaying, onTag, onTrash, onAlbumsChanged }: {
  closing: boolean;
  settings: Settings; onOpenRelated: (media: Media) => void; onNavigate: (direction: 'next' | 'previous') => void;
  context: OpenMedia; t: T; language: Language; admin: boolean; accountId: string; onBack: () => void;
  onUpdate: (value: MediaUpdate) => void; onTimeline: (time: number, volume: number) => void;
  onPlaying: (value: boolean) => void; onTag: (tag: string) => void; onTrash: () => void; onAlbumsChanged: () => void;
}) {
  const media = context.media;
  const playbackId = useId();
  // Isolate the player's media buffer from thumbnail seeks and earlier openings.
  const videoSource = `${streamUrl(media.id)}?playback=${encodeURIComponent(context.playSessionId ?? playbackId)}`;
  const [draft, setDraft] = useState(media.userRating == null ? '' : String(media.userRating));
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [editingPoster, setEditingPoster] = useState(false);
  const [editingAlbums, setEditingAlbums] = useState(false);
  const [related, setRelated] = useState<Media[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const volumeReady = useRef(false);
  const stage = useRef<HTMLDivElement>(null);
  const poster = useVideoPoster(media.type === 'video' ? media.id : '', media.posterVersion, stage);
  const loadingVideo = media.type === 'video' && !videoReady && !failed;
  const firstPlay = useRef(context.counted);
  const playBusy = useRef(false);
  const lastRating = useRef(media.userRating ?? null);
  const ratingRequest = useRef(false);
  const ownRatingLabel = language === 'ru' ? 'Ваша оценка' : 'Your rating';
  useEffect(() => {
    const controller = new AbortController();
    setRelated([]);
    if (media.type === 'video' && settings.showRelatedBelow) {
      void api<{ items: Media[] }>(`/media/${media.id}/related`, { signal: controller.signal })
        .then(result => setRelated(result.items)).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err, t)); });
    }
    return () => controller.abort();
  }, [media.id, media.type, settings.showRelatedBelow, settings.relatedCount, settings.randomRelatedCount, t]);
  useEffect(() => {
    setDraft(media.userRating == null ? '' : String(media.userRating));
    lastRating.current = media.userRating ?? null;
  }, [media.userRating]);
  useEffect(() => {
    const element = video.current;
    return () => { if (element) { element.pause(); element.removeAttribute('src'); element.load(); } onPlaying(false); };
  }, [media.id, onPlaying]);
  useEffect(() => {
    if (closing) video.current?.pause();
  }, [closing]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (closing || event.defaultPrevented || isTypingTarget(event.target, true)) return;
      const element = video.current;
      const hotkeys = settings.hotkeys;
      if (matchesHotkey(event, hotkeys.nextMedia)) { event.preventDefault(); onNavigate('next'); return; }
      if (matchesHotkey(event, hotkeys.previousMedia)) { event.preventDefault(); onNavigate('previous'); return; }
      if (!element) return;
      if (matchesHotkey(event, hotkeys.playPause)) {
        if (event.target instanceof HTMLElement && event.target.closest('button')) return;
        event.preventDefault(); if (element.paused) void element.play().catch(() => setFailed(true)); else element.pause();
      } else if (matchesHotkey(event, hotkeys.seekBackward) || matchesHotkey(event, hotkeys.seekForward)) {
        event.preventDefault(); element.currentTime = Math.max(0, Math.min(element.duration || 0, element.currentTime + (matchesHotkey(event, hotkeys.seekBackward) ? -settings.seekSeconds : settings.seekSeconds)));
      } else if (matchesHotkey(event, hotkeys.volumeUp) || matchesHotkey(event, hotkeys.volumeDown)) {
        event.preventDefault(); element.volume = Math.max(0, Math.min(1, element.volume + (matchesHotkey(event, hotkeys.volumeUp) ? 0.05 : -0.05)));
      } else if (matchesHotkey(event, hotkeys.toggleMute)) { event.preventDefault(); element.muted = !element.muted; }
      else if (matchesHotkey(event, hotkeys.toggleFullscreen)) {
        event.preventDefault(); toggleVideoFullscreen(stage.current);
      } else if (matchesHotkey(event, hotkeys.exitFullscreen) && document.fullscreenElement) {
        event.preventDefault(); void document.exitFullscreen().catch(() => {});
      }
    }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [closing, onNavigate, settings.hotkeys, settings.seekSeconds]);
  function finishVideoLoading(element: HTMLVideoElement) {
    if (!element.seeking && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) setVideoReady(true);
  }
  async function countPlay() {
    onPlaying(true);
    if (firstPlay.current || playBusy.current || !context.playSessionId) return;
    playBusy.current = true;
    try {
      await mutate(`/play-sessions/${context.playSessionId}/first-play`, 'POST');
      firstPlay.current = true; context.counted = true;
      if (!admin) onUpdate({ id: media.id, views: media.views + 1 });
    } catch (err) { setError(errorMessage(err, t)); }
    finally { playBusy.current = false; }
  }
  async function rating(value = draft) {
    if (admin || ratingRequest.current) return;
    const number = value === '' ? null : Number(value);
    if (number !== null && (!Number.isInteger(number) || number < 1 || number > 10000)) { setError(t.ratingInvalid); return; }
    if (lastRating.current === number) return;
    ratingRequest.current = true;
    setError(''); setBusy(true);
    try {
      const updated = await mutate<Media>(`/media/${media.id}/rating`, 'PUT', { rating: number });
      lastRating.current = updated.userRating;
      onUpdate({ id: media.id, rating: updated.rating, userRating: updated.userRating, ratingCount: updated.ratingCount });
    }
    catch (err) { setError(errorMessage(err, t)); }
    finally { ratingRequest.current = false; setBusy(false); }
  }
  async function favorite() {
    setError(''); setBusy(true);
    try { await mutate(`/media/${media.id}/favorite`, 'PUT', { isFavorite: !media.isFavorite }); onUpdate({ id: media.id, isFavorite: !media.isFavorite }); }
    catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  async function trash() {
    setError(''); setBusy(true);
    try { await mutate(`/media/${media.id}/trash`, 'POST'); onTrash(); }
    catch (err) { setError(errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  return <div className="player-page"><button className="text-button back-link" onClick={onBack}><Icon name="close" size={18}/>{t.backGallery}</button>
    <div ref={stage} className={`player-stage ${media.type !== 'video' ? 'image-stage' : ''} ${zoom ? 'zoomed' : ''}`}
      data-loading={loadingVideo || undefined} aria-busy={loadingVideo || undefined}>
      {media.type === 'video' ? <>
        <video ref={video} src={videoSource} poster={poster.url || (media.posterVersion ? posterUrl(media.id, media.posterVersion) : undefined)}
          preload="auto" controlsList="nodownload" playsInline tabIndex={0}
          onLoadedMetadata={e => {
            const element = e.currentTarget;
            element.volume = context.volume; element.muted = context.muted ?? false; volumeReady.current = true;
            if (context.time) element.currentTime = context.time;
          }}
          onClick={event => { const element = event.currentTarget; if (closing || !videoReady) return;
            if (element.paused) void element.play().catch(() => setFailed(true)); else element.pause(); }}
          onDoubleClick={() => toggleVideoFullscreen(stage.current)}
          onCanPlay={e => finishVideoLoading(e.currentTarget)} onSeeked={e => finishVideoLoading(e.currentTarget)}
          onPlaying={() => { setVideoReady(true); void countPlay(); }} onPause={() => onPlaying(false)}
          onEnded={() => onPlaying(false)} onWaiting={() => onPlaying(false)}
          onTimeUpdate={e => onTimeline(e.currentTarget.currentTime, e.currentTarget.volume)}
          onVolumeChange={e => {
            if (!volumeReady.current) return;
            const element = e.currentTarget;
            context.muted = element.muted;
            onTimeline(element.currentTime, element.volume);
            savePlaybackVolume(accountId, settings.volume, { volume: element.volume, muted: element.muted });
          }}
          onError={() => { setFailed(true); onPlaying(false); }} aria-label={media.title}/>
        <div className="player-cover" aria-hidden="true">
          {poster.url ? <img src={poster.url} alt="" decoding="async" onError={poster.onError}/>
            : <span className="video-art"><span/><span/><Icon name="play"/></span>}
        </div>
        <div className="player-processing" role={loadingVideo ? 'status' : undefined} aria-hidden={!loadingVideo}>
          <span className="player-processing-dots" aria-hidden="true"><span/><span/><span/></span>
          <span>{t.preparingVideo}</span>
        </div>
        <VideoControls video={video} stage={stage} previewSource={`${streamUrl(media.id)}?preview=timeline`}
          language={language} disabled={closing || !videoReady || failed} onPlayError={() => setFailed(true)}/>
      </> : <img src={streamUrl(media.id)} alt={media.title} onClick={() => setZoom(!zoom)} onError={() => setFailed(true)}/>}
      {failed && <div className="player-failure" role="alert"><Icon name={media.type} size={35}/><p>{media.type === 'video' ? t.videoUnavailable : t.imageUnavailable}</p></div>}
    </div><div className="player-details"><div className="player-main-info"><div className="media-tags">{media.tags.map(tag => <button key={tag} onClick={() => onTag(tag)}>#{tagLabel(tag)}</button>)}</div><h1>{media.title}</h1>{media.description && <p className="media-description">{media.description}</p>}<div className="file-facts"><span>{formatBytes(media.size)}</span><span>{new Date(media.createdAt).toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' })}</span>{media.type === 'video' && <span><Icon name="eye" size={15}/>{media.views.toLocaleString(language)} {viewCountLabel(media.views, language)}</span>}</div></div>
    <div className="rating-panel">
      {!admin && <button className={`favorite-button ${media.isFavorite ? 'active' : ''}`} disabled={busy} onClick={() => { void favorite(); }} aria-pressed={media.isFavorite}><Icon name="heart" size={20} filled={media.isFavorite}/>{media.isFavorite ? t.unfavorite : t.favorite}</button>}
      <div className="rating-average" aria-live="polite">
        <span>{language === 'ru' ? 'Средняя оценка' : 'Average rating'}</span>
        <div><Icon name="star" size={19}/><strong className="rating-average-value">{media.rating?.toLocaleString(language) ?? '—'}</strong><span>/ 10000</span></div>
        <small>{ratingCountLabel(media.ratingCount ?? 0, language)}</small>
      </div>
      {!admin && <div className="personal-rating">
        <div className="rating-heading"><label htmlFor="media-rating">{ownRatingLabel}</label><div className="rating-number"><input id="media-rating" type="number" min={1} max={10000} step={1} value={draft} placeholder="—" disabled={busy} onChange={e => setDraft(e.target.value)} onBlur={() => { void rating(); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void rating(); } }}/><span>/ 10000</span></div></div>
        <input className="rating-slider" aria-label={ownRatingLabel} aria-valuetext={draft || t.unrated} type="range" min={1} max={10000} value={Number(draft) || 1} disabled={busy} onChange={e => setDraft(e.target.value)} onPointerUp={e => { void rating(e.currentTarget.value); }} onKeyUp={e => { void rating(e.currentTarget.value); }}/>
        <button className="text-button clear-rating" disabled={busy || media.userRating == null} onClick={() => { setDraft(''); void rating(''); }}>{t.clearRating}</button>
      </div>}
    </div></div>
    {error && <p className="error-text" role="alert">{error}</p>}{admin && <div className="admin-media-actions">{deleteConfirm ? <div className="delete-confirm"><strong>{t.deleteConfirm}</strong><p>{t.deleteText}</p><button className="danger-button" disabled={busy} onClick={() => { void trash(); }}>{t.confirm}</button><button className="text-button" onClick={() => setDeleteConfirm(false)}>{t.cancel}</button></div> : <button className="text-button danger-text" onClick={() => setDeleteConfirm(true)}><Icon name="trash" size={16}/>{t.delete}</button>}</div>}
    {admin && media.type === 'video' && !deleteConfirm && <button className="text-button edit-cover" disabled={busy} onClick={() => {
      video.current?.pause();
      setEditingPoster(true);
    }}><Icon name="photo" size={16}/>{t.editPoster}</button>}
    {!admin && <button className="text-button edit-cover" disabled={closing} onClick={() => {
      video.current?.pause();
      setEditingAlbums(true);
    }}><Icon name="album" size={16}/>{albumPickerLabel(language)}</button>}
    {related.length > 0 && <section className="related-section">
      <h2>{t.recommendations}</h2>
      <div className="related-grid">{related.map(item => <button className="related-card" key={item.id} disabled={closing} onClick={() => onOpenRelated(item)}>
        <VideoThumbnail id={item.id} version={item.posterVersion} hoverDelayMs={settings.hoverDelayMs}/>
        <span className="related-card-details">
          <span className="related-card-title">
            <strong title={item.title}>{item.title}</strong>
            <small><Icon name="star" size={14}/>{item.rating?.toLocaleString(language) ?? '—'}</small>
          </span>
          <ThumbnailTags tags={item.tags}/>
        </span>
      </button>)}</div>
    </section>}
    {editingPoster && <PosterDialog media={media} t={t} language={language} count={settings.thumbnailCandidates}
      onClose={() => setEditingPoster(false)} onSaved={item => { onUpdate({ id: item.id, posterVersion: item.posterVersion }); setEditingPoster(false); }}/>}
    {!admin && editingAlbums && <AlbumPicker media={media} t={t} language={language}
      onClose={() => setEditingAlbums(false)} onChanged={onAlbumsChanged}/>}
  </div>;
}

function viewCountLabel(count: number, language: Language) {
  const form = new Intl.PluralRules(language).select(count);
  if (language === 'en') return form === 'one' ? 'view' : 'views';
  return form === 'one' ? 'просмотр' : form === 'few' ? 'просмотра' : 'просмотров';
}

function ratingCountLabel(count: number, language: Language) {
  const form = new Intl.PluralRules(language).select(count);
  const unit = language === 'en' ? (form === 'one' ? 'rating' : 'ratings')
    : form === 'one' ? 'оценка' : form === 'few' ? 'оценки' : 'оценок';
  return `${count.toLocaleString(language)} ${unit}`;
}

