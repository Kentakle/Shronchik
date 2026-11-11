import type { MediaType } from './types';

const videoFormats = { extensions: ['.mp4', '.m4v', '.mov', '.webm'], label: 'MP4 · M4V · MOV · WebM' };

export const importFormats = {
  photo: { extensions: ['.png', '.jpg', '.jpeg', '.webp'], label: 'PNG · JPEG · WebP' },
  video: videoFormats,
  gif: { extensions: ['.gif', ...videoFormats.extensions], label: `GIF · ${videoFormats.label}` },
} satisfies Record<MediaType, { extensions: string[]; label: string }>;

export function acceptsImportFile(file: File, type: MediaType) {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return importFormats[type].extensions.includes(extension);
}
