import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { api, streamUrl } from './api';
import { AlbumsPanel } from './Albums';
import { albumImportLabel } from './AlbumImportDialog';
import { followLink, mediaPath } from './routes';
import { formatBytes } from './Dialogs';
import { isTypingTarget, matchesHotkey } from './hotkeys';
import { errorMessage } from './i18n';
import type { T } from './i18n';
import { Icon } from './Icon';
import { VideoThumbnail } from './VideoThumbnail';
import { ThumbnailTags } from './ThumbnailTags';
import { builtInTagGroups, builtInTags, canonicalTag, tagLabel, tagMatchesQuery } from './tags';
import { useThumbnail } from './useThumbnail';
import type { Language, Media, MediaPage, MediaType, Settings } from './types';

export type GalleryTab = 'home' | 'favorites' | 'history' | 'albums';
export type GalleryState = {
  query: string;
  tab: GalleryTab;
  sort: string;
  tags: Record<string, 1 | -1>;
  seed: string;
};

export function newGalleryState(): GalleryState {
  return { query: '', tab: 'home', sort: 'random', tags: {}, seed: String(Date.now()) };
}

const emptyPage: MediaPage = { items: [], nextCursor: null, hasMore: false };
type GalleryPage = { page: MediaPage; receivedAt: number; error?: unknown };
const cacheLifetimeMs = 25000;
const cachePageLimit = 8;

type GalleryProps = {
  type: MediaType;
  t: T;
  settings: Settings;
  state: GalleryState;
  setState: (value: GalleryState) => void;
  tags: string[];
  admin: boolean;
  canUpload: boolean;
  revision: number;
  onOpen: (media: Media) => void;
  onImport: () => void;
  onImportAlbum: () => void;
  onBack: () => void;
};

export function Gallery({ type, t, settings, state, setState, tags, admin, canUpload, revision, onOpen, onImport, onImportAlbum, onBack }: GalleryProps) {
  const [sidebar, setSidebar] = useState(settings.sidebarExpanded);
  const [tagSearch, setTagSearch] = useState('');
  const [pages, setPages] = useState(() => new Map<string, GalleryPage>());
  const [paging, setPaging] = useState<string | null>(null);
  const [changedTab, setChangedTab] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState(state.query);
  const requests = useRef(new Map<string, AbortController>());
  const sentinel = useRef<HTMLDivElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const mediaSearch = useRef<HTMLInputElement>(null);
  const sidebarId = useId();
  const activeTab = admin ? 'home' : state.tab;
  const activeTags = Object.entries(state.tags);
  const filtered = Boolean(state.query.trim() || activeTags.length);
  const albums = activeTab === 'albums';
  const recommendedOrder = type === 'video' && activeTab === 'home';

  const displayedTagGroups = useMemo(() => {
    const available = new Set(tags.map(canonicalTag));
    return builtInTagGroups.map(group => ({
      ...group,
      tags: builtInTags.filter(tag => tag.group === group.id && available.has(tag.id) && tagMatchesQuery(tag, tagSearch)),
    })).filter(group => group.tags.length);
  }, [tags, tagSearch]);

  useEffect(() => { setSidebar(settings.sidebarExpanded); }, [settings.sidebarExpanded]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(state.query), settings.queryDebounceMs);
    return () => window.clearTimeout(timer);
  }, [state.query, settings.queryDebounceMs]);

  const query = new URLSearchParams({
    type,
    query: debouncedQuery,
    tab: activeTab,
    sort: state.sort,
    seed: activeTab === 'home' ? state.seed : '0',
    limit: String(settings.pageBatchSize),
    includeTags: activeTags.filter(([, value]) => value === 1).map(([tag]) => tag).join(','),
    excludeTags: activeTags.filter(([, value]) => value === -1).map(([tag]) => tag).join(','),
  }).toString();
  const cacheKey = revision + ':' + query;
  const initialKey = useRef(cacheKey);
  const entry = pages.get(cacheKey);
  const page = entry?.page ?? emptyPage;
  const error = entry?.error ? errorMessage(entry.error, t) : '';
  const loading = !albums && (!entry || paging === cacheKey);

  const storePage = useCallback((key: string, update: (previous?: GalleryPage) => GalleryPage) => {
    setPages(previous => {
      const next = new Map(previous);
      next.delete(key);
      next.set(key, update(previous.get(key)));
      const oldest = next.keys().next().value;
      if (next.size > cachePageLimit && oldest !== undefined) next.delete(oldest);
      return next;
    });
  }, []);

  useEffect(() => {
    const pending = requests.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, []);

  const receivedAt = entry?.receivedAt;
  useEffect(() => {
    const pending = requests.current;
    if (albums || pending.has(cacheKey) || (receivedAt !== undefined && Date.now() - receivedAt < cacheLifetimeMs)) return;
    const oldest = pending.keys().next().value;
    if (pending.size >= cachePageLimit && oldest !== undefined) {
      pending.get(oldest)?.abort();
      pending.delete(oldest);
    }
    const controller = new AbortController();
    pending.set(cacheKey, controller);
    void api<MediaPage>('/media?' + query, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) storePage(cacheKey, () => ({ page: result, receivedAt: Date.now() }));
      })
      .catch(err => {
        if (!controller.signal.aborted)
          storePage(cacheKey, previous => ({ page: previous?.page ?? emptyPage, receivedAt: Date.now(), error: err }));
      })
      .finally(() => { if (pending.get(cacheKey) === controller) pending.delete(cacheKey); });
  }, [albums, cacheKey, query, receivedAt, storePage]);

  const loadMore = useCallback(async () => {
    const pending = requests.current;
    if (pending.has(cacheKey) || !page.hasMore || !page.nextCursor || error) return;
    const controller = new AbortController();
    pending.set(cacheKey, controller);
    setPaging(cacheKey);
    try {
      const cursor = encodeURIComponent(page.nextCursor);
      const result = await api<MediaPage>('/media?' + query + '&cursor=' + cursor, { signal: controller.signal });
      if (controller.signal.aborted) return;
      storePage(cacheKey, previous => {
        const items = previous?.page.items ?? page.items;
        const existing = new Set(items.map(item => item.id));
        return { receivedAt: Date.now(), page: { ...result, items: [...items, ...result.items.filter(item => !existing.has(item.id))] } };
      });
    } catch (err) {
      if (!controller.signal.aborted)
        storePage(cacheKey, previous => ({ page: previous?.page ?? page, receivedAt: Date.now(), error: err }));
    } finally {
      if (pending.get(cacheKey) === controller) pending.delete(cacheKey);
      setPaging(previous => previous === cacheKey ? null : previous);
    }
  }, [cacheKey, error, page, query, storePage]);

  useEffect(() => {
    if (!sentinel.current || !page.hasMore || loading || error) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: `0px 0px ${Math.max(400, window.innerHeight * .65)}px 0px` });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [error, loadMore, loading, page.hasMore]);

  const changeSidebar = useCallback((open: boolean) => {
    setSidebar(open);
    window.requestAnimationFrame(() => {
      const target = open ? mediaSearch.current : sidebarToggle.current;
      target?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (albums || event.defaultPrevented || event.repeat || document.querySelector('dialog[open]')) return;
      const inSidebar = event.target instanceof Node && document.getElementById(sidebarId)?.contains(event.target);
      const commandInSidebar = inSidebar && (event.ctrlKey || event.altKey);
      if (sidebar && event.key === 'Escape' && inSidebar) {
        event.preventDefault();
        changeSidebar(false);
      } else if ((commandInSidebar || !isTypingTarget(event.target)) && matchesHotkey(event, settings.hotkeys.toggleFilters)) {
        event.preventDefault();
        changeSidebar(!sidebar);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [albums, changeSidebar, settings.hotkeys.toggleFilters, sidebar, sidebarId]);

  function cycleTag(tag: string) {
    const current = state.tags[tag];
    const next: GalleryState['tags'] = { ...state.tags, [tag]: current === 1 ? -1 : 1 };
    if (current === -1) delete next[tag];
    setState({ ...state, tags: next });
  }

  function clearFilters() {
    setState({ ...state, query: '', tags: {} });
  }

  const tabs = [
    { value: 'home', label: recommendedOrder && state.sort === 'random' ? t.recommendations : t.allMedia, icon: 'grid' },
    { value: 'albums', label: t.albums, icon: 'album' },
    { value: 'favorites', label: t.favorites, icon: 'heart' },
    { value: 'history', label: t.history, icon: 'history' },
  ] as const;
  const visibleTabs = tabs.filter(tab => !admin || tab.value === 'home');

  let emptyTitle = t.noMedia;
  let emptyText = canUpload ? t.noMediaText : t.noUserMediaText;
  if (filtered) [emptyTitle, emptyText] = [t.noResults, t.noResultsText];
  else if (activeTab === 'favorites') [emptyTitle, emptyText] = [t.noFavorites, t.noFavoritesText];
  else if (activeTab === 'history') [emptyTitle, emptyText] = [t.noHistory, t.noHistoryText];
  const emptyIcon = activeTab === 'favorites' ? 'heart' : activeTab === 'history' ? 'history' : type;
  const showEmpty = Boolean(entry) && !loading && !page.items.length && !error;

  return <div className={'gallery-shell' + (sidebar && !albums ? ' sidebar-open' : '')}>
    {sidebar && !albums && <button className="sidebar-scrim" aria-label={t.close} tabIndex={-1} onClick={() => changeSidebar(false)}/>}
    <aside id={sidebarId} className="filter-sidebar" aria-label={t.filters} hidden={!sidebar || albums}>
      <div className="sidebar-section">
        <div className="sidebar-label">
          <h2>{t.filters}</h2>
          <button className="icon-button sidebar-close" aria-label={t.close} onClick={() => changeSidebar(false)}><Icon name="close"/></button>
        </div>
        <div className="search-field">
          <Icon name="search"/>
          <input ref={mediaSearch} type="search" value={state.query} onChange={e => setState({ ...state, query: e.target.value })} placeholder={t.searchHint} aria-label={t.search}/>
        </div>
      </div>
      <div className="sidebar-section sidebar-tags-section">
        <div className="sidebar-label">
          <h3>{t.tags}</h3>
          {activeTags.length > 0 && <span className="count-pill">{activeTags.length}</span>}
        </div>
        <div className="search-field tag-search">
          <Icon name="search"/>
          <input type="search" value={tagSearch} onChange={e => setTagSearch(e.target.value)} placeholder={t.searchTags} aria-label={t.searchTags}/>
        </div>
        <div className="tag-legend">
          <span><i className="include-dot"/>{t.include}</span>
          <span><i className="exclude-dot"/>{t.exclude}</span>
        </div>
        <div className="filter-tags">
          {displayedTagGroups.length ? displayedTagGroups.map(group => <section key={group.id} className="filter-tag-group" aria-label={group[settings.language]}>
            <h4>{group[settings.language]}</h4>
            <div className="filter-tag-options">{group.tags.map(tag => {
              const { id } = tag;
              const label = tagLabel(tag);
              const value = state.tags[id];
              const mode = value === 1 ? 'included' : value === -1 ? 'excluded' : '';
              const status = value === 1 ? t.include : value === -1 ? t.exclude : t.neutral;
              return <button key={id} className={'filter-tag ' + mode} onClick={() => cycleTag(id)} aria-label={label + ' · ' + status}>
                <span>{label}</span>
                {value === 1 ? <Icon name="check"/> : value === -1 ? <Icon name="close"/> : <span className="tag-neutral-mark"/>}
              </button>;
            })}</div>
          </section>) : <p className="help-text">{tagSearch.trim() ? t.noMatchingTags : t.noTags}</p>}
        </div>
        {filtered && <button className="text-button clear-filters" onClick={clearFilters}><Icon name="refresh"/>{t.clearFilters}</button>}
      </div>
      <button className="sidebar-back" onClick={onBack}><Icon name="back"/>{t.home}</button>
    </aside>
    <main className="gallery-main">
      <div className="gallery-topline">
        <div className="gallery-heading">
          {!albums && <button ref={sidebarToggle} className="icon-button sidebar-toggle" onClick={() => changeSidebar(!sidebar)} aria-label={t.filters} aria-expanded={sidebar} aria-controls={sidebarId}>
            <Icon name="menu"/>
            <span className="sidebar-toggle-label">{t.filters}</span>
            {activeTags.length > 0 && <span className="count-pill">{activeTags.length}</span>}
          </button>}
          <div><span className="eyebrow">{t.collection}</span><h1>{t[type]}</h1></div>
        </div>
        <div className="gallery-tools">
          {canUpload && type === 'photo' && <button className="secondary-button small" onClick={onImportAlbum} aria-label={albumImportLabel(settings.language)} title={albumImportLabel(settings.language)}><Icon name="album"/><span>{albumImportLabel(settings.language)}</span></button>}
          {canUpload && <button className="primary-button small" onClick={onImport} aria-label={t.import}><Icon name="plus"/><span>{t.importShort}</span></button>}
        </div>
      </div>
      <nav className="gallery-tabs" aria-label={t.library}>
        {visibleTabs.map(tab => <button key={tab.value} className={activeTab === tab.value ? 'active' : ''} aria-current={activeTab === tab.value ? 'page' : undefined}
          onClick={() => {
            setChangedTab(true);
            setState({ ...state, tab: tab.value, seed: tab.value === 'home' && activeTab === 'home' ? String(Date.now()) : state.seed });
          }}>
          <Icon name={tab.icon}/>{tab.label}
          {tab.value === 'home' && activeTab === 'home' && <Icon name="refresh"/>}
        </button>)}
      </nav>
      {error && <div className="gallery-error" role="alert">
        <p>{error}</p>
        <button className="secondary-button" onClick={() => setPages(previous => {
          const next = new Map(previous);
          next.delete(cacheKey);
          return next;
        })}>{t.retry}</button>
      </div>}
      {albums ? <AlbumsPanel language={settings.language} t={t} revision={revision} pageSize={settings.pageBatchSize}
        renderItems={items => <VirtualGrid items={items} settings={settings} t={t} admin={admin} onOpen={onOpen}/>}/>
      : showEmpty ? <div className="empty-state">
        <span className="empty-icon"><Icon name={emptyIcon}/></span>
        <h2>{emptyTitle}</h2>
        <p>{emptyText}</p>
        {!filtered && activeTab === 'home' && canUpload && <button className="primary-button" onClick={onImport}><Icon name="plus"/>{t.import}</button>}
        {filtered && !albums && <button className="secondary-button" onClick={clearFilters}>{t.clearFilters}</button>}
      </div> : <>
        {page.items.length > 0 && <VirtualGrid items={page.items} settings={settings} t={t} admin={admin} onOpen={onOpen}/>}
        {loading && !page.items.length && (!changedTab && initialKey.current === cacheKey
          ? <LoadingGrid settings={settings} t={t}/>
          : <div className="loading-block" role="status"><span className="spinner"/>{t.loading}</div>)}
        {(page.hasMore || loading && page.items.length > 0) && <div className="load-more" ref={sentinel}>
          {loading ? <span className="spinner" role="status" aria-label={t.loading}/> : <button className="secondary-button" disabled={Boolean(error)} onClick={() => { void loadMore(); }}>{t.loadMore}</button>}
        </div>}
      </>}
    </main>
  </div>;
}

function LoadingGrid({ settings, t }: { settings: Settings; t: T }) {
  if (!settings.showSkeletons) return <div className="loading-block" role="status"><span className="spinner"/>{t.loading}</div>;
  return <div className="skeleton-grid" role="status" aria-label={t.loading} style={{
    '--skeleton-columns': settings.gridColumns,
    '--grid-gap': settings.gridGapPx + 'px',
    '--card-aspect-ratio': settings.cardAspectRatio.replace(':', '/'),
  } as CSSProperties}>
    {Array.from({ length: Math.min(settings.gridColumns * 2, 24) }, (_, i) => <div className="skeleton-card" key={i}><div/><span/><span/></div>)}
  </div>;
}

type GridWindow = {
  columns: number;
  cardHeight: number;
  previewHeight: number;
  rowHeight: number;
  totalHeight: number;
  firstRow: number;
  lastRow: number;
  firstGifRow: number;
  lastGifRow: number;
};

function VirtualGrid({ items, settings, t, admin, onOpen }: { items: Media[]; settings: Settings; t: T; admin: boolean; onOpen: (value: Media) => void }) {
  const region = useRef<HTMLDivElement>(null);
  const measureCard = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<GridWindow | null>(null);
  const { gridGapPx: gap, cardTitleLines, cardAspectRatio, gridColumns, gifVisibilityMarginPx: gifMargin } = settings;
  const itemCount = items.length;
  const hasGifs = useMemo(() => items.some(item => item.type === 'gif'), [items]);

  useLayoutEffect(() => {
    const container = region.current;
    const probe = measureCard.current;
    if (!container || !probe) return;
    const [aspectWidth, aspectHeight] = cardAspectRatio.split(':').map(Number);
    let frame: number | undefined;
    let needsMeasure = true;
    let geometry: {
      columns: number; cardHeight: number; previewHeight: number; rowHeight: number;
      top: number; viewport: number; rowCount: number; overscan: number;
    } | undefined;
    let lastWindow: GridWindow | undefined;

    function updateWindow() {
      frame = undefined;
      const scroll = window.scrollY;
      if (needsMeasure) {
        const bounds = container!.getBoundingClientRect();
        const card = probe!.getBoundingClientRect();
        if (bounds.width <= 0 || !itemCount) return;
        const columns = Math.max(1, Math.min(gridColumns, Math.floor((bounds.width + gap) / (card.width + gap))));
        const previewWidth = (bounds.width - gap * (columns - 1)) / columns;
        const previewHeight = Math.max(1, Math.round(previewWidth * aspectHeight / aspectWidth));
        const cardHeight = previewHeight + card.height;
        const rowHeight = cardHeight + gap;
        const viewport = window.innerHeight;
        geometry = {
          columns, previewHeight, cardHeight, rowHeight, viewport, top: bounds.top + scroll,
          rowCount: Math.ceil(itemCount / columns),
          overscan: Math.max(2, Math.ceil(viewport / rowHeight / 2)),
        };
        needsMeasure = false;
      }
      if (!geometry) return;
      const { columns, previewHeight, cardHeight, rowHeight, top, viewport, rowCount, overscan } = geometry;
      const start = scroll - top;
      const end = start + viewport;
      const firstGifRow = hasGifs ? Math.min(rowCount, Math.max(0, Math.floor((start - gifMargin) / rowHeight))) : 0;
      const lastGifRow = hasGifs ? Math.max(0, Math.min(rowCount, Math.ceil((end + gifMargin) / rowHeight))) : 0;
      const firstRow = Math.min(rowCount - 1, Math.max(0, Math.floor(start / rowHeight) - overscan));
      const lastRow = Math.min(rowCount, Math.max(firstRow + 1, lastGifRow, Math.ceil(end / rowHeight) + overscan));
      const next: GridWindow = {
        columns, previewHeight, cardHeight, rowHeight, firstRow: hasGifs ? Math.min(firstRow, firstGifRow) : firstRow, lastRow,
        firstGifRow, lastGifRow, totalHeight: rowCount * rowHeight - gap,
      };
      // Wheel and touch events can arrive on every frame. Only reconcile the
      // grid when its geometry or the set of visible rows actually changes.
      if (lastWindow && (Object.keys(next) as (keyof GridWindow)[]).every(key => lastWindow![key] === next[key])) return;
      lastWindow = next;
      setLayout(next);
    }
    function scheduleWindow() {
      frame ??= window.requestAnimationFrame(updateWindow);
    }
    function scheduleMeasure() {
      needsMeasure = true;
      scheduleWindow();
    }
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    observer.observe(probe);
    if (container.parentElement) observer.observe(container.parentElement);
    window.addEventListener('scroll', scheduleWindow, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    updateWindow();
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', scheduleWindow);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [cardAspectRatio, cardTitleLines, gap, gifMargin, gridColumns, hasGifs, itemCount]);

  const style = { '--grid-gap': gap + 'px', '--card-title-lines': cardTitleLines, height: layout?.totalHeight } as CSSProperties;
  let cards = null;
  if (layout) {
    const { columns, previewHeight, cardHeight, rowHeight, firstRow, lastRow, firstGifRow, lastGifRow } = layout;
    const playingGifs = new Set(items.slice(firstGifRow * columns, lastGifRow * columns)
      .filter(item => item.type === 'gif')
      .slice(0, settings.maxAnimatedCards)
      .map(item => item.id));

    cards = <div className="media-grid" style={{
      '--columns': columns,
      '--card-height': cardHeight + 'px',
      '--preview-height': previewHeight + 'px',
      transform: 'translateY(' + firstRow * rowHeight + 'px)',
    } as CSSProperties}>
      {items.slice(firstRow * columns, lastRow * columns).map(item => <MediaCard key={item.id}
        item={item} t={t} admin={admin} language={settings.language} hoverDelayMs={settings.hoverDelayMs} loadPreview={item.type !== 'gif' || playingGifs.has(item.id)} onOpen={onOpen}/>)}
    </div>;
  }

  return <div className="virtual-region" ref={region} style={style}>
    <div className="grid-measurement" ref={measureCard} aria-hidden="true"/>
    {cards}
  </div>;
}

const MediaCard = memo(function MediaCard({ item, t, admin, language, hoverDelayMs, loadPreview, onOpen }: { item: Media; t: T; admin: boolean; language: Language; hoverDelayMs: number; loadPreview: boolean; onOpen: (item: Media) => void }) {
  const preview = useRef<HTMLDivElement>(null);
  const [failedSource, setFailedSource] = useState('');
  const source = item.type !== 'video' && loadPreview ? streamUrl(item.id) : '';
  // Avoid downloading large photo and GIF originals into the thumbnail cache.
  const cacheable = item.size <= 8 * 1024 * 1024;
  const thumbnail = useThumbnail(cacheable ? source : '', 'image', preview);
  const imageUrl = cacheable ? thumbnail?.url : source;
  const failed = Boolean(thumbnail?.error || (imageUrl && imageUrl === failedSource));
  return <a className="media-card" href={mediaPath(item)} onClick={event => followLink(event, () => onOpen(item))}>
    <div className={'card-preview preview-' + item.type} ref={preview}>
      {item.type === 'video' ? <VideoThumbnail id={item.id} version={item.posterVersion} hoverDelayMs={hoverDelayMs}/>
        : !imageUrl || failed ? <span className="image-failed" title={failed ? t.imageUnavailable : undefined}><Icon name={item.type}/></span>
        : <img src={imageUrl} alt="" loading={cacheable || item.type === 'gif' ? 'eager' : 'lazy'} decoding="async" onError={() => setFailedSource(imageUrl)}/>}
      {!admin && item.isFavorite && <span className="card-heart"><Icon name="heart" filled/></span>}
      {item.type === 'gif' && <span className="media-kind">GIF</span>}
    </div>
    <div className="card-info">
      <h3 title={item.title}>{item.title}</h3>
      <ThumbnailTags tags={item.tags}/>
      <div className="card-meta">
        <span className={item.rating !== null ? 'has-rating' : ''}><Icon name="star"/>{item.rating?.toLocaleString(language) ?? '—'}</span>
        <span>{item.type === 'video' ? <><Icon name="eye"/>{item.views.toLocaleString(language)}</> : formatBytes(item.size)}</span>
      </div>
    </div>
  </a>;
});
