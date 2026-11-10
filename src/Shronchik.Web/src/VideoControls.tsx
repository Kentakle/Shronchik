import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, RefObject } from 'react';
import type { Language } from './types';
import './video-controls.css';

export function formatVideoTime(seconds: number) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(value / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    : `${minutes}:${String(value % 60).padStart(2, '0')}`;
}

export function toggleVideoFullscreen(stage: HTMLElement | null) {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else if (stage) void stage.requestFullscreen().catch(() => {});
}

export function VideoControls({ video, stage, previewSource, language, disabled, onPlayError }: {
  video: RefObject<HTMLVideoElement | null>; stage: RefObject<HTMLDivElement | null>;
  previewSource: string; language: Language; disabled: boolean; onPlayError: () => void;
}) {
  const text = (ru: string, en: string) => language === 'ru' ? ru : en;
  const [state, setState] = useState({ time: 0, duration: 0, playing: false, volume: 1, muted: false });
  const [hover, setHover] = useState<{ time: number; fraction: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const timeline = useRef<HTMLDivElement>(null);
  const [previewWidth, setPreviewWidth] = useState(192);
  useEffect(() => {
    const area = stage.current;
    const track = timeline.current;
    if (!area || !track) return;
    const measure = () => {
      const fontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const trackRect = track.getBoundingClientRect();
      // Include the timestamp, border and gap so the complete tooltip fits above the track.
      const imageHeight = trackRect.top - area.getBoundingClientRect().top - 2.08 * fontSize - 10;
      setPreviewWidth(Math.min(12 * fontSize, trackRect.width, Math.max(36, imageHeight * 16 / 9)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area); observer.observe(track);
    measure();
    return () => observer.disconnect();
  }, [stage]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    function update() {
      if (!element) return;
      setState({ time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : 0,
        playing: !element.paused && !element.ended, volume: element.volume, muted: element.muted });
    }
    const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'volumechange'];
    events.forEach(event => element.addEventListener(event, update));
    update();
    return () => events.forEach(event => element.removeEventListener(event, update));
  }, [video]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => { if (disabled) setHover(null); }, [disabled]);
  function preview(event: PointerEvent<HTMLInputElement>) {
    if (disabled || !state.duration || event.pointerType === 'touch') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setHover({ time: fraction * state.duration, fraction });
  }
  function togglePlay() {
    const element = video.current;
    if (!element || disabled) return;
    if (element.paused) void element.play().catch(onPlayError);
    else element.pause();
  }
  return <div className="video-controls" data-playing={state.playing || undefined}>
    <div className="video-timeline" ref={timeline}>
      {hover && <TimelinePreview source={previewSource} time={hover.time} fraction={hover.fraction} width={previewWidth} language={language}/>}
      <input className="video-seek" type="range" min={0} max={state.duration || 1} step={0.1}
        value={Math.min(state.time, state.duration)} disabled={disabled || !state.duration}
        aria-label={text('Позиция видео', 'Video position')}
        aria-valuetext={`${formatVideoTime(state.time)} / ${formatVideoTime(state.duration)}`}
        style={{ '--seek-progress': `${state.duration ? state.time / state.duration * 100 : 0}%` } as CSSProperties}
        onChange={event => { if (video.current) video.current.currentTime = Number(event.target.value); }}
        onPointerEnter={preview} onPointerMove={preview} onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)} onBlur={() => setHover(null)}/>
    </div>
    <div className="video-control-row">
      <button type="button" className="video-control-button" disabled={disabled} onClick={togglePlay}
        aria-label={state.playing ? text('Пауза', 'Pause') : text('Воспроизвести', 'Play')}>
        <ControlIcon kind={state.playing ? 'pause' : 'play'}/>
      </button>
      <button type="button" className="video-control-button" disabled={disabled}
        onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}
        aria-label={state.muted ? text('Включить звук', 'Unmute') : text('Выключить звук', 'Mute')}>
        <ControlIcon kind={state.muted || state.volume === 0 ? 'muted' : 'volume'}/>
      </button>
      <input className="video-volume" type="range" min={0} max={1} step={0.01} value={state.muted ? 0 : state.volume}
        disabled={disabled} aria-label={text('Громкость', 'Volume')}
        aria-valuetext={`${Math.round((state.muted ? 0 : state.volume) * 100)}%`}
        onChange={event => {
          const element = video.current;
          if (element) { element.volume = Number(event.target.value); element.muted = false; }
        }}/>
      <span className="video-time" aria-live="off">{formatVideoTime(state.time)} <span>/ {formatVideoTime(state.duration)}</span></span>
      <button type="button" className="video-control-button video-fullscreen" disabled={disabled}
        onClick={() => toggleVideoFullscreen(stage.current)}
        aria-label={fullscreen ? text('Выйти из полного экрана', 'Exit fullscreen') : text('На весь экран', 'Fullscreen')}>
        <ControlIcon kind={fullscreen ? 'restore' : 'fullscreen'}/>
      </button>
    </div>
  </div>;
}

function TimelinePreview({ source, time, fraction, width, language }: { source: string; time: number; fraction: number; width: number; language: Language }) {
  const decoder = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef(time);
  target.current = time;
  const [captured, setCaptured] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const seek = useRef<() => void>(() => {});
  useEffect(() => {
    const element = decoder.current!;
    let disposed = false;
    let stalled: number | undefined;
    function fail() { if (!disposed) setFailed(true); }
    function seekToTarget() {
      if (disposed || element.readyState < HTMLMediaElement.HAVE_METADATA || element.seeking) return;
      const duration = element.duration;
      if (!Number.isFinite(duration) || duration <= 0) { fail(); return; }
      const requested = Math.max(0, Math.min(target.current, Math.max(0, duration - 0.05)));
      if (Math.abs(element.currentTime - requested) < .05 && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) draw();
      else {
        element.currentTime = requested;
        window.clearTimeout(stalled);
        stalled = window.setTimeout(fail, 8000);
      }
    }
    function draw() {
      if (disposed || element.seeking || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      window.clearTimeout(stalled);
      const expected = Math.max(0, Math.min(target.current, Math.max(0, element.duration - .05)));
      if (Math.abs(element.currentTime - expected) > .12) { seekToTarget(); return; }
      const surface = canvas.current;
      const context = surface?.getContext('2d', { alpha: false });
      if (!surface || !context || !element.videoWidth || !element.videoHeight) return;
      const scale = Math.min(surface.width / element.videoWidth, surface.height / element.videoHeight);
      const width = element.videoWidth * scale, height = element.videoHeight * scale;
      try {
        context.fillStyle = '#08080c'; context.fillRect(0, 0, surface.width, surface.height);
        context.drawImage(element, (surface.width - width) / 2, (surface.height - height) / 2, width, height);
        setCaptured(element.currentTime); setFailed(false);
      } catch { fail(); }
    }
    seek.current = seekToTarget;
    element.addEventListener('loadedmetadata', seekToTarget);
    element.addEventListener('loadeddata', draw);
    element.addEventListener('seeked', draw);
    element.addEventListener('error', fail);
    element.muted = true;
    element.src = source;
    stalled = window.setTimeout(fail, 8000);
    return () => {
      disposed = true;
      window.clearTimeout(stalled);
      seek.current = () => {};
      element.removeEventListener('loadedmetadata', seekToTarget);
      element.removeEventListener('loadeddata', draw);
      element.removeEventListener('seeked', draw);
      element.removeEventListener('error', fail);
      element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [source]);
  useEffect(() => {
    const timer = window.setTimeout(() => seek.current(), 65);
    return () => window.clearTimeout(timer);
  }, [time]);
  return <div className="timeline-preview" style={{ '--preview-position': `${fraction * 100}%`, '--preview-width': `${width}px` } as CSSProperties} aria-hidden="true">
    <canvas ref={canvas} width={192} height={108} style={{ visibility: captured === null || failed ? 'hidden' : 'visible' }}/>
    {captured === null && !failed && <span className="timeline-preview-loading"><span className="spinner"/></span>}
    {failed && <span className="timeline-preview-loading">{language === 'ru' ? 'Кадр недоступен' : 'Preview unavailable'}</span>}
    <span className="timeline-preview-time">{formatVideoTime(captured ?? time)}</span>
    <video ref={decoder} className="timeline-preview-decoder" muted playsInline preload="metadata" tabIndex={-1}/>
  </div>;
}

function ControlIcon({ kind }: { kind: 'play' | 'pause' | 'volume' | 'muted' | 'fullscreen' | 'restore' }) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'play' ? <path d="m8 5 11 7-11 7z" fill="currentColor"/>
      : kind === 'pause' ? <><path d="M8 5v14M16 5v14" strokeWidth="4"/></>
      : kind === 'volume' || kind === 'muted' ? <><path d="M11 4 5 9H2v6h3l6 5z"/>{kind === 'muted' ? <path d="m16 9 6 6m-6 0 6-6"/> : <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></>}</>
      : kind === 'fullscreen' ? <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>
      : <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>}
  </svg>;
}
