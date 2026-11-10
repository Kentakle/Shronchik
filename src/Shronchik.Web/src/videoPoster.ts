export type VideoPosterFrame = { time: number; blob: Blob };
type CaptureOptions = { signal?: AbortSignal; timeoutMs?: number; onDuration?: (seconds: number | null) => void };

const maxSide = 960;
const maxPosterBytes = 1024 * 1024;

function operationSignal({ signal, timeoutMs }: CaptureOptions, defaultTimeout: number) {
  const timeout = AbortSignal.timeout(timeoutMs ?? defaultTimeout);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function waitForMediaEvent(target: HTMLVideoElement | HTMLImageElement, event: string, signal: AbortSignal, start: () => void) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Cannot decode media')); };
    const abort = () => { cleanup(); reject(signal.reason); };
    function cleanup() {
      target.removeEventListener(event, ready);
      target.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
    }
    target.addEventListener(event, ready);
    target.addEventListener('error', fail);
    signal.addEventListener('abort', abort);
    try { start(); }
    catch (error) { cleanup(); reject(error); }
  });
}

export function finiteDuration(video: HTMLVideoElement) {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
}

export async function readVideoDuration(source: string, options: CaptureOptions = {}) {
  const signal = operationSignal(options, 8_000);
  const video = document.createElement('video');
  video.preload = 'metadata';
  try {
    await waitForMediaEvent(video, 'loadedmetadata', signal, () => { video.src = source; });
    return finiteDuration(video);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function drawPoster(source: CanvasImageSource, width: number, height: number) {
  if (!width || !height) throw new Error('Media has no image dimensions');
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Cannot create a poster canvas');
  context.fillStyle = '#18181f';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function encodeJpeg(canvas: HTMLCanvasElement, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<Blob>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    canvas.toBlob(blob => {
      signal.removeEventListener('abort', abort);
      if (blob && blob.type === 'image/jpeg' && blob.size <= maxPosterBytes) resolve(blob);
      else reject(new Error('Cannot encode the poster'));
    }, 'image/jpeg', 0.83);
  });
}

function isBlackFrame(canvas: HTMLCanvasElement, probe: CanvasRenderingContext2D) {
  const { width, height } = probe.canvas;
  probe.drawImage(canvas, 0, 0, width, height);
  const pixels = probe.getImageData(0, 0, width, height).data;
  let visiblePixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 24) visiblePixels++;
  }
  return visiblePixels < width * height * 0.035;
}

export async function extractVideoFrames(source: string, count: number, options: CaptureOptions = {}): Promise<VideoPosterFrame[]> {
  const signal = operationSignal(options, 25_000);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 24;
  probeCanvas.height = 14;
  const probe = probeCanvas.getContext('2d', { willReadFrequently: true });
  const frames: VideoPosterFrame[] = [];
  let darkFallback: VideoPosterFrame | undefined;

  try {
    await waitForMediaEvent(video, 'loadedmetadata', signal, () => { video.src = source; });
    const duration = finiteDuration(video);
    options.onDuration?.(duration);
    if (duration === null) {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await waitForMediaEvent(video, 'loadeddata', signal, () => { video.preload = 'auto'; });
        options.onDuration?.(finiteDuration(video));
      }
      const canvas = drawPoster(video, video.videoWidth, video.videoHeight);
      return [{ time: video.currentTime, blob: await encodeJpeg(canvas, signal) }];
    }

    const limit = Math.max(1, Math.min(12, Math.round(count)));
    const samplePositions = limit === 1 ? [0.15, 0.5, 0.8] : Array.from({ length: limit }, (_, index) => (index + 0.5) / limit);
    for (const position of samplePositions) {
      const time = duration * position;
      await waitForMediaEvent(video, 'seeked', signal, () => { video.currentTime = time; });
      const canvas = drawPoster(video, video.videoWidth, video.videoHeight);
      if (probe && isBlackFrame(canvas, probe)) {
        darkFallback ??= { time, blob: await encodeJpeg(canvas, signal) };
        continue;
      }
      frames.push({ time, blob: await encodeJpeg(canvas, signal) });
      if (frames.length === limit) break;
    }
  } catch (error) {
    if (options.signal?.aborted || (!frames.length && !darkFallback)) throw error;
  } finally {
    video.removeAttribute('src');
    video.load();
  }

  if (frames.length) return frames;
  if (darkFallback) return [darkFallback];
  throw new Error('No video frames could be captured');
}

export async function extractVideoPoster(source: string, options: CaptureOptions = {}) {
  const [frame] = await extractVideoFrames(source, 1, { timeoutMs: 8_000, ...options });
  return frame.blob;
}

export async function prepareCustomPoster(file: File, options: CaptureOptions = {}) {
  const isImage = file.type ? ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) : /\.(?:jpe?g|png|webp)$/i.test(file.name);
  if (!isImage || file.size > 20 * 1024 * 1024 || !file.size) throw new Error('Unsupported poster image');
  const signal = operationSignal(options, 10_000);
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await waitForMediaEvent(image, 'load', signal, () => { image.src = url; });
    return await encodeJpeg(drawPoster(image, image.naturalWidth, image.naturalHeight), signal);
  } finally {
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}
