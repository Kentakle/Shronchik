import type { MediaType } from './types';

export const importFormats = {
  photo: { extensions: ['.png', '.jpg', '.jpeg', '.webp'], label: 'PNG · JPEG · WebP' },
  video: { extensions: ['.mp4', '.m4v', '.mov', '.webm'], label: 'MP4 · M4V · MOV · WebM' },
  gif: { extensions: ['.gif'], label: 'GIF' },
} satisfies Record<MediaType, { extensions: string[]; label: string }>;

export function acceptsImportFile(file: File, type: MediaType) {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return importFormats[type].extensions.includes(extension);
}
