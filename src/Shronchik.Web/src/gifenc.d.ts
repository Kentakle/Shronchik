declare module 'gifenc' {
  type Palette = number[][];
  type PaletteFormat = 'rgb444' | 'rgb565' | 'rgba4444';

  export function quantize(pixels: Uint8ClampedArray, maxColors: number, options: { format: PaletteFormat }): Palette;
  export function applyPalette(pixels: Uint8ClampedArray, palette: Palette, format: PaletteFormat): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(indices: Uint8Array, width: number, height: number, options: { palette: Palette; delay: number }): void;
    finish(): void;
    bytesView(): Uint8Array<ArrayBuffer>;
  };
}
