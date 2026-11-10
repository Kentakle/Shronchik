import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { BlobSource, Input, MP4, QTFF, registerDecoder, VideoSampleSink, WEBM } from 'mediabunny';
import type { VideoSample } from 'mediabunny';
import { Vp9UnspecifiedLevelDecoder } from './vp9Decoder';

export type GifResult = { gif: Blob } | { progress: number } | { error: true };

registerDecoder(Vp9UnspecifiedLevelDecoder);

const maxColors = 256;
const paletteSampleSize = 4096;
const paletteFormat = 'rgb565';
// Browsers commonly display GIF delays of 0 or 1 centiseconds as 100 ms.
const minDelay = 2;
const maxDelay = 65_535;
const maxDimension = 65_535;

function indexColors(pixels: Uint8ClampedArray) {
  const pixelCount = pixels.length / 4;
  const indices = new Uint8Array(pixelCount);
  const palette: number[][] = [];
  const byColor = new Map<number, number>();
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const color = (red << 16) | (green << 8) | blue;
    let index = byColor.get(color);
    if (index === undefined) {
      if (palette.length === maxColors) {
        const sampled = samplePalettePixels(pixels, pixelCount);
        const reduced = quantize(sampled, maxColors, { format: paletteFormat });
        return { indices: applyPalette(pixels, reduced, paletteFormat), palette: reduced };
      }
      index = palette.length;
      byColor.set(color, index);
      palette.push([red, green, blue]);
    }
    indices[pixel] = index;
  }
  return { indices, palette };
}

function samplePalettePixels(pixels: Uint8ClampedArray, pixelCount: number) {
  if (pixelCount <= paletteSampleSize) return pixels;
  // Bound palette analysis per frame. Every pixel is still mapped and encoded.
  const sample = new Uint8ClampedArray(paletteSampleSize * 4);
  const stride = pixelCount / paletteSampleSize;
  for (let pixel = 0; pixel < paletteSampleSize; pixel++) {
    const offset = Math.floor((pixel + 0.5) * stride) * 4;
    sample.set(pixels.subarray(offset, offset + 4), pixel * 4);
  }
  return sample;
}

async function encodeVideo(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM] });
  let pending: VideoSample | undefined;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error('Cannot decode video');
    const start = Math.max(0, await input.getFirstTimestamp());
    const duration = await input.computeDuration() - start;
    const total = Math.max(minDelay, Math.round(duration * 100));
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    if (!Number.isSafeInteger(total) || width < 1 || height < 1 || width > maxDimension || height > maxDimension)
      throw new Error('Video dimensions or duration cannot be represented as a GIF');

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('Cannot create GIF canvas');
    context.globalCompositeOperation = 'copy';
    const encoder = GIFEncoder({ auto: false });
    const parts: Blob[] = [];

    const writeFrame = (frame: VideoSample, delay: number) => {
      if (frame.displayWidth !== width || frame.displayHeight !== height)
        throw new Error('Video dimensions change between frames');
      frame.draw(context, 0, 0);
      const pixels = context.getImageData(0, 0, width, height).data;
      const { indices, palette } = indexColors(pixels);
      // GIF stores each frame delay in an unsigned 16-bit field.
      for (let copies = Math.ceil(delay / maxDelay); copies > 0; copies--) {
        const frameDelay = Math.ceil(delay / copies);
        const first = parts.length === 0;
        if (first) encoder.writeHeader();
        encoder.writeFrame(indices, width, height, { first, palette, delay: frameDelay * 10 });
        parts.push(new Blob([encoder.bytesView()]));
        encoder.reset();
        delay -= frameDelay;
      }
    };

    let position = 0;
    let lastProgress = 0;
    for await (const frame of new VideoSampleSink(track).samples(0)) {
      // Round presentation times on the shared timeline to avoid cumulative drift.
      const boundary = Math.min(total - minDelay, Math.round((frame.timestamp - start) * 100));
      if (pending && boundary - position < minDelay) {
        frame.close();
        continue;
      }
      const previous = pending;
      pending = frame;
      if (!previous) continue;
      try {
        writeFrame(previous, boundary - position);
      } finally {
        previous.close();
      }
      position = boundary;
      const progress = Math.floor(position / total * 100);
      if (progress > lastProgress) {
        lastProgress = progress;
        self.postMessage({ progress } satisfies GifResult);
      }
    }
    if (!pending) throw new Error('Video has no frames');
    writeFrame(pending, total - position);
    encoder.finish();
    parts.push(new Blob([encoder.bytesView()]));
    return new Blob(parts, { type: 'image/gif' });
  } finally {
    pending?.close();
    input.dispose();
  }
}

self.onmessage = async ({ data: file }: MessageEvent<File>) => {
  try {
    const gif = await encodeVideo(file);
    self.postMessage({ gif } satisfies GifResult);
  } catch {
    self.postMessage({ error: true } satisfies GifResult);
  }
};
