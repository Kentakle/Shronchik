export type SourceDirectory = FileSystemDirectoryHandle;

export type PreparedSource = {
  file: File;
  handle: FileSystemFileHandle;
  directory: SourceDirectory;
};

export class SourceDeletionError extends Error {
  constructor(public readonly code: 'source_changed' | 'source_cancelled') {
    super(code);
    this.name = 'SourceDeletionError';
  }
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { id: string; mode: 'readwrite' }) => Promise<SourceDirectory>;
};

const compareChunkBytes = 1024 * 1024;

export function supportsSourceDeletion(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext
    && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

export async function pickSourceDirectory(): Promise<SourceDirectory> {
  if (!supportsSourceDeletion()) throw new DOMException('Source deletion is unavailable.', 'NotSupportedError');
  const pickerWindow = window as DirectoryPickerWindow;
  return pickerWindow.showDirectoryPicker!({ id: 'shronchik-import-source', mode: 'readwrite' });
}

function checkCancellation(isCancelled: () => boolean): void {
  if (isCancelled()) throw new SourceDeletionError('source_cancelled');
}

function sameMetadata(left: File, right: File): boolean {
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
}

async function compareFiles(left: File, right: File, isCancelled: () => boolean): Promise<void> {
  checkCancellation(isCancelled);
  if (!sameMetadata(left, right)) throw new SourceDeletionError('source_changed');
  // Compare bounded slices, including large videos, without retaining either full file in memory.
  for (let offset = 0; offset < left.size; offset += compareChunkBytes) {
    checkCancellation(isCancelled);
    const end = Math.min(offset + compareChunkBytes, left.size);
    const [leftBuffer, rightBuffer] = await Promise.all([
      left.slice(offset, end).arrayBuffer(),
      right.slice(offset, end).arrayBuffer(),
    ]);
    checkCancellation(isCancelled);
    const leftBytes = new Uint8Array(leftBuffer);
    const rightBytes = new Uint8Array(rightBuffer);
    if (leftBytes.length !== end - offset || rightBytes.length !== leftBytes.length)
      throw new SourceDeletionError('source_changed');
    for (let index = 0; index < leftBytes.length; index++) {
      if (leftBytes[index] !== rightBytes[index]) throw new SourceDeletionError('source_changed');
    }
  }
  checkCancellation(isCancelled);
}

export async function prepareSource(
  file: File, directory: SourceDirectory, isCancelled: () => boolean,
): Promise<PreparedSource> {
  checkCancellation(isCancelled);
  // Only a directly selected child is eligible; never search by name outside this directory.
  const handle = await directory.getFileHandle(file.name);
  checkCancellation(isCancelled);
  const candidate = await handle.getFile();
  await compareFiles(file, candidate, isCancelled);
  return { file: candidate, handle, directory };
}

export async function deleteImportedSource(
  prepared: PreparedSource, isCancelled: () => boolean,
): Promise<boolean> {
  try {
    checkCancellation(isCancelled);
    const currentHandle = await prepared.directory.getFileHandle(prepared.file.name);
    checkCancellation(isCancelled);
    const sameEntry = await currentHandle.isSameEntry(prepared.handle);
    checkCancellation(isCancelled);
    if (!sameEntry) throw new SourceDeletionError('source_changed');
    const currentFile = await currentHandle.getFile();
    await compareFiles(prepared.file, currentFile, isCancelled);
    checkCancellation(isCancelled);
    await prepared.directory.removeEntry(prepared.file.name);
    return true;
  } catch (error) {
    if (error instanceof SourceDeletionError && error.code === 'source_cancelled') return false;
    throw error;
  }
}
