import type { MouseEvent } from 'react';
import type { Media, MediaType } from './types';

const routePattern = /^\/(photo|video|gif)(?:\/([^/]+))?\/?$/;

export function readLocation() {
  const path = window.location.pathname;
  const match = routePattern.exec(path);
  const mediaType = (match?.[1] as MediaType | undefined) ?? null;
  const mediaId = match?.[2] ?? null;
  // An album can open a file from another section while keeping the album behind the viewer.
  const source: unknown = window.history.state?.galleryPath;
  const galleryPath = mediaId && typeof source === 'string' ? source : null;
  const galleryMatch = galleryPath ? routePattern.exec(galleryPath) : null;
  const galleryType = galleryMatch?.[1] as MediaType | undefined;
  return { path, mediaType, mediaId, galleryPath, category: galleryType ?? mediaType };
}

export function mediaPath(media: Pick<Media, 'type' | 'id'>) {
  return `/${media.type}/${encodeURIComponent(media.id)}`;
}

export function followLink(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}
