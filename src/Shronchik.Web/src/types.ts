export type MediaType = 'video' | 'photo' | 'gif';
export type Role = 'Admin' | 'User';
export type Language = 'ru' | 'en';
export type Session = {
  authenticated: boolean;
  locked: boolean;
  role: Role | null;
  accountId: string | null;
  csrfToken: string | null;
  weakPassword: boolean;
  mustChangePassword: boolean;
  canUpload: boolean;
  publicOrigin?: string | null;
};
export type ManagedAccount = {
  username: string;
  role: Role;
  enabled: boolean;
  canUpload: boolean;
  mustChangePassword: boolean;
  pendingDeletion?: boolean;
};
export type Hotkeys = {
  playPause: string;
  seekBackward: string;
  seekForward: string;
  volumeUp: string;
  volumeDown: string;
  toggleFullscreen: string;
  exitFullscreen: string;
  toggleMute: string;
  toggleFilters: string;
  goHome: string;
  lock: string;
  nextMedia: string;
  previousMedia: string;
};
export type Settings = {
  schemaVersion: number;
  language: Language;
  gridColumns: number;
  animationMs: number;
  afkMinutes: number;
  accentColor: string;
  theme: 'custom_dark' | 'midnight' | 'light';
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  mutedTextColor: string;
  shadowStrength: number;
  hoverNeighborDim: number;
  cardRadiusPx: number;
  reduceMotion: 'auto' | 'on' | 'off';
  gridGapPx: number;
  cardAspectRatio: '16:9' | '4:3' | '1:1';
  cardTitleLines: number;
  sidebarExpanded: boolean;
  showSkeletons: boolean;
  fontScale: number;
  volume: number;
  seekSeconds: number;
  hoverDelayMs: number;
  thumbnailCandidates: number;
  gifVisibilityMarginPx: number;
  maxAnimatedCards: number;
  gpuDecodePreference: 'auto' | 'on' | 'off';
  ramCacheMB: number;
  showRelatedBelow: boolean;
  ratedPercent: number;
  minimumRating: number;
  ratingWeight: number;
  relatedCount: number;
  randomRelatedCount: number;
  queryDebounceMs: number;
  pageBatchSize: number;
  trashRetentionDays: number;
  verifyOnStartup: 'quick' | 'full';
  backupReminderDays: number;
  workerConcurrency: number;
  maxTranscodes: number;
  pauseOnBattery: boolean;
  ffmpegThreads: number;
  lowDiskWarningGB: number;
  hotkeys: Hotkeys;
};
export type Media = {
  id: string;
  type: MediaType;
  title: string;
  description: string;
  rating: number | null;
  userRating: number | null;
  ratingCount: number;
  views: number;
  isFavorite: boolean;
  size: number;
  createdAt: string;
  tags: string[];
  mimeType: string;
  posterVersion?: string | null;
};
export type MediaPage = { items: Media[]; nextCursor: string | null; hasMore: boolean };
export type ImportedMedia = Media & { importToken?: string };
export type Home = {
  totalCount: number;
  totalBytes: number;
  categories: { type: MediaType; count: number; totalBytes: number }[];
};
export const defaultHotkeys: Hotkeys = {
  playPause: 'Space', seekBackward: 'ArrowLeft', seekForward: 'ArrowRight',
  volumeUp: 'ArrowUp', volumeDown: 'ArrowDown', toggleFullscreen: 'F',
  exitFullscreen: 'Escape', toggleMute: 'M', toggleFilters: 'Ctrl+F', goHome: 'Alt+Home',
  lock: 'Ctrl+Shift+L', nextMedia: 'Alt+ArrowRight', previousMedia: 'Alt+ArrowLeft',
};
export const defaultSettings: Settings = {
  schemaVersion: 2, language: 'ru', gridColumns: 10, animationMs: 300, afkMinutes: 5, accentColor: '#B9A1EF',
  theme: 'custom_dark', backgroundColor: '#111116', surfaceColor: '#1A1A22', textColor: '#F4F3F7', mutedTextColor: '#A4A0AF',
  shadowStrength: .35, hoverNeighborDim: .18, cardRadiusPx: 14, reduceMotion: 'auto',
  gridGapPx: 12, cardAspectRatio: '16:9', cardTitleLines: 2, sidebarExpanded: false, showSkeletons: true, fontScale: 1,
  volume: .7, seekSeconds: 5, hoverDelayMs: 300, thumbnailCandidates: 5, gifVisibilityMarginPx: 80,
  maxAnimatedCards: 12, gpuDecodePreference: 'auto', ramCacheMB: 512, showRelatedBelow: true,
  ratedPercent: 70, minimumRating: 7000, ratingWeight: .6, relatedCount: 3, randomRelatedCount: 2,
  queryDebounceMs: 200, pageBatchSize: 60, trashRetentionDays: 30, verifyOnStartup: 'quick',
  backupReminderDays: 7, workerConcurrency: 2, maxTranscodes: 1, pauseOnBattery: false,
  ffmpegThreads: 0, lowDiskWarningGB: 5, hotkeys: defaultHotkeys,
};
export const guestSession: Session = {
  authenticated: false, locked: false, role: null, accountId: null, csrfToken: null, weakPassword: false, mustChangePassword: false, canUpload: false,
};
