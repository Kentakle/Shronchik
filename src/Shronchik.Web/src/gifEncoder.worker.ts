import { GIFEncoder, applyPalette, quantize } from 'gifenc';

export type GifFrame = { image: ImageData; delay: number; last: boolean };

const encoder = GIFEncoder();
const format = 'rgb444';

self.onmessage = ({ data: { image, delay, last } }: MessageEvent<GifFrame>) => {
  const { data: pixels, width, height } = image;
  const palette = quantize(pixels, 256, { format });
  encoder.writeFrame(applyPalette(pixels, palette, format), width, height, { palette, delay });
  if (last) {
    encoder.finish();
    self.postMessage(new Blob([encoder.bytesView()], { type: 'image/gif' }));
  } else {
    self.postMessage(null);
  }
};
