import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { streamUrl } from './api';
import { Icon } from './Icon';
import { findVideoDuration, loadVideoDuration, queueFrame } from './thumbnailCache';
import { useVideoPoster } from './useVideoPoster';
import { formatDuration, videoDurationCategory } from './videoDuration';
import './video-thumbnail.css';

function useVideoDuration(source: string, target: RefObject<HTMLDivElement | null>) {
  const [result, setResult] = useState<{ source: string; duration: number | null } | null>(null);

  useLayoutEffect(() => {
    if (!source || !target.current) return;
    const duration = findVideoDuration(source);
    if (duration !== undefined) {
      setResult({ source, duration });
      return;
    }

    let cancelled = false;
    let cancelWaiting: (() => void) | undefined;
    const observer = new IntersectionObserver(entries => {
      if (cancelled || !entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      cancelWaiting = queueFrame(async () => {
        try {
          const duration = await loadVideoDuration(source);
          if (!cancelled) setResult({ source, duration });
        } catch {
          // Leave the duration hidden if the media metadata cannot be read.
        }
      }, 'metadata');
    });
    observer.observe(target.current);
    return () => {
      cancelled = true;
      observer.disconnect();
      cancelWaiting?.();
    };
  }, [source, target]);

  return result?.source === source ? result.duration : null;
}

// A pointer or keyboard focus can start only one preview at a time.
let stopCurrentPreview: (() => void) | null = null;

function previewIsAllowed(card: Element) {
  if (document.hidden || card.closest('[inert]')) return false;
  // The focused dialog is the current modal even when dialogs are nested.
  const dialogs = document.querySelectorAll('dialog:modal');
  const modal = document.activeElement?.closest('dialog:modal') ?? dialogs.item(dialogs.length - 1);
  return !modal || modal.contains(card);
}

export function VideoThumbnail({ id, version, hoverDelayMs = 300 }: { id: string; version?: string | null; hoverDelayMs?: number }) {
  const target = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const previewId = useId();
  const previewStart = useRef(0);
  const stopPreview = useRef<(() => void) | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const poster = useVideoPoster(id, version, target);
  const metadataDuration = useVideoDuration(poster.needsDuration ? streamUrl(id) : '', target);
  const duration = poster.duration ?? metadataDuration;
  const category = duration === null ? null : videoDurationCategory(duration);

  useEffect(() => {
    const element = target.current;
    const card = element?.closest('button, a[href]') ?? element;
    if (!element || !card) return;
    let waiting: number | undefined;
    let pointerInside = false;
    let focused = false;
    function stop() {
      window.clearTimeout(waiting);
      waiting = undefined;
      if (stopCurrentPreview === stop) stopCurrentPreview = null;
      preview.current?.pause();
      preview.current?.removeAttribute('src');
      preview.current?.load();
      setPreviewing(false);
      setPreviewReady(false);
    }
    stopPreview.current = stop;
    function schedule() {
      if (waiting !== undefined || stopCurrentPreview === stop || !previewIsAllowed(card!)) return;
      const motion = document.documentElement.dataset.motion;
      if (motion === 'on' || (motion !== 'off' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
      waiting = window.setTimeout(() => {
        waiting = undefined;
        if (!previewIsAllowed(card!)) return;
        stopCurrentPreview?.();
        stopCurrentPreview = stop;
        setPreviewReady(false);
        setPreviewing(true);
      }, Math.max(0, hoverDelayMs));
    }
    const enter = (event: PointerEvent) => { if (event.pointerType !== 'touch') { pointerInside = true; schedule(); } };
    const leave = () => { pointerInside = false; if (!focused) stop(); };
    const focus = () => {
      // Only keyboard focus previews.
      if (card.matches(':focus-visible')) { focused = true; schedule(); }
    };
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && card?.contains(event.relatedTarget)) return;
      focused = false;
      if (!pointerInside) stop();
    };
    const visibility = () => { if (document.hidden) stop(); };
    const modalToggle = () => { if (!previewIsAllowed(card)) stop(); };
    const observer = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) stop(); });
    observer.observe(element);
    card.addEventListener('pointerenter', enter as EventListener);
    card.addEventListener('pointerleave', leave);
    card.addEventListener('focusin', focus);
    card.addEventListener('focusout', blur as EventListener);
    // Release the background decoder before the click starts opening the player.
    card.addEventListener('pointerdown', stop);
    card.addEventListener('click', stop);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('toggle', modalToggle, true);
    return () => {
      stop();
      if (stopPreview.current === stop) stopPreview.current = null;
      observer.disconnect();
      card.removeEventListener('pointerenter', enter as EventListener);
      card.removeEventListener('pointerleave', leave);
      card.removeEventListener('focusin', focus);
      card.removeEventListener('focusout', blur as EventListener);
      card.removeEventListener('pointerdown', stop);
      card.removeEventListener('click', stop);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('toggle', modalToggle, true);
    };
  }, [id, hoverDelayMs]);

  useEffect(() => {
    if (!previewing) return;
    const element = preview.current;
    const card = target.current?.closest('button, a[href]') ?? target.current;
    if (!card) return;
    // Inert changes have no event. Watch only while a decoder is active.
    const observer = new MutationObserver(() => {
      if (!previewIsAllowed(card)) stopPreview.current?.();
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['inert', 'open'] });
    return () => {
      observer.disconnect();
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, [id, previewing]);

  return <div className="video-thumbnail" ref={target}>
    {poster.url
      ? <img src={poster.url} alt="" decoding="async" onError={poster.onError}/>
      : <span className="video-art" aria-hidden="true"><span/><span/><Icon name="play"/></span>}
    {previewing && <video ref={preview} className="video-hover-preview" data-ready={previewReady || undefined}
      src={`${streamUrl(id)}?preview=${encodeURIComponent(previewId)}`} muted playsInline loop preload="auto" aria-hidden="true"
      disablePictureInPicture tabIndex={-1}
      onLoadedMetadata={event => {
        const element = event.currentTarget;
        element.muted = true;
        previewStart.current = Number.isFinite(element.duration) ? Math.min(10, element.duration * .1) : 0;
        if (previewStart.current) element.currentTime = previewStart.current;
        void element.play().catch(() => setPreviewReady(false));
      }}
      onPlaying={() => setPreviewReady(true)}
      onTimeUpdate={event => {
        const element = event.currentTarget;
        if (element.currentTime >= previewStart.current + 6) element.currentTime = previewStart.current;
      }}
      onError={() => { setPreviewing(false); setPreviewReady(false); }}/>} 
    {duration !== null && <div className="video-duration-badges">
      {category && <span className="video-duration-category" title={category}>{category}</span>}
      <time className="video-duration" dateTime={`PT${duration}S`}>{formatDuration(duration)}</time>
    </div>}
  </div>;
}
