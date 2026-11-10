import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { extractVideoFrames, prepareCustomPoster } from './videoPoster';
import type { Language } from './types';
import type { VideoPosterFrame } from './videoPoster';
import './PosterPicker.css';

type Props = {
  source: string;
  language: Language;
  count: number;
  disabled?: boolean;
  onChange: (poster: Blob | null) => void;
  onBusyChange?: (busy: boolean) => void;
};

const copy = {
  ru: {
    title: 'Обложка видео',
    empty: 'После выбора видео здесь появятся кадры для обложки.',
    reading: 'Подбираем кадры…',
    unavailable: 'Браузер не смог извлечь кадры. Можно загрузить изображение для обложки.',
    choose: 'Выберите кадр из видео или загрузите своё изображение.',
    frame: 'Кадр на',
    upload: 'Загрузить свою обложку',
    preparing: 'Подготавливаем обложку…',
    custom: 'Своя обложка',
    fileError: 'Не удалось открыть изображение. Выберите JPG, PNG или WebP размером до 20 МБ.',
  },
  en: {
    title: 'Video cover',
    empty: 'Choose a video to see its cover candidates here.',
    reading: 'Picking frames…',
    unavailable: 'The browser could not extract frames. You can upload a cover image.',
    choose: 'Choose a video frame or upload your own image.',
    frame: 'Frame at',
    upload: 'Upload a custom cover',
    preparing: 'Preparing the cover…',
    custom: 'Custom cover',
    fileError: 'Could not open the image. Choose a JPG, PNG, or WebP file up to 20 MB.',
  },
} satisfies Record<Language, Record<string, string>>;

function PosterImage({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url ? <img src={url} alt=""/> : null;
}

function timestamp(time: number) {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function PosterPicker({ source, language, count, disabled, onChange, onBusyChange }: Props) {
  const t = copy[language];
  const input = useRef<HTMLInputElement>(null);
  const uploadRequest = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ source: string; count: number; frames: VideoPosterFrame[] } | null>(null);
  const [choice, setChoice] = useState<{ source: string; blob: Blob; customName?: string } | null>(null);
  const [uploadingSource, setUploadingSource] = useState<string | null>(null);
  const [uploadErrorSource, setUploadErrorSource] = useState<string | null>(null);

  const currentResult = result?.source === source && result.count === count ? result : null;
  const currentChoice = choice?.source === source ? choice : null;
  const frames = currentResult?.frames ?? [];
  const custom = currentChoice?.customName ? currentChoice : null;
  const selectedFrame = frames.find(frame => frame.blob === currentChoice?.blob) ?? frames[0];
  const selected = custom?.blob ?? selectedFrame?.blob ?? null;
  const loadingFrames = Boolean(source && !currentResult);
  const uploading = uploadingSource === source;
  const busy = uploading || (loadingFrames && !custom);

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    const storeFrames = (frames: VideoPosterFrame[]) => {
      if (!controller.signal.aborted) setResult({ source, count, frames });
    };
    void extractVideoFrames(source, count, { signal: controller.signal }).then(storeFrames, () => storeFrames([]));
    return () => controller.abort();
  }, [source, count]);

  useEffect(() => () => uploadRequest.current?.abort(), [source]);
  useEffect(() => { onChange(selected); }, [onChange, selected]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  async function pickFile(file: File) {
    uploadRequest.current?.abort();
    const controller = new AbortController();
    uploadRequest.current = controller;
    setUploadingSource(source);
    setUploadErrorSource(null);
    try {
      const blob = await prepareCustomPoster(file, { signal: controller.signal });
      if (!controller.signal.aborted) setChoice({ source, blob, customName: file.name });
    } catch {
      if (!controller.signal.aborted) setUploadErrorSource(source);
    } finally {
      if (uploadRequest.current === controller) {
        uploadRequest.current = null;
        if (!controller.signal.aborted) setUploadingSource(null);
      }
    }
  }

  function pickFrame(blob: Blob) {
    uploadRequest.current?.abort();
    setUploadingSource(null);
    setUploadErrorSource(null);
    setChoice({ source, blob });
  }

  return <fieldset className="poster-picker" disabled={disabled || !source}>
    <legend>{t.title}</legend>
    {!source ? <div className="poster-picker-empty"><Icon name="photo" size={24}/><p>{t.empty}</p></div> : <>
      <p className="help-text poster-picker-intro">{t.choose}</p>
      {loadingFrames && <p className="poster-picker-status" role="status"><span className="spinner"/>{t.reading}</p>}
      {!loadingFrames && !frames.length && <p className="help-text">{t.unavailable}</p>}
      {!!frames.length && <div className="poster-picker-frames">
        {frames.map((frame, index) => {
          const active = selected === frame.blob;
          const label = timestamp(frame.time);
          return <button type="button" key={index} className="poster-picker-frame" aria-label={`${t.frame} ${label}`} aria-pressed={active}
            onClick={() => pickFrame(frame.blob)}>
            <PosterImage blob={frame.blob}/>
            <span className="poster-picker-time">{label}</span>
            {active && <span className="poster-picker-check"><Icon name="check" size={14}/></span>}
          </button>;
        })}
      </div>}
      {custom && <div className="poster-picker-custom">
        <PosterImage blob={custom.blob}/>
        <div><strong>{t.custom}</strong><small title={custom.customName}>{custom.customName}</small></div>
        <span className="poster-picker-custom-check"><Icon name="check" size={16}/></span>
      </div>}
      <input ref={input} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" tabIndex={-1}
        aria-label={t.upload} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void pickFile(file);
        }}/>
      <button type="button" className="secondary-button poster-picker-upload" disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? <span className="spinner"/> : <Icon name="upload" size={18}/>}{uploading ? t.preparing : t.upload}
      </button>
      {uploadErrorSource === source && <p className="error-text" role="alert">{t.fileError}</p>}
    </>}
  </fieldset>;
}
