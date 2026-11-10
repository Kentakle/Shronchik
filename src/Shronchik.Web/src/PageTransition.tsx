import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Settings } from './types';
import './page-transition.css';

export function PageTransition({ pageKey, settings, children }: {
  pageKey: string; settings: Settings; children: ReactNode;
}) {
  const [visibleKey, setVisibleKey] = useState(pageKey);
  const [systemReduceMotion, setSystemReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const visibleContent = useRef(children);
  const leaving = visibleKey !== pageKey;
  const reduceMotion = settings.reduceMotion === 'on' || settings.reduceMotion === 'auto' && systemReduceMotion;
  const duration = reduceMotion ? 0 : settings.animationMs / 2;

  if (!leaving) visibleContent.current = children;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReduceMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    if (!leaving) return;
    if (duration === 0) { setVisibleKey(pageKey); return; }
    const timeout = window.setTimeout(() => setVisibleKey(pageKey), duration);
    return () => window.clearTimeout(timeout);
  }, [duration, leaving, pageKey]);

  useLayoutEffect(() => { window.scrollTo(0, 0); }, [visibleKey]);

  return <div key={visibleKey} className="page-transition" data-state={leaving ? 'leaving' : 'entering'}
    inert={leaving} style={{ '--page-transition-duration': `${duration}ms` } as CSSProperties}>
    {visibleContent.current}
  </div>;
}
