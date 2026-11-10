import type { GifResult } from './gifEncoder.worker';

export async function videoToGif(file: File, { signal, onProgress }: {
  signal: AbortSignal; onProgress: (value: number) => void;
}) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./gifEncoder.worker.ts', import.meta.url), { type: 'module' });
  const listeners = new AbortController();
  return new Promise<File>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<GifResult>) => {
      if ('progress' in data) onProgress(data.progress);
      else if ('gif' in data) resolve(new File([data.gif], file.name.replace(/\.[^.]+$/, '') + '.gif', { type: data.gif.type }));
      else reject(new Error('GIF conversion failed'));
    };
    worker.onerror = reject;
    worker.onmessageerror = reject;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true, signal: listeners.signal });
    worker.postMessage(file);
  }).finally(() => {
    listeners.abort();
    worker.terminate();
  });
}
