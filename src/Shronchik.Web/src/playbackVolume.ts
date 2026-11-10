type PlaybackVolume = { volume: number; muted: boolean };

const key = (accountId: string) => `shronchik:playback-volume:${encodeURIComponent(accountId)}`;

export function readPlaybackVolume(accountId: string, defaultVolume: number): PlaybackVolume {
  const fallback = { volume: defaultVolume, muted: false };
  if (!accountId) return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(key(accountId)) ?? 'null');
    // An explicit change to the initial volume in Settings takes precedence.
    if (saved?.defaultVolume !== defaultVolume || typeof saved.volume !== 'number' ||
      !Number.isFinite(saved.volume) || saved.volume < 0 || saved.volume > 1 || typeof saved.muted !== 'boolean') return fallback;
    return { volume: saved.volume, muted: saved.muted };
  } catch { return fallback; }
}

export function savePlaybackVolume(accountId: string, defaultVolume: number, value: PlaybackVolume) {
  if (!accountId || !Number.isFinite(value.volume)) return;
  try { localStorage.setItem(key(accountId), JSON.stringify({ ...value, defaultVolume })); }
  catch { /* Playback still works when browser storage is unavailable. */ }
}
