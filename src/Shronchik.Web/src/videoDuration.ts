export function videoDurationCategory(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds <= 30) return 'ultra short';
  if (seconds <= 180) return 'short';
  if (seconds <= 600) return 'medium';
  // Durations between 25 and 40 minutes stay long until ultra long begins.
  if (seconds < 2400) return 'long';
  return 'ultra long';
}

export function formatDuration(seconds: number) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}
