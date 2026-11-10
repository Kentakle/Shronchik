declare module 'gifenc' {
  type Palette = number[][];
  type PaletteFormat = 'rgb444' | 'rgb565' | 'rgba4444';

  export function quantize(pixels: Uint8ClampedArray, maxColors: number, options: { format: PaletteFormat }): Palette;
  export function applyPalette(pixels: Uint8ClampedArray, palette: Palette, format: PaletteFormat): Uint8Array;
  export function GIFEncoder(options: { auto: boolean }): {
    writeHeader(): void;
    writeFrame(indices: Uint8Array, width: number, height: number, options: { first: boolean; palette: Palette; delay: number }): void;
    reset(): void;
    finish(): void;
    bytesView(): Uint8Array<ArrayBuffer>;
  };
}
