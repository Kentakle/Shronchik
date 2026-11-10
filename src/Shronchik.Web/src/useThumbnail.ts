import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import { findThumbnail, loadThumbnail, queueFrame, releaseThumbnail } from './thumbnailCache';
import type { CachedThumbnail, ThumbnailKind } from './thumbnailCache';

export function useThumbnail(source: string, kind: ThumbnailKind, target: RefObject<Element | null>) {
  const [result, setResult] = useState<{ source: string; url: string; error: boolean; duration: number | null } | null>(null);

  useLayoutEffect(() => {
    if (!source || !target.current) return;
    let cancelled = false;
    let current: CachedThumbnail | undefined;
    let cancelWaiting: (() => void) | undefined;

    function useImage(image: CachedThumbnail) {
      current = image;
      image.users++;
      setResult({ source, url: image.url, error: false, duration: image.duration });
    }
    async function load() {
      try {
        const image = await loadThumbnail(source, kind);
        if (!cancelled) useImage(image);
      } catch {
        if (!cancelled) setResult({ source, url: '', error: true, duration: null });
      }
    }

    const cached = findThumbnail(source, kind);
    const observer = cached ? undefined : new IntersectionObserver(entries => {
      if (cancelled || !entries.some(entry => entry.isIntersecting)) return;
      observer?.disconnect();
      if (kind === 'frame') cancelWaiting = queueFrame(load);
      else void load();
    }, { rootMargin: '220px' });

    if (cached) useImage(cached);
    else {
      setResult(null);
      observer?.observe(target.current);
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      cancelWaiting?.();
      if (current) releaseThumbnail(current);
    };
  }, [source, kind, target]);

  return result?.source === source ? result : null;
}
