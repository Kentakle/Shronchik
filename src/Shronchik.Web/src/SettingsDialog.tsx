import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { mutate } from './api';
import { AccountsPanel, PasswordForm } from './AccountSettings';
import { Modal } from './Dialogs';
import { StorageSettings } from './StorageSettings';
import { errorMessage, strings } from './i18n';
import type { T } from './i18n';
import { Icon } from './Icon';
import { conflictingHotkeys, fields, hotkeyActions, keyboardShortcut, palettes, translate } from './settingsDefinitions';
import type { HotkeyAction, Localized, SettingsField, SettingsSection } from './settingsDefinitions';
import { defaultHotkeys, defaultSettings } from './types';
import type { Language, Role, Settings } from './types';
import './settings-dialog.css';

type Props = {
  t: T;
  settings: Settings;
  role: Role;
  initialSection?: SettingsSection;
  onClose: () => void;
  onSave: (value: Settings) => void;
  onPasswordChanged: () => void;
  onPreview?: (value: Settings | null) => void;
};

type SettingsView = SettingsSection | 'users';

const sections: { id: SettingsView; label: Localized; icon: 'grid' | 'settings' | 'play' | 'star' | 'menu' | 'shield' | 'album' | 'user' }[] = [
  { id: 'appearance', label: ['Внешний вид', 'Appearance'], icon: 'settings' },
  { id: 'gallery', label: ['Галерея и поиск', 'Gallery and search'], icon: 'grid' },
  { id: 'player', label: ['Воспроизведение', 'Playback'], icon: 'play' },
  { id: 'feed', label: ['Рекомендации', 'Recommendations'], icon: 'star' },
  { id: 'hotkeys', label: ['Горячие клавиши', 'Shortcuts'], icon: 'menu' },
  { id: 'security', label: ['Безопасность', 'Security'], icon: 'shield' },
  { id: 'users', label: ['Пользователи', 'Users'], icon: 'user' },
  { id: 'storage', label: ['Хранилище', 'Storage'], icon: 'album' },
];

const editableFields = Object.values(fields).flat().filter(field => !field.unavailable);
const adminKeys = editableFields.filter(field => field.admin).map(field => field.key);
const commonKeys: (keyof Settings)[] = [...editableFields.filter(field => !field.admin).map(field => field.key), 'hotkeys'];
const settingKeys = [...commonKeys, ...adminKeys];

function equalSetting(a: Settings, b: Settings, key: keyof Settings) {
  return key === 'hotkeys' ? hotkeyActions.every(action => a.hotkeys[action.key] === b.hotkeys[action.key]) : a[key] === b[key];
}

export function SettingsDialog({ settings, role, initialSection = 'appearance', onClose, onSave, onPasswordChanged, onPreview }: Props) {
  const [draft, setDraft] = useState(settings);
  const [section, setSection] = useState<SettingsView>(initialSection);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [closing, setClosing] = useState(false);
  const [resetConfirm, setResetConfirm] = useState<SettingsView | null>(null);
  const saved = useRef(settings);
  const latestDraft = useRef(settings);
  const mounted = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const saveCallback = useRef(onSave);
  saveCallback.current = onSave;
  const content = useRef<HTMLDivElement>(null);
  const sectionElements = useRef(new Map<SettingsView, HTMLElement>());
  const scrollAnimation = useRef<number | null>(null);
  const previewCallback = useRef(onPreview);
  previewCallback.current = onPreview;
  const t = strings(draft.language);
  const language = draft.language;
  const text = (ru: string, en: string) => translate([ru, en], language);
  const admin = role === 'Admin';
  const visibleSections = sections.filter(item => admin || (item.id !== 'users' && item.id !== 'storage'));

  useEffect(() => { previewCallback.current?.(draft); }, [draft]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearSaveTimer();
      previewCallback.current?.(null);
    };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = sectionElements.current.get(initialSection) ?? sectionElements.current.get('appearance');
      if (content.current && target) {
        content.current.scrollTop = target.offsetTop;
        syncSection();
      }
    });
    return () => { cancelAnimationFrame(frame); stopScrollAnimation(); };
  }, [initialSection, admin]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (scrollAnimation.current === null) syncSection();
    });
    if (content.current) observer.observe(content.current);
    sectionElements.current.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [admin]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    const previous = latestDraft.current;
    changeDraft(key === 'theme'
      ? { ...previous, ...palettes[value as Settings['theme']], theme: value as Settings['theme'] }
      : { ...previous, [key]: value });
  }

  function resetFields(keys: readonly (keyof Settings)[]) {
    changeDraft({ ...latestDraft.current, ...(keys.includes('theme') ? palettes[defaultSettings.theme] : {}),
      ...Object.fromEntries(keys.map(key => [key, defaultSettings[key]])) });
  }

  function clearSaveTimer() {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }

  function changeDraft(value: Settings) {
    if (closing) return;
    latestDraft.current = value;
    setDraft(value);
    setError('');
    setSaveState('saving');
    clearSaveTimer();
    saveTimer.current = setTimeout(() => { void savePending(); }, 400);
  }

  function savePending(): Promise<boolean> {
    clearSaveTimer();
    if (savePromise.current) return savePromise.current;
    const changedKeys = (keys: readonly (keyof Settings)[]) => keys.filter(key => !equalSetting(saved.current, latestDraft.current, key));
    if (!changedKeys(commonKeys).length && (!admin || !changedKeys(adminKeys).length)) {
      setSaveState('saved');
      return Promise.resolve(true);
    }
    setSaveState('saving');
    setError('');
    const operation = (async () => {
      try {
        while (mounted.current) {
          const common = changedKeys(commonKeys);
          const keys = common.length ? common : admin ? changedKeys(adminKeys) : [];
          if (!keys.length) {
            clearSaveTimer();
            setSaveState('saved');
            return true;
          }
          const before = saved.current;
          const snapshot = latestDraft.current;
          const payload = Object.fromEntries(keys.map(key => [key, snapshot[key]]));
          const result = await mutate<Settings>(common.length ? '/settings/ui' : '/settings/admin', 'PATCH', payload);
          if (!mounted.current) return false;
          // Keep edits made during the request, including pending changes in the other scope.
          const pending = settingKeys.filter(key => !equalSetting(keys.includes(key) ? snapshot : before, latestDraft.current, key))
            .map(key => [key, latestDraft.current[key]]);
          saved.current = result;
          latestDraft.current = { ...result, ...Object.fromEntries(pending) };
          setDraft(latestDraft.current);
          saveCallback.current(result);
        }
        return false;
      } catch (err) {
        clearSaveTimer();
        if (mounted.current) {
          setError(errorMessage(err, strings(latestDraft.current.language)));
          setSaveState('error');
        }
        return false;
      } finally { savePromise.current = null; }
    })();
    savePromise.current = operation;
    return operation;
  }

  async function prepareClose() {
    setClosing(true);
    const success = await savePending();
    if (!success && mounted.current) setClosing(false);
    return success;
  }

  function stopScrollAnimation() {
    if (scrollAnimation.current === null) return;
    cancelAnimationFrame(scrollAnimation.current);
    scrollAnimation.current = null;
    syncSection();
  }

  function syncSection() {
    const pane = content.current;
    if (!pane || scrollAnimation.current !== null) return;
    const visible = sections.filter(item => sectionElements.current.has(item.id));
    const atEnd = pane.scrollTop > 0 && pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 2;
    const current = atEnd ? visible.at(-1) : visible.reverse().find(item => sectionElements.current.get(item.id)!.offsetTop <= pane.scrollTop + 48);
    if (current) setSection(current.id);
  }

  function goToSection(value: SettingsView) {
    const pane = content.current;
    const target = sectionElements.current.get(value);
    if (!pane || !target) return;
    stopScrollAnimation();
    setSection(value);
    const start = pane.scrollTop;
    const destination = Math.min(target.offsetTop, pane.scrollHeight - pane.clientHeight);
    const reduceMotion = draft.reduceMotion === 'on' ||
      (draft.reduceMotion === 'auto' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduceMotion || Math.abs(destination - start) < 1) {
      pane.scrollTop = destination;
      return;
    }
    const started = performance.now();
    const animate = (now: number) => {
      const progress = Math.min((now - started) / 240, 1);
      const end = Math.min(target.offsetTop, pane.scrollHeight - pane.clientHeight);
      pane.scrollTop = start + (end - start) * (1 - (1 - progress) ** 3);
      scrollAnimation.current = progress < 1 ? requestAnimationFrame(animate) : null;
    };
    scrollAnimation.current = requestAnimationFrame(animate);
  }

  return <Modal title={t.settings} closeLabel={t.close} onClose={onClose} beforeClose={prepareClose} wide className="settings-modal" dismissOnBackdrop animateClose>
    <div className={`settings-autosave${error ? ' error-text' : ''}`} role={error ? 'alert' : 'status'}>
      {error ? <><span>{error}</span><button type="button" className="text-button" onClick={() => { void savePending(); }}>{t.retry}</button></>
        : saveState === 'saving' ? <><span className="spinner"/>{text('Сохранение…', 'Saving…')}</>
        : saveState === 'saved' ? <><Icon name="check" size={14}/>{t.saved}</>
        : text('Изменения сохраняются автоматически', 'Changes are saved automatically')}
    </div>
    <div className="settings-layout expanded-settings">
      <nav className="settings-nav" aria-label={t.settings}>
        {visibleSections.map(item => <button type="button" className={section === item.id ? 'active' : ''}
          key={item.id} aria-current={section === item.id ? 'location' : undefined} aria-controls={`settings-section-${item.id}`}
          onClick={() => goToSection(item.id)}>
          <Icon name={item.icon}/>{translate(item.label, language)}
        </button>)}
      </nav>
      <div className="settings-content" ref={content} tabIndex={0} role="region" aria-label={t.settings}
        onScroll={syncSection} onWheel={stopScrollAnimation} onTouchStart={stopScrollAnimation}
        onKeyDown={event => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) stopScrollAnimation();
        }}>
        {visibleSections.map(item => {
          const view = item.id;
          const onStorage = view === 'storage';
          const sectionFields = view === 'users' ? [] : fields[view].filter(field => !field.unavailable && (admin || !field.admin));
          const sectionReset = sectionFields.map(field => field.key);
          return <section key={view} id={`settings-section-${view}`} className="settings-section"
            aria-labelledby={`settings-heading-${view}`} ref={element => {
              if (element) sectionElements.current.set(view, element);
              else sectionElements.current.delete(view);
            }}>
            <h3 id={`settings-heading-${view}`}>{translate(item.label, language)}</h3>
            {view !== 'users' && <p className="help-text">{text(
              onStorage ? 'Параметры хранилища применяются ко всей медиатеке.' : 'Настройки сохраняются отдельно для вашей учётной записи.',
              onStorage ? 'Storage settings apply to the entire library.' : 'Settings are saved separately for your account.')}</p>}
            {onStorage && admin && <StorageSettings language={language}/>}
            {view === 'users' ? (admin && <AccountsPanel language={language}/>) : <div className="settings-fields">
              {view === 'appearance' && <AppearancePreview settings={draft}/>}
              {sectionFields.map(field => <SettingRow key={field.key} field={field} settings={draft}
                update={update} reset={() => resetFields([field.key])} busy={closing}/>)}
              {view === 'hotkeys' && <HotkeysEditor settings={draft} disabled={closing}
                update={value => update('hotkeys', value)}/>}
              {view === 'player' && <ReadOnlyRules title={text('Правила воспроизведения', 'Playback rules')} items={[
                [text('Открытие видео', 'Opening a video'), text('С начала, запуск вручную', 'From the beginning, manual playback')],
                [text('Выход из полноэкранного режима', 'Exiting fullscreen'), text('Воспроизведение продолжается', 'Playback continues')],
                [text('Конец видео', 'End of video'), text('Остановка без автоперехода', 'Stop without playing the next video')],
              ]}/>}
              {view === 'feed' && <ReadOnlyRules title={text('Расчёт подборки', 'Feed rules')} items={[
                [text('Случайная доля', 'Random share'), `${100 - draft.ratedPercent}%`],
                [text('Вес совпадений тегов', 'Matching tags weight'), `${Math.round(100 * (1 - draft.ratingWeight))}%`],
                ...(!admin ? [[text('Глубина личной истории', 'Personal history depth'), '30'] as [string, string]] : []),
                [text('Обновление ленты', 'Refresh feed'), text('Повторное нажатие вкладки', 'Click the tab again')],
              ]}/>}
              {view === 'gallery' && <ReadOnlyRules title={admin ? text('Правила поиска', 'Search rules') : text('Правила поиска и истории', 'Search and history rules')} items={[
                [text('Включённые теги', 'Required tags'), text('Все выбранные', 'All selected')],
                ...(!admin ? [[text('Элементов истории на раздел', 'History items per category'), '10'] as [string, string]] : []),
              ]}/>}
              {view === 'security' && <ReadOnlyRules title={text('Правила блокировки', 'Lock rules')} items={[
                [text('Когда экран заблокирован', 'While the screen is locked'), text('Воспроизведение на паузе', 'Playback paused')],
                [text('Ручная блокировка', 'Manual lock'), text('Кнопка в шапке сайта', 'Button in the site header')],
                [text('Слабый пароль', 'Weak password'), text('Предупреждение до смены пароля', 'Warning until the password is changed')],
              ]}/>}
              {(sectionReset.length > 0 || view === 'hotkeys') && <div className="settings-reset-row">
                <button type="button" className="text-button" disabled={closing} onClick={() => resetFields(view === 'hotkeys' ? ['hotkeys'] : sectionReset)}>
                  <Icon name="refresh" size={14}/>{text('Сбросить раздел', 'Reset section')}
                </button>
                {!onStorage && <button type="button" className="text-button" disabled={closing} onClick={() => setResetConfirm(view)}>{t.resetUi}</button>}
              </div>}
              {resetConfirm === view && <div className="inline-confirm" role="alert">
                <strong>{t.resetConfirm}</strong><p>{t.resetText}</p>
                <button type="button" className="text-button" onClick={() => { resetFields(commonKeys); setResetConfirm(null); }}>{t.confirm}</button>
                <button type="button" className="text-button" onClick={() => setResetConfirm(null)}>{t.cancel}</button>
              </div>}
            </div>}
            {view === 'security' && <PasswordForm language={language} onPasswordChanged={onPasswordChanged}/>}
          </section>;
        })}
      </div>
    </div>
  </Modal>;
}

function SettingRow({ field, settings, update, reset, busy }: {
  field: SettingsField;
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
  busy: boolean;
}) {
  const language = settings.language;
  const id = `setting-${field.key}`;
  const disabled = busy || !!field.unavailable;
  const label = translate(field.label, language);
  let control;
  switch (field.kind) {
    case 'number':
      control = <NumberControl id={id} value={settings[field.key]} min={field.min} max={field.max} step={field.step}
        unit={field.unit ? translate(field.unit, language) : undefined} disabled={disabled}
        change={value => update(field.key, value)}/>;
      break;
    case 'toggle':
      control = <input id={id} type="checkbox" className="settings-checkbox" checked={settings[field.key]} disabled={disabled}
        onChange={event => update(field.key, event.target.checked)}/>;
      break;
    case 'color':
      control = <ColorControl id={id} value={settings[field.key]} disabled={disabled} change={value => update(field.key, value)}/>;
      break;
    case 'select':
      control = <select id={id} value={settings[field.key]} disabled={disabled}
        onChange={event => update(field.key, event.target.value as Settings[typeof field.key])}>
        {field.choices.map(([value, title]) => <option key={value} value={value}>{translate(title, language)}</option>)}
      </select>;
      break;
  }
  return <div className={`setting-row expanded-setting-row${field.unavailable ? ' unavailable-setting' : ''}`}>
    <div className="setting-copy">
      <label htmlFor={id}>{label}</label>
      <p className="help-text">{translate(field.description, language)}</p>
      {field.unavailable && <p className="help-text setting-unavailable">{translate(field.unavailable, language)}</p>}
    </div>
    <div className="setting-control">{control}{!field.unavailable && <ResetButton label={label} language={language} reset={reset} disabled={busy}/>}</div>
  </div>;
}

function ResetButton({ label, language, reset, disabled }: { label: string; language: Language; reset: () => void; disabled: boolean }) {
  const title = language === 'ru' ? `Вернуть стандартное значение · ${label}` : `Reset to default · ${label}`;
  return <button type="button" className="inline-icon setting-reset" title={title} aria-label={title} disabled={disabled} onClick={reset}>
    <Icon name="refresh" size={14}/>
  </button>;
}

function NumberControl({ id, value, min, max, step, unit, disabled, change }: {
  id: string; value: number; min: number; max: number; step: number; unit?: string; disabled: boolean; change: (value: number) => void;
}) {
  const [input, setInput] = useState(String(value));
  useEffect(() => { setInput(String(value)); }, [value]);
  return <div className="input-unit setting-number">
    <input id={id} type="number" value={input} min={min} max={max} step={step} disabled={disabled} required
      onChange={event => {
        const next = event.currentTarget.valueAsNumber;
        setInput(event.currentTarget.value);
        if (event.currentTarget.validity.valid && Number.isFinite(next)) change(next);
      }} onBlur={() => setInput(String(value))}/>
    {unit && <span>{unit}</span>}
  </div>;
}

function ColorControl({ id, value, disabled, change }: { id: string; value: string; disabled: boolean; change: (value: string) => void }) {
  const [input, setInput] = useState(value);
  useEffect(() => { setInput(value); }, [value]);
  return <div className="setting-colors">
    <input type="color" className="color-input" aria-labelledby={id} value={value} disabled={disabled} onChange={event => change(event.target.value)}/>
    <input id={id} type="text" value={input} maxLength={7} pattern="#[0-9a-fA-F]{6}" disabled={disabled} required
      onChange={event => {
        const next = event.target.value;
        setInput(next);
        if (/^#[0-9a-fA-F]{6}$/.test(next)) change(next);
      }} onBlur={() => setInput(value)}/>
  </div>;
}

function AppearancePreview({ settings }: { settings: Settings }) {
  const style: CSSProperties = { background: settings.backgroundColor, color: settings.textColor, fontSize: `${settings.fontScale * 14}px`, padding: settings.gridGapPx };
  const card: CSSProperties = { background: settings.surfaceColor, borderRadius: settings.cardRadiusPx, boxShadow: `0 3px 12px rgba(0,0,0,${settings.shadowStrength})`, gap: settings.gridGapPx };
  const language = settings.language;
  return <div className="settings-preview" style={style}>
    <div style={card}>
      <Icon name="photo" size={23}/>
      <div><strong>{language === 'ru' ? 'Предпросмотр' : 'Preview'}</strong>
        <small style={{ color: settings.mutedTextColor }}>{language === 'ru' ? 'Палитра, тени и скругление' : 'Palette, shadows and corners'}</small>
      </div><span className="settings-preview-accent" style={{ background: settings.accentColor }}/>
    </div>
  </div>;
}

function ReadOnlyRules({ title, items }: { title: string; items: [string, string][] }) {
  return <details className="settings-rules">
    <summary>{title}</summary>
    <dl>{items.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
  </details>;
}

function HotkeysEditor({ settings, disabled, update }: { settings: Settings; disabled: boolean; update: (value: Settings['hotkeys']) => void }) {
  const [capture, setCapture] = useState<HotkeyAction | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const [conflict, setConflict] = useState<{ action: HotkeyAction; shortcut: string; conflicts: HotkeyAction[] } | null>(null);
  const language = settings.language;
  const text = (ru: string, en: string) => translate([ru, en], language);
  const scope = {
    global: text('Везде на сайте', 'Across the site'), player: text('Видеоплеер', 'Video player'), gallery: text('Галерея', 'Gallery'),
    viewer: text('Просмотр файлов', 'Media viewer'),
  };

  function assign(action: HotkeyAction, shortcut: string) {
    setCapture(null);
    setCaptureError(false);
    const conflicts = conflictingHotkeys(settings.hotkeys, action, shortcut);
    if (conflicts.length) setConflict({ action, shortcut, conflicts: conflicts.map(item => item.key) });
    else update({ ...settings.hotkeys, [action]: shortcut });
  }

  function captureKey(event: ReactKeyboardEvent<HTMLButtonElement>, action: HotkeyAction) {
    if (capture !== action || event.key === 'Tab') return;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const shortcut = keyboardShortcut(event.nativeEvent);
    if (shortcut) assign(action, shortcut);
    else setCaptureError(true);
  }

  return <div className="hotkey-editor">
    <p className="help-text">{text('Выберите действие и нажмите новое сочетание. Сочетания работают в указанной области.', 'Select an action and press a shortcut. Shortcuts work in the listed scope.')}</p>
    {hotkeyActions.map(action => {
      const label = translate(action.label, language);
      const capturing = capture === action.key;
      return <div className="setting-row expanded-setting-row" key={action.key}>
        <div className="setting-copy"><span>{label}</span><p className="help-text">{scope[action.scope]}</p></div>
        <div className="setting-control">
          <button type="button" className="secondary-button shortcut-button" disabled={disabled || !!conflict}
            aria-label={`${label} · ${settings.hotkeys[action.key] || text('Не назначено', 'Unassigned')}`}
            onClick={() => { setCapture(capturing ? null : action.key); setCaptureError(false); }} onKeyDown={event => captureKey(event, action.key)}>
            {capturing ? text('Нажмите клавиши…', 'Press keys…') : (settings.hotkeys[action.key] || text('Не назначено', 'Unassigned'))}
          </button>
          <ResetButton label={label} language={language} reset={() => assign(action.key, defaultHotkeys[action.key])} disabled={disabled || !!conflict}/>
        </div>
      </div>;
    })}
    {capture && <div className="settings-reset-row"><button type="button" className="text-button" onClick={() => { setCapture(null); setCaptureError(false); }}>{text('Отменить назначение', 'Cancel capture')}</button></div>}
    {captureError && <p className="error-text" role="alert">{text('Выберите другое сочетание. Системные команды защищены.', 'Choose another shortcut. System shortcuts are reserved.')}</p>}
    {conflict && <div className="inline-confirm" role="alert">
      <strong>{text('Сочетание уже используется', 'Shortcut already in use')}</strong>
      <p>{conflict.shortcut} · {conflict.conflicts.map(key => translate(hotkeyActions.find(action => action.key === key)!.label, language)).join(', ')}</p>
      <button type="button" className="text-button" onClick={() => {
        const next = { ...settings.hotkeys, [conflict.action]: conflict.shortcut };
        for (const key of conflict.conflicts) next[key] = '';
        update(next); setConflict(null);
      }}>{text('Переназначить', 'Reassign')}</button>
      <button type="button" className="text-button" onClick={() => setConflict(null)}>{text('Отмена', 'Cancel')}</button>
    </div>}
  </div>;
}

