import type { GifFrame } from './gifEncoder.worker';
import { finiteDuration, waitForMediaEvent } from './videoPoster';

export const maxGifSeconds = 10;
export const maxGifSide = 480;
const frameDelayMs = 100;

export class GifStartError extends Error {}

function encodeFrame(worker: Worker, frame: GifFrame, signal: AbortSignal) {
  signal.throwIfAborted();
  const listeners = new AbortController();
  const options = { once: true, signal: listeners.signal };
  return new Promise<Blob | null>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<Blob | null>) => resolve(event.data), options);
    worker.addEventListener('error', reject, options);
    signal.addEventListener('abort', () => reject(signal.reason), options);
    worker.postMessage(frame, [frame.image.data.buffer]);
  }).finally(() => listeners.abort());
}

export async function videoToGif(file: File, { start, seconds, signal: cancel, onProgress }: {
  start: number; seconds: number; signal: AbortSignal; onProgress: (value: number) => void;
}) {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(120_000)]);
  const video = document.createElement('video');
  video.preload = 'auto';
  const source = URL.createObjectURL(file);
  let worker: Worker | undefined;
  try {
    await waitForMediaEvent(video, 'loadedmetadata', signal, () => { video.src = source; });
    const duration = finiteDuration(video);
    if (duration === null || !video.videoWidth || !video.videoHeight) throw new Error('Cannot decode video');
    if (!Number.isFinite(start) || start < 0 || start >= duration) throw new GifStartError();
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid GIF duration');
    const length = Math.min(seconds, maxGifSeconds, duration - start);
    const lengthMs = Math.max(20, Math.round(length * 100) * 10);
    const frameCount = Math.ceil(lengthMs / frameDelayMs);

    const scale = Math.min(1, maxGifSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    const width = canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('Cannot create GIF canvas');

    for (let index = 0; index < frameCount; index++) {
      const offset = index * frameDelayMs;
      const delay = Math.min(frameDelayMs, lengthMs - offset);
      const time = start + (offset + delay / 2) / lengthMs * length;
      await waitForMediaEvent(video, 'seeked', signal, () => { video.currentTime = time; });
      context.drawImage(video, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      worker ??= new Worker(new URL('./gifEncoder.worker.ts', import.meta.url), { type: 'module' });
      const gif = await encodeFrame(worker, { image, delay: Math.max(20, delay), last: index === frameCount - 1 }, signal);
      onProgress(Math.round((index + 1) / frameCount * 100));
      if (gif) return new File([gif], file.name.replace(/\.[^.]+$/, '') + '.gif', { type: gif.type });
    }
    throw new Error('GIF encoder returned no file');
  } finally {
    worker?.terminate();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(source);
  }
}
