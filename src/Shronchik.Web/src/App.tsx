import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, mutate, setCsrfToken } from './api';
import { Auth, Brand } from './Auth';
import { AlbumImportDialog } from './AlbumImportDialog';
import { formatBytes, ImportDialog, SettingsDialog, TrashDialog } from './Dialogs';
import { Gallery, newGalleryState } from './Gallery';
import type { GalleryState } from './Gallery';
import { isTypingTarget, matchesHotkey } from './hotkeys';
import { errorMessage, strings } from './i18n';
import { Icon } from './Icon';
import { Player } from './Player';
import { PageTransition } from './PageTransition';
import { readPlaybackVolume } from './playbackVolume';
import type { MediaUpdate, OpenMedia } from './Player';
import { PlayerOverlay } from './PlayerOverlay';
import { followLink, mediaPath, readLocation } from './routes';
import { clearThumbnailCache, openThumbnailCache, setThumbnailBudget } from './thumbnailCache';
import { defaultSettings, guestSession } from './types';
import type { Home, Media, MediaType, Session, Settings } from './types';

export default function App() {
  const [session, setSession] = useState<Session>(guestSession);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [previewSettings, setPreviewSettings] = useState<Settings | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [location, setLocation] = useState(readLocation);
  const [gallery, setGallery] = useState<GalleryState>(newGalleryState);
  const [selected, setSelected] = useState<OpenMedia | null>(null);
  const [modal, setModal] = useState<'import' | 'album-import' | 'settings' | 'security' | 'trash' | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [copyLinkNotice, setCopyLinkNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const active = useRef(true);
  const playing = useRef(false);
  const selectedRef = useRef<OpenMedia | null>(null);
  const locationRef = useRef(location);
  const mediaRequest = useRef<AbortController | null>(null);
  const dataRequest = useRef<AbortController | null>(null);
  const sessionVersion = useRef(0);
  const galleryDirty = useRef(false);
  const sessionRef = useRef<Session>(guestSession);
  const lockedScroll = useRef(0);
  const localPrivacyLock = useRef(false);
  const t = strings(settings.language);
  const appearance = previewSettings ?? settings;
  const { category, mediaType, mediaId } = location;
  const unlocked = session.authenticated && !session.locked && !session.mustChangePassword;
  const admin = session.role === 'Admin';
  const canUpload = admin || session.canUpload === true;
  const accountName = session.accountId ?? session.role ?? '';
  selectedRef.current = selected;

  const cancelMediaOpen = useCallback(() => {
    mediaRequest.current?.abort();
    mediaRequest.current = null;
  }, []);
  const acceptSession = useCallback((value: Session) => {
    if (localPrivacyLock.current && value.authenticated && !value.locked) value = { ...value, locked: true };
    const previous = sessionRef.current;
    const changedAccount = previous.accountId !== value.accountId;
    const hasAccess = value.authenticated && !value.locked && !value.mustChangePassword;
    if (previous.authenticated && !previous.locked && (!hasAccess || changedAccount)) {
      clearThumbnailCache();
    }
    if (hasAccess) openThumbnailCache();
    if (value.locked && !previous.locked && previous.authenticated) lockedScroll.current = window.scrollY;
    if (hasAccess && (changedAccount || previous.locked || previous.mustChangePassword)) {
      const top = previous.locked && !changedAccount ? lockedScroll.current : 0;
      window.requestAnimationFrame(() => window.scrollTo({ top }));
    }
    sessionRef.current = value;
    setCsrfToken(value.csrfToken); setSession(value); setConnectionError(false); setReady(true);
    if (!hasAccess || changedAccount) {
      cancelMediaOpen();
      dataRequest.current?.abort();
      playing.current = false;
      setModal(null);
      setAccountMenu(false);
      setPreviewSettings(null);
      setCopyLinkNotice(null);
    }
    if (value.role !== 'Admin' && !value.canUpload && (previous.role === 'Admin' || previous.canUpload)) {
      setModal(current => current === 'import' || current === 'album-import' ? null : current);
      galleryDirty.current = true;
      setRevision(current => current + 1);
    }
    if (changedAccount || previous.authenticated && !value.authenticated) setSettings(defaultSettings);
    if (!value.authenticated || changedAccount || value.mustChangePassword) {
      setSelected(null);
      setGallery(newGalleryState());
      setHome(null);
      setTags([]);
      galleryDirty.current = false;
    }
  }, [cancelMediaOpen]);
  const refreshSession = useCallback(async () => {
    const version = sessionVersion.current;
    try {
      const response = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' });
      const value = response.ok ? await response.json() as Session : response.status === 401 ? guestSession : null;
      if (version !== sessionVersion.current) return;
      if (!value) throw new Error('session');
      acceptSession(value);
    } catch { if (version === sessionVersion.current) { setConnectionError(true); setReady(true); } }
  }, [acceptSession]);
  useEffect(() => { void refreshSession(); const interval = setInterval(() => { void refreshSession(); }, 15000); const event = () => { void refreshSession(); }; window.addEventListener('session-needed', event); return () => { clearInterval(interval); window.removeEventListener('session-needed', event); }; }, [refreshSession]);
  useEffect(() => {
    document.documentElement.lang = settings.language;
    document.title = `Shronchik — ${t.privateLibrary}`;
  }, [settings.language, t.privateLibrary]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const values = {
      '--color-bg': appearance.backgroundColor,
      '--color-surface': appearance.surfaceColor,
      '--color-text': appearance.textColor,
      '--color-muted': appearance.mutedTextColor,
      '--color-accent': appearance.accentColor,
      '--accent-ink': accentInk(appearance.accentColor),
      '--shadow-strength': String(appearance.shadowStrength),
      '--neighbor-opacity': String(1 - appearance.hoverNeighborDim),
      '--radius-card': `${appearance.cardRadiusPx}px`,
      '--duration-base': `${appearance.animationMs}ms`,
      '--font-scale': String(appearance.fontScale),
    };
    for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value);
    root.dataset.theme = appearance.theme;
    root.dataset.motion = appearance.reduceMotion;
  }, [appearance]);
  useLayoutEffect(() => setThumbnailBudget(settings.ramCacheMB), [settings.ramCacheMB]);
  useEffect(() => {
    const activity = () => { active.current = true; };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    events.forEach(event => window.addEventListener(event, activity, { passive: true }));
    return () => events.forEach(event => window.removeEventListener(event, activity));
  }, []);
  useEffect(() => {
    if (!unlocked) return;
    active.current = true;
    const interval = setInterval(() => {
      const wasActive = active.current; active.current = false;
      void mutate('/session/heartbeat', 'POST', { active: wasActive, playing: playing.current }).catch(() => { /* session polling handles lock */ });
    }, 15000);
    return () => clearInterval(interval);
  }, [unlocked]);
  const loadData = useCallback(async () => {
    dataRequest.current?.abort();
    const request = new AbortController();
    dataRequest.current = request;
    const options = { signal: request.signal };
    const results = await Promise.allSettled([api<Home>('/home', options), api<string[]>('/tags', options), api<Settings>('/settings', options)]);
    if (request.signal.aborted) return;
    if (results[0].status === 'fulfilled') setHome(results[0].value);
    if (results[1].status === 'fulfilled') setTags(results[1].value);
    if (results[2].status === 'fulfilled') {
      const value = results[2].value;
      setSettings({ ...defaultSettings, ...value, hotkeys: { ...defaultSettings.hotkeys, ...value.hotkeys } });
    }
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') setNotice({ text: errorMessage(failed.reason, t), error: true });
  }, [t]);
  useEffect(() => {
    if (unlocked) void loadData();
    return () => dataRequest.current?.abort();
  }, [unlocked, session.accountId, loadData]);
  useEffect(() => { if (!notice || notice.error) return; const timeout = setTimeout(() => setNotice(null), 5000); return () => clearTimeout(timeout); }, [notice]);
  const onPlaying = useCallback((value: boolean) => { playing.current = value; }, []);
  const onTimeline = useCallback((time: number, volume: number) => {
    if (selectedRef.current) { selectedRef.current.time = time; selectedRef.current.volume = volume; }
  }, []);
  const clearPlayer = useCallback(() => {
    playing.current = false;
    setSelected(null);
    if (galleryDirty.current) {
      galleryDirty.current = false;
      setRevision(value => value + 1);
    }
  }, []);
  const applyLocation = useCallback((keepPlayer = false) => {
    const next = readLocation();
    const previous = locationRef.current;
    if (previous.path === next.path && previous.galleryPath === next.galleryPath) return;
    if (previous.category !== next.category) setGallery(newGalleryState());
    locationRef.current = next;
    setLocation(next);
    setCopyLinkNotice(null);
    setModal(null);
    setAccountMenu(false);
    if (!keepPlayer) {
      cancelMediaOpen();
      clearPlayer();
    }
  }, [cancelMediaOpen, clearPlayer]);
  useEffect(() => {
    const onPopState = () => applyLocation();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyLocation]);
  function navigate(path: string, replace = false) {
    if (path === locationRef.current.path) return;
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    applyLocation();
  }
  function backFromPlayer() {
    if (location.galleryPath) window.history.back();
    else if (category) navigate(`/${category}`, true);
  }
  async function openMedia(source: Media | Pick<Media, 'type' | 'id'>, updatePath = true) {
    cancelMediaOpen();
    const request = new AbortController();
    mediaRequest.current = request;
    const options = { method: 'POST', signal: request.signal };
    try {
      const media = 'title' in source ? source : await api<Media>(`/media/${encodeURIComponent(source.id)}`, { signal: request.signal });
      if (request.signal.aborted) return;
      if (media.type !== source.type) throw new ApiError(404, 'not_found');
      const play = media.type === 'video' ? await api<{ id: string }>(`/media/${media.id}/play-sessions`, options) : null;
      if (session.role === 'User') {
        await api(`/media/${media.id}/opened`, options);
        galleryDirty.current = true;
      }
      if (request.signal.aborted) return;
      if (updatePath) {
        const nextPath = mediaPath(media);
        const current = locationRef.current;
        if (current.mediaId) window.history.replaceState(window.history.state, '', nextPath);
        else window.history.pushState({ galleryPath: current.path }, '', nextPath);
        applyLocation(true);
      }
      setSelected({ media, time: 0, ...readPlaybackVolume(session.accountId ?? '', settings.volume), playSessionId: play?.id ?? null, counted: false });
    } catch (err) {
      if (request.signal.aborted) return;
      if (err instanceof ApiError && err.status === 404) {
        if (!updatePath) navigate(`/${source.type}`, true);
        setNotice({ text: t.mediaUnavailable, error: true });
      } else setNotice({ text: errorMessage(err, t), error: true });
    } finally {
      if (mediaRequest.current === request) mediaRequest.current = null;
    }
  }
  const openLinkedMedia = useEffectEvent((type: MediaType, id: string) => {
    if (selectedRef.current?.media.id !== id) void openMedia({ type, id }, false);
  });
  useEffect(() => {
    if (unlocked && mediaType && mediaId) openLinkedMedia(mediaType, mediaId);
  }, [unlocked, session.accountId, mediaType, mediaId]);
  async function copyMediaLink(media: Media) {
    const from = locationRef.current;
    const account = session.accountId;
    const url = new URL(mediaPath(media), session.publicOrigin ?? window.location.origin);
    let result = { text: t.linkCopied, error: false };
    try { await navigator.clipboard.writeText(url.href); }
    catch { result = { text: t.copyLinkFailed, error: true }; }
    const currentSession = sessionRef.current;
    if (locationRef.current === from && currentSession.accountId === account && !currentSession.locked) setCopyLinkNotice(result);
  }
  async function navigateMedia(direction: 'next' | 'previous') {
    const current = selectedRef.current?.media;
    if (!current) return;
    cancelMediaOpen();
    const request = new AbortController();
    mediaRequest.current = request;
    try {
      const media = await api<Media | null>(`/media/${current.id}/neighbor?direction=${direction}`, { signal: request.signal });
      if (!request.signal.aborted && media && media.id !== current.id && selectedRef.current?.media.id === current.id)
        await openMedia(media);
    } catch (err) {
      if (!request.signal.aborted) setNotice({ text: errorMessage(err, t), error: true });
    } finally {
      if (mediaRequest.current === request) mediaRequest.current = null;
    }
  }
  async function lock() {
    playing.current = false;
    localPrivacyLock.current = true;
    acceptSession({ ...session, locked: true });
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    try { const value = await mutate<Session | undefined>('/auth/lock', 'POST'); if (value) acceptSession(value); else await refreshSession(); }
    catch (err) { setNotice({ text: errorMessage(err, t), error: true }); }
  }
  async function logout() {
    try { await mutate('/auth/logout', 'POST'); sessionVersion.current++; navigate('/', true); acceptSession(guestSession); }
    catch (err) { setNotice({ text: errorMessage(err, t), error: true }); }
  }
  function invalidate() { setRevision(value => value + 1); void loadData(); }
  function updateMedia(media: MediaUpdate) {
    setSelected(previous => previous?.media.id === media.id ? { ...previous, media: { ...previous.media, ...media } } : previous);
    galleryDirty.current = true;
  }
  function goHome() {
    navigate('/');
  }
  useEffect(() => {
    if (!unlocked || modal) return;
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || isTypingTarget(event.target, true)) return;
      if (matchesHotkey(event, settings.hotkeys.lock)) {
        event.preventDefault();
        void lock();
      } else if (matchesHotkey(event, settings.hotkeys.goHome)) {
        event.preventDefault();
        goHome();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const gallerySettings = previewSettings ? {
    ...settings,
    gridColumns: appearance.gridColumns,
    gridGapPx: appearance.gridGapPx,
    cardAspectRatio: appearance.cardAspectRatio,
    cardTitleLines: appearance.cardTitleLines,
  } : settings;
  if (!ready) return <div className="initial-loading"><Brand/><span className="spinner"/></div>;
  if (connectionError && !session.authenticated) return <div className="connection-screen"><Brand/><Icon name="lock" size={38}/><p>{t.connectionError}</p><button className="primary-button" onClick={() => { void refreshSession(); }}>{t.retry}</button></div>;
  if (!unlocked) return <Auth session={session} language={settings.language} onLanguage={language => setSettings(value => ({ ...value, language }))} serverError={notice?.error ? notice.text : connectionError ? t.connectionError : undefined} onSession={value => {
    sessionVersion.current++;
    localPrivacyLock.current = false;
    setNotice(null);
    acceptSession(value);
  }}/>;
  return <div className="app"><header className="app-header"><div className="header-left"><Brand onClick={goHome}/><span className="header-divider"/><span className="header-section">{category ? t[category] : t.library}</span></div><div className="header-actions"><span className="connection-badge" data-disconnected={connectionError || undefined} role="status"><span className="status-dot"/>{connectionError ? t.disconnected : t.connected}</span><button className="icon-button" onClick={() => { void lock(); }} aria-label={t.lock} title={t.lock}><Icon name="lock"/></button><div className="account-dropdown"><button className="account-button" onClick={() => setAccountMenu(!accountMenu)} aria-expanded={accountMenu}><span className="avatar">{accountName.charAt(0).toUpperCase()}</span><span>{accountName}</span><Icon name="chevron" size={12}/></button>{accountMenu && <><button className="menu-dismiss" aria-label={t.close} onClick={() => setAccountMenu(false)}/><div className="account-menu"><button onClick={() => { setAccountMenu(false); setModal('settings'); }}><Icon name="settings" size={17}/>{t.settings}</button>{admin && <button onClick={() => { setAccountMenu(false); setModal('trash'); }}><Icon name="trash" size={17}/>{t.trash}</button>}<button onClick={() => { setAccountMenu(false); void logout(); }}><Icon name="logout" size={17}/>{t.logout}</button></div></>}</div></div></header>
    {session.weakPassword && <div className="weak-password-notice"><Icon name="shield" size={16}/><span>{t.weakPassword}</span><button onClick={() => setModal('security')}>{t.changePassword}<Icon name="chevron" size={13}/></button></div>}
    {connectionError && <div className="connection-notice" role="alert">{t.connectionError}<button className="text-button" onClick={() => { void refreshSession(); }}>{t.retry}</button></div>}
    <PageTransition key={session.accountId} pageKey={category ?? 'home'} settings={appearance}>
    {category ? <Gallery type={category} t={t} settings={gallerySettings} state={gallery} setState={setGallery} tags={tags} admin={admin} canUpload={canUpload} revision={revision} onOpen={media => { void openMedia(media); }} onImport={() => setModal('import')} onImportAlbum={() => setModal('album-import')} onBack={goHome}/>
      : <main className="home-page"><div className="home-intro"><div><span className="eyebrow"><span className="tiny-diamond"/>{t.privateLibrary}</span><h1>{t.welcome}</h1><p>{t.welcomeText}</p></div></div>
      <div className="category-grid">{(['photo', 'video', 'gif'] as const).map((type, index) => {
        const stats = home?.categories.find(item => item.type === type);
        const href = `/${type}`;
        return <a className={`category-card category-${type}`} href={href} onClick={event => followLink(event, () => navigate(href))} key={type}>
          <div className="category-art" aria-hidden="true">{type === 'gif' ? <div className="gif-art"><span/><span/><span/><Icon name="play" size={40}/></div> : type === 'video' ? <div className="film-art"><div className="film-frame"><span/><span/><span/><span/><Icon name="play" size={48}/></div><div className="film-shadow"/></div> : <div className="photo-art"><span className="photo-back"/><span className="photo-front"><span className="photo-sun"/><span className="mountain mountain-one"/><span className="mountain mountain-two"/></span></div>}<span className="category-number">0{index + 1}</span></div>
          <div className="category-card-content"><div className="category-title"><h2>{t[type]}</h2><span className="category-arrow"><Icon name="arrow" size={20}/></span></div><p>{type === 'gif' ? t.gifDescription : type === 'video' ? t.videoDescription : t.photoDescription}</p><div className="category-stats"><span>{stats ? stats.count.toLocaleString(settings.language) : '—'} <span>{fileCountLabel(stats?.count ?? 0, settings.language)}</span></span><span>{stats ? formatBytes(stats.totalBytes) : '—'}</span></div></div>
        </a>;
      })}</div>
      <div className="library-overview"><div className="overview-item"><span className="overview-icon"><Icon name="grid" size={20}/></span><div><strong>{home ? home.totalCount.toLocaleString(settings.language) : '—'}</strong><span>{t.allFiles}</span></div></div><span className="overview-divider"/><div className="overview-item"><span className="overview-icon"><Icon name="album" size={20}/></span><div><strong>{home ? formatBytes(home.totalBytes) : '—'}</strong><span>{t.storage}</span></div></div><div className="overview-privacy"><Icon name="shield" size={23}/><div><strong>{t.encrypted}</strong><span>{t.accountAccess}</span></div></div></div>
      <footer className="home-footer"><span>Shronchik by kentakle</span><span><Icon name="lock" size={13}/>{t.privateLibrary}</span></footer></main>}
    </PageTransition>
    {selected && <PlayerOverlay title={selected.media.title} backLabel={t.backGallery} onDismissStart={cancelMediaOpen} onClose={backFromPlayer}
      copyLinkLabel={t.copyLink} copyLinkNotice={copyLinkNotice} onCopyLink={() => { void copyMediaLink(selected.media); }}>
      {(dismiss, closing) => <Player key={selected.media.id} context={selected} t={t} language={settings.language}
        admin={admin} accountId={session.accountId ?? ''} settings={settings} closing={closing}
        onOpenRelated={media => { void openMedia(media); }} onNavigate={direction => { void navigateMedia(direction); }}
        onUpdate={updateMedia} onTimeline={onTimeline} onPlaying={onPlaying}
        onTag={tag => { setGallery(previous => ({ ...previous, query: '', tags: { [tag]: 1 }, tab: 'home' })); dismiss(); }}
        onTrash={() => { dismiss(); invalidate(); }} onAlbumsChanged={() => { galleryDirty.current = true; }}/>}
    </PlayerOverlay>}
    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'close' : 'check'} size={18}/><span>{notice.text}</span><button className="inline-icon" onClick={() => setNotice(null)} aria-label={t.close}><Icon name="close" size={15}/></button></div>}
    {modal === 'import' && category && canUpload && <ImportDialog key={category} type={category} t={t} language={settings.language} thumbnailCandidates={settings.thumbnailCandidates} allowSourceDeletion={admin} onClose={() => setModal(null)} onImported={() => { setModal(null); setNotice({ text: t.imported }); invalidate(); }}/>}
    {modal === 'album-import' && category === 'photo' && canUpload && <AlbumImportDialog t={t} language={settings.language} allowSourceDeletion={admin} onClose={count => {
      setModal(null);
      invalidate();
      if (count > 0) setNotice({ text: settings.language === 'ru' ? `Добавлено фотографий: ${count}` : `Photos added: ${count}` });
    }}/>}
    {(modal === 'settings' || modal === 'security') && <SettingsDialog t={t} settings={settings} role={session.role!} initialSection={modal === 'security' ? 'security' : 'appearance'} onClose={() => setModal(null)} onSave={value => {
      if (sessionRef.current.accountId !== session.accountId || sessionRef.current.locked) return;
      setSettings(value); setRevision(previous => previous + 1);
    }} onPreview={setPreviewSettings} onPasswordChanged={() => { void refreshSession(); }}/>}
    {modal === 'trash' && admin && <TrashDialog t={t} onClose={() => setModal(null)} onRestored={() => { setNotice({ text: t.restored }); invalidate(); }}/>} 
  </div>;
}

function fileCountLabel(count: number, language: Settings['language']) {
  const form = new Intl.PluralRules(language).select(count);
  if (language === 'en') return form === 'one' ? 'file' : 'files';
  return form === 'one' ? 'файл' : form === 'few' ? 'файла' : 'файлов';
}

function accentInk(color: string) {
  const [red, green, blue] = [1, 3, 5].map(offset => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance >= 0.179 ? '#000000' : '#ffffff';
}
