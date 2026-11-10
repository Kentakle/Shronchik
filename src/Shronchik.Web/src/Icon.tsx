export type IconName = 'lock' | 'unlock' | 'settings' | 'video' | 'photo' | 'gif' | 'heart' | 'search' | 'arrow' | 'back' | 'plus' | 'close' | 'menu' | 'shield' | 'grid' | 'history' | 'album' | 'trash' | 'logout' | 'check' | 'refresh' | 'star' | 'play' | 'upload' | 'chevron' | 'eye' | 'user' | 'link';
const paths: Record<IconName, React.ReactNode> = {
  lock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 7.7-1.5M12 14v3"/></>,
  settings: <><path d="m9.5 3-.7 2.2-2 .9-2.1-.6-2.5 4.3 1.5 1.7v2.3l-1.5 1.7 2.5 4.3 2.2-.4 1.9 1 .7 2.1h5l.7-2.2 2-.9 2.1.5 2.5-4.3-1.5-1.7v-2.3l1.5-1.7-2.5-4.3-2.2.4-1.9-1L14.5 3z"/><circle cx="12" cy="12.5" r="3"/></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></>,
  photo: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/></>,
  gif: <><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m10 8 6 4-6 4zM6 8v8"/></>,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>,
  search: <><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, back: <path d="M20 12H4m6-6-6 6 6 6"/>,
  plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M6 18 18 6"/>, menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  shield: <><path d="M12 3 3.5 6v6c0 5 8.5 9 8.5 9s8.5-4 8.5-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  history: <><path d="M3 10a9 9 0 1 1 1.2 7M3 4v6h6"/><path d="M12 7v5l3 2"/></>,
  album: <><rect x="5" y="6" width="16" height="15" rx="3"/><path d="M3 17V5a2 2 0 0 1 2-2h12M9 11h8M9 15h5"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
  logout: <><path d="M9 3H4v18h5M13 7l5 5-5 5M8 12h13"/></>, check: <path d="m5 12 4 4L19 6"/>,
  refresh: <><path d="M20 9a8 8 0 0 0-14-4L3 8m0-5v5h5M4 15a8 8 0 0 0 14 4l3-3m0 5v-5h-5"/></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>,
  play: <path d="m8 4 12 8-12 8z"/>, upload: <><path d="M4 16v5h16v-5M12 16V3m-5 5 5-5 5 5"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>, eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  link: <path d="m10 13 4-4m-6 1-3 3a4.2 4.2 0 0 0 6 6l3-3m-4-8 3-3a4.2 4.2 0 0 1 6 6l-3 3"/>,
};
export function Icon({ name, size = 20, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
