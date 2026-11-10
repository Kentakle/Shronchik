import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import './player-overlay.css';

export function PlayerOverlay({ title, onClose, onDismissStart, children }: {
  title: string;
  onClose: () => void;
  onDismissStart: () => void;
  children: (dismiss: () => void, closing: boolean) => ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef(false);
  const [closing, setClosing] = useState(false);
  const finish = useRef(onClose);
  finish.current = onClose;

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previouslyFocused = document.activeElement;
    element.showModal();
    element.querySelector('video')?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected)
        previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (!closing) return;
    let cancelled = false;
    const animations = dialog.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!cancelled) finish.current();
    });
    return () => { cancelled = true; };
  }, [closing]);

  function dismiss() {
    if (closing) return;
    onDismissStart();
    setClosing(true);
  }

  function onBackdrop(event: PointerEvent<HTMLDialogElement>) {
    const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
    return event.target === event.currentTarget &&
      (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom);
  }

  return <dialog ref={dialog} aria-label={title} className="player-overlay" data-closing={closing || undefined}
    onCancel={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else dismiss();
    }}
    onPointerDown={event => { backdropPointer.current = event.isPrimary && event.button === 0 && onBackdrop(event); }}
    onPointerUp={event => {
      if (backdropPointer.current && onBackdrop(event)) dismiss();
      backdropPointer.current = false;
    }}
    onPointerCancel={() => { backdropPointer.current = false; }}>
    {children(dismiss, closing)}
  </dialog>;
}
