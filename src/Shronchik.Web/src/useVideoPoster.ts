import { useState } from 'react';
import type { RefObject } from 'react';
import { posterUrl, streamUrl } from './api';
import { useThumbnail } from './useThumbnail';

export function useVideoPoster(id: string, version: string | null | undefined, target: RefObject<Element | null>) {
  const [failed, setFailed] = useState('');
  const stream = id ? streamUrl(id) : '';
  const saved = id && version ? posterUrl(id, version) : '';
  const stored = saved !== failed ? saved : '';
  const poster = useThumbnail(stored, 'image', target);
  const frame = useThumbnail(!stored || poster?.error ? stream : '', 'frame', target);

  return {
    url: poster?.url || frame?.url,
    duration: frame?.duration ?? null,
    needsDuration: Boolean(poster?.url || frame?.error),
    onError: poster?.url ? () => setFailed(stored) : undefined,
  };
}
