import { reportSessionStatus } from './api';
import { extractVideoPoster, readVideoDuration } from './videoPoster';
import { AsyncQueue } from './asyncQueue';

export type ThumbnailKind = 'image' | 'frame';
export type CachedThumbnail = { url: string; bytes: number; users: number; duration: number | null };
const images = new Map<string, CachedThumbnail>();
const pending = new Map<string, Promise<CachedThumbnail>>();
const durations = new Map<string, number | null>();
const pendingDurations = new Map<string, Promise<number | null>>();
const waitingFrames = new Set<() => void>();
const waitingMetadata = new Set<() => void>();
let activeFrames = 0;
let session: AbortController | null = null;
let bytes = 0;
let byteLimit = 512 * 1024 * 1024;
const entryLimit = 512;
const durationLimit = 4096;
const imageQueue = new AsyncQueue(6);
const maxImageBytes = 8 * 1024 * 1024;

function prune(keep?: CachedThumbnail) {
  for (const [key, image] of images) {
    if (bytes <= byteLimit && images.size <= entryLimit) break;
    if (image.users || image === keep) continue;
    URL.revokeObjectURL(image.url);
    images.delete(key);
    bytes -= image.bytes;
  }
}

export function setThumbnailBudget(megabytes: number) {
  byteLimit = megabytes * 1024 * 1024;
  prune();
}

export function clearThumbnailCache() {
  session?.abort();
  session = null;
  pending.clear();
  durations.clear();
  pendingDurations.clear();
  waitingFrames.clear();
  waitingMetadata.clear();
  for (const image of images.values()) URL.revokeObjectURL(image.url);
  images.clear();
  bytes = 0;
}

export function openThumbnailCache() {
  session ??= new AbortController();
}

function cacheKey(source: string, kind: ThumbnailKind) {
  return kind + ':' + source;
}

export function findThumbnail(source: string, kind: ThumbnailKind) {
  const key = cacheKey(source, kind);
  const image = images.get(key);
  if (image) {
    images.delete(key);
    images.set(key, image);
  }
  return image;
}

export function releaseThumbnail(image: CachedThumbnail) {
  image.users--;
  prune();
}

export function findVideoDuration(source: string) {
  const duration = durations.get(source);
  if (duration !== undefined) {
    durations.delete(source);
    durations.set(source, duration);
  }
  return duration;
}

function rememberVideoDuration(source: string, duration: number | null, signal: AbortSignal) {
  if (signal.aborted) return;
  if (duration === null && typeof durations.get(source) === 'number') return;
  durations.delete(source);
  durations.set(source, duration);
  if (durations.size > durationLimit) {
    const oldest = durations.keys().next().value;
    if (oldest !== undefined) durations.delete(oldest);
  }
}

export function loadVideoDuration(source: string) {
  if (!session) return Promise.reject(new Error('Library locked'));
  const ready = findVideoDuration(source);
  if (ready !== undefined) return Promise.resolve(ready);
  const existing = pendingDurations.get(source);
  if (existing) return existing;
  const signal = session.signal;
  const result = readVideoDuration(source, { signal })
    .then(duration => {
      signal.throwIfAborted();
      rememberVideoDuration(source, duration, signal);
      return findVideoDuration(source) ?? null;
    })
    .finally(() => { if (pendingDurations.get(source) === result) pendingDurations.delete(source); });
  pendingDurations.set(source, result);
  return result;
}

async function fetchImage(source: string, signal: AbortSignal) {
  const response = await fetch(source, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) {
    reportSessionStatus(response.status);
    throw new Error('Thumbnail unavailable');
  }
  const type = response.headers.get('content-type')?.split(';')[0] ?? '';
  const length = Number(response.headers.get('content-length'));
  if (!type.startsWith('image/') || length > maxImageBytes || !response.body) {
    await response.body?.cancel();
    throw new Error('Invalid thumbnail');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxImageBytes) {
        await reader.cancel();
        throw new Error('Thumbnail is too large');
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('Invalid thumbnail');
  return new Blob(parts, { type });
}

export function loadThumbnail(source: string, kind: ThumbnailKind) {
  if (!session) return Promise.reject(new Error('Library locked'));
  const ready = findThumbnail(source, kind);
  if (ready) return Promise.resolve(ready);
  const key = cacheKey(source, kind);
  const existing = pending.get(key);
  if (existing) return existing;

  const signal = session.signal;
  const result = (kind === 'frame'
    ? extractVideoPoster(source, {
      signal,
      timeoutMs: 12000,
      onDuration: duration => rememberVideoDuration(source, duration, signal),
    })
    : imageQueue.run(() => fetchImage(source, signal), signal))
    .then(blob => {
      signal.throwIfAborted();
      const duration = kind === 'frame' ? findVideoDuration(source) ?? null : null;
      const image = { url: URL.createObjectURL(blob), bytes: blob.size, users: 0, duration };
      images.set(key, image);
      bytes += image.bytes;
      prune(image);
      return image;
    })
    .finally(() => { if (pending.get(key) === result) pending.delete(key); });
  pending.set(key, result);
  return result;
}

function startFrame() {
  if (activeFrames >= 2) return;
  const queue = waitingFrames.size ? waitingFrames : waitingMetadata;
  const job = queue.values().next().value;
  if (!job) return;
  queue.delete(job);
  job();
}

export function queueFrame(load: () => Promise<void>, priority: 'frame' | 'metadata' = 'frame') {
  const job = () => {
    activeFrames++;
    void load().finally(() => { activeFrames--; startFrame(); });
  };
  const queue = priority === 'frame' ? waitingFrames : waitingMetadata;
  queue.add(job);
  startFrame();
  return () => { queue.delete(job); };
}
