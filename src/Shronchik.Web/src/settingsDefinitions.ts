import { defaultSettings } from './types';
import type { Hotkeys, Language, Settings } from './types';

export type Localized = readonly [ru: string, en: string];
export const translate = (value: Localized, language: Language) => value[language === 'ru' ? 0 : 1];
export type SettingsSection = 'appearance' | 'gallery' | 'player' | 'feed' | 'hotkeys' | 'security' | 'storage';
type KeysOfType<T> = { [K in keyof Settings]-?: Settings[K] extends T ? K : never }[keyof Settings];
type NumericKey = Exclude<KeysOfType<number>, 'schemaVersion'>;
export type ColorKey = 'backgroundColor' | 'surfaceColor' | 'accentColor' | 'textColor' | 'mutedTextColor';
type ChoiceKey = Exclude<KeysOfType<string>, ColorKey>;
type FieldBase = { label: Localized; description: Localized; unavailable?: Localized; admin?: boolean };
export type SettingsField = FieldBase & (
  { key: NumericKey; kind: 'number'; min: number; max: number; step: number; unit?: Localized } |
  { key: KeysOfType<boolean>; kind: 'toggle' } |
  { key: ColorKey; kind: 'color' } |
  { key: ChoiceKey; kind: 'select'; choices: readonly (readonly [value: string, label: Localized])[] }
);
const number = (key: NumericKey, label: Localized, description: Localized, min: number, max: number, step = 1, extra?: Pick<Extract<SettingsField, { kind: 'number' }>, 'unit' | 'unavailable' | 'admin'>): SettingsField =>
  ({ key, kind: 'number', label, description, min, max, step, ...extra });
const toggle = (key: KeysOfType<boolean>, label: Localized, description: Localized, extra?: Pick<FieldBase, 'unavailable' | 'admin'>): SettingsField =>
  ({ key, kind: 'toggle', label, description, ...extra });
const color = (key: ColorKey, label: Localized, description: Localized): SettingsField => ({ key, kind: 'color', label, description });
const select = (key: ChoiceKey, label: Localized, description: Localized, choices: Extract<SettingsField, { kind: 'select' }>['choices'], extra?: Pick<FieldBase, 'unavailable' | 'admin'>): SettingsField =>
  ({ key, kind: 'select', label, description, choices, ...extra });

const automatic = [ ['auto', ['По системе', 'System default']], ['on', ['Включено', 'On']], ['off', ['Выключено', 'Off']] ] as const;
const milliseconds = ['мс', 'ms'] as const;
const pixels = ['пкс', 'px'] as const;
const days = ['дн.', 'days'] as const;
const processingUnavailable = ['Доступно после подключения обработки FFmpeg.', 'Available once FFmpeg processing is integrated.'] as const;

export const fields: Record<SettingsSection, readonly SettingsField[]> = {
  appearance: [
    select('language', ['Язык', 'Language'], ['Язык меню и сообщений.', 'Language of menus and messages.'], [['ru', ['Русский', 'Русский']], ['en', ['English', 'English']]]),
    select('theme', ['Тема', 'Theme'], ['Выбирает набор цветов для сайта.', 'Applies a palette to the site.'], [['custom_dark', ['Тёмная / своя', 'Dark / custom']], ['midnight', ['Полночь', 'Midnight']], ['light', ['Светлая', 'Light']]]),
    color('backgroundColor', ['Фон', 'Background'], ['Основной фон экранов.', 'Main screen background.']),
    color('surfaceColor', ['Поверхности', 'Surfaces'], ['Фон карточек и панелей.', 'Background of cards and panels.']),
    color('accentColor', ['Акцент', 'Accent'], ['Выделение кнопок и активных элементов.', 'Highlights buttons and active controls.']),
    color('textColor', ['Основной текст', 'Text'], ['Цвет заголовков и основного текста.', 'Color of headings and primary text.']),
    color('mutedTextColor', ['Второстепенный текст', 'Secondary text'], ['Цвет подписей и подсказок.', 'Color of labels and hints.']),
    number('shadowStrength', ['Интенсивность тени', 'Shadow strength'], ['Прозрачность тени карточек.', 'Opacity of card shadows.'], 0, 1, 0.01),
    number('hoverNeighborDim', ['Затемнение соседних карточек', 'Dim neighboring cards'], ['Сила затемнения при наведении на карточку.', 'How much nearby cards dim on hover.'], 0, 0.6, 0.01),
    number('cardRadiusPx', ['Скругление карточек', 'Card corner radius'], ['Радиус углов карточек.', 'Radius of card corners.'], 0, 30, 1, { unit: pixels }),
    number('animationMs', ['Длительность анимации', 'Animation duration'], ['Время переходов интерфейса.', 'Duration of interface transitions.'], 0, 1000, 1, { unit: milliseconds }),
    select('reduceMotion', ['Уменьшение движения', 'Reduce motion'], ['Ограничивает анимации интерфейса; GIF управляются отдельно.', 'Limits interface animations; GIF playback is controlled separately.'], automatic),
    number('fontScale', ['Масштаб текста', 'Text scale'], ['Относительный размер текста интерфейса.', 'Relative size of interface text.'], 0.8, 1.4, 0.01),
  ],
  gallery: [
    number('gridColumns', ['Столбцы', 'Columns'], ['Максимум столбцов на широком экране.', 'Maximum columns on a wide screen.'], 2, 20),
    number('gridGapPx', ['Расстояние между карточками', 'Card spacing'], ['Горизонтальный и вертикальный зазор в сетке.', 'Horizontal and vertical gap in the grid.'], 2, 32, 1, { unit: pixels }),
    select('cardAspectRatio', ['Пропорции карточки', 'Card aspect ratio'], ['Соотношение сторон области изображения.', 'Aspect ratio of the card image area.'], [['16:9', ['16:9', '16:9']], ['4:3', ['4:3', '4:3']], ['1:1', ['1:1', '1:1']]]),
    number('cardTitleLines', ['Строки заголовка', 'Title lines'], ['Сколько строк доступно названию файла.', 'Number of lines available for the media title.'], 1, 3),
    toggle('sidebarExpanded', ['Открывать фильтры', 'Show filters initially'], ['Открывает панель поиска и тегов при входе в галерею.', 'Shows search and tags when entering a gallery.']),
    toggle('showSkeletons', ['Заглушки загрузки', 'Loading placeholders'], ['Показывает форму карточек, пока загружается список.', 'Shows card outlines while the list loads.']),
    number('queryDebounceMs', ['Задержка поиска', 'Search delay'], ['Пауза перед поиском после ввода текста.', 'Delay after typing before running a search.'], 0, 600, 1, { unit: milliseconds }),
    number('pageBatchSize', ['Карточек за загрузку', 'Cards per request'], ['Размер страницы при подгрузке галереи.', 'Page size when loading more gallery items.'], 20, 150),
  ],
  player: [
    number('volume', ['Громкость', 'Volume'], ['Начальная громкость при открытии видео.', 'Initial volume when opening a video.'], 0, 1, 0.01),
    number('seekSeconds', ['Шаг перемотки', 'Seek interval'], ['Сколько секунд пропускают клавиши перемотки.', 'Seconds skipped by seek shortcuts.'], 1, 30, 1, { unit: ['сек.', 'sec'] }),
    number('gifVisibilityMarginPx', ['Зона загрузки GIF', 'GIF preload margin'], ['Расстояние от видимой области до начала загрузки GIF.', 'Distance from the viewport at which GIF loading starts.'], 0, 300, 1, { unit: pixels }),
    number('maxAnimatedCards', ['Одновременные GIF', 'Simultaneous GIFs'], ['Лимит анимаций, которые галерея может показать одновременно.', 'Maximum animated GIFs shown by the gallery at once.'], 1, 40),
    toggle('showRelatedBelow', ['Подборка под видео', 'Suggestions below video'], ['Показывает похожие и случайные ролики под проигрывателем.', 'Shows related and random videos below the player.']),
    number('hoverDelayMs', ['Задержка видеопревью', 'Video preview delay'], ['Пауза перед предпросмотром при наведении.', 'Delay before starting a hover preview.'], 0, 1200, 1, { unit: milliseconds }),
    select('gpuDecodePreference', ['Аппаратное декодирование', 'Hardware decoding'], ['Предпочтительный режим декодера.', 'Preferred decoder mode.'], automatic, { unavailable: processingUnavailable }),
    number('ramCacheMB', ['Кэш миниатюр в памяти', 'Thumbnail memory cache'], ['Лимит кэша миниатюр до блокировки или выхода.', 'Thumbnail cache limit until locking or signing out.'], 128, 4096, 1, { unit: ['МБ', 'MB'] }),
  ],
  feed: [
    number('ratedPercent', ['Доля по рейтингу', 'Rated share'], ['Остальную часть подборки займут случайные видео.', 'Random videos fill the rest of the feed.'], 0, 100, 1, { unit: ['%', '%'] }),
    number('minimumRating', ['Порог рейтинга', 'Minimum rating'], ['Минимальная оценка для попадания в рейтинговую часть.', 'Minimum score for the rated portion of the feed.'], 1, 10000),
    number('ratingWeight', ['Вес рейтинга', 'Rating weight'], ['Остальной вес получают совпадения тегов.', 'Matching tags receive the remaining weight.'], 0, 1, 0.01),
    number('relatedCount', ['Похожие видео', 'Related videos'], ['Количество похожих роликов под проигрывателем.', 'Number of related videos below the player.'], 0, 30),
    number('randomRelatedCount', ['Случайные видео', 'Random videos'], ['Количество случайных роликов под проигрывателем.', 'Number of random videos below the player.'], 0, 30),
  ],
  hotkeys: [],
  security: [number('afkMinutes', ['Блокировка при бездействии', 'Idle lock'], ['Во время воспроизведения видео отсчёт приостанавливается.', 'The timer pauses during video playback.'], 1, 120, 1, { unit: ['мин.', 'min'] })],
  storage: [
    number('thumbnailCandidates', ['Варианты обложки', 'Cover candidates'], ['Сколько кадров предлагать при импорте и смене обложки.', 'Number of frames offered when importing a video or changing its cover.'], 3, 12, 1, { admin: true }),
    number('trashRetentionDays', ['Срок хранения в корзине', 'Trash retention'], ['Срок для новых удалений. Автоматическая очистка пока не выполняется.', 'Retention for new deletions. Automatic cleanup is not available yet.'], 1, 365, 1, { unit: days, admin: true }),
    number('lowDiskWarningGB', ['Минимум свободного места', 'Minimum free space'], ['Резерв на диске при импорте. Ноль отключает дополнительный резерв.', 'Disk reserve during import. Zero disables the extra reserve.'], 0, 1000, 1, { unit: ['ГиБ', 'GiB'], admin: true }),
    select('verifyOnStartup', ['Проверка при запуске', 'Startup verification'], ['Профиль автоматической проверки каталога.', 'Automatic catalog verification profile.'], [['quick', ['Быстрая', 'Quick']], ['full', ['Полная', 'Full']]], { admin: true, unavailable: ['Сейчас при входе выполняется быстрая проверка.', 'Sign-in currently runs the quick check.'] }),
    number('backupReminderDays', ['Напоминание о копии', 'Backup reminder'], ['Интервал напоминания о резервной копии.', 'Interval for backup reminders.'], 0, 90, 1, { unit: days, admin: true, unavailable: ['Доступно после добавления резервного копирования.', 'Available once backups are implemented.'] }),
    number('workerConcurrency', ['Потоки для миниатюр', 'Thumbnail workers'], ['Сколько миниатюр создавать параллельно.', 'Number of parallel thumbnail jobs.'], 1, 8, 1, { admin: true, unavailable: processingUnavailable }),
    number('maxTranscodes', ['Одновременные конвертации', 'Parallel transcodes'], ['Лимит задач перекодирования видео.', 'Limit for concurrent video transcodes.'], 1, 3, 1, { admin: true, unavailable: processingUnavailable }),
    toggle('pauseOnBattery', ['Пауза при питании от батареи', 'Pause on battery'], ['Приостанавливает фоновые задачи при работе от батареи.', 'Pauses background jobs on battery power.'], { admin: true, unavailable: processingUnavailable }),
    number('ffmpegThreads', ['Потоки FFmpeg', 'FFmpeg threads'], ['Ноль означает автоматический выбор числа потоков.', 'Zero lets FFmpeg choose its thread count.'], 0, 32, 1, { admin: true, unavailable: processingUnavailable }),
  ],
};

type Palette = Pick<Settings, ColorKey>;
export const palettes: Record<Settings['theme'], Palette> = {
  custom_dark: { backgroundColor: defaultSettings.backgroundColor, surfaceColor: defaultSettings.surfaceColor, accentColor: defaultSettings.accentColor, textColor: defaultSettings.textColor, mutedTextColor: defaultSettings.mutedTextColor },
  midnight: { backgroundColor: '#101525', surfaceColor: '#192036', accentColor: '#AEBFFF', textColor: '#EEF1FC', mutedTextColor: '#A3ACC8' },
  light: { backgroundColor: '#F3EFF9', surfaceColor: '#FFFFFF', accentColor: '#7448B5', textColor: '#221B30', mutedTextColor: '#615672' },
};

export type HotkeyAction = keyof Hotkeys;
export type HotkeyScope = 'global' | 'player' | 'gallery' | 'viewer';
export const hotkeyActions: { key: HotkeyAction; label: Localized; scope: HotkeyScope }[] = [
  { key: 'playPause', label: ['Пауза / продолжить', 'Pause / play'], scope: 'player' },
  { key: 'seekBackward', label: ['Перемотать назад', 'Seek backward'], scope: 'player' },
  { key: 'seekForward', label: ['Перемотать вперёд', 'Seek forward'], scope: 'player' },
  { key: 'volumeUp', label: ['Громче', 'Volume up'], scope: 'player' },
  { key: 'volumeDown', label: ['Тише', 'Volume down'], scope: 'player' },
  { key: 'toggleFullscreen', label: ['Полноэкранный режим', 'Toggle fullscreen'], scope: 'player' },
  { key: 'exitFullscreen', label: ['Выйти из полного экрана', 'Exit fullscreen'], scope: 'player' },
  { key: 'toggleMute', label: ['Включить / выключить звук', 'Toggle mute'], scope: 'player' },
  { key: 'toggleFilters', label: ['Открыть / закрыть фильтры', 'Toggle filters'], scope: 'gallery' },
  { key: 'goHome', label: ['На главную', 'Go home'], scope: 'global' },
  { key: 'lock', label: ['Заблокировать', 'Lock'], scope: 'global' },
  { key: 'nextMedia', label: ['Следующий файл', 'Next media'], scope: 'viewer' },
  { key: 'previousMedia', label: ['Предыдущий файл', 'Previous media'], scope: 'viewer' },
];
const reservedShortcuts = new Set(['Alt+F4', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+L', 'Ctrl+R', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+P', 'Ctrl+S', 'Ctrl+O', 'F5', 'F11', 'F12']);

export function keyboardShortcut(event: KeyboardEvent): string | null {
  if (event.metaKey || event.isComposing || event.getModifierState('AltGraph')) return null;
  const code = event.code;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3)
    : /^Digit[0-9]$/.test(code) ? code.slice(5)
    : event.key === ' ' || code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space|Escape|Enter|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right))$/.test(key)) return null;
  const shortcut = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
  return reservedShortcuts.has(shortcut) ? null : shortcut;
}

export function conflictingHotkeys(hotkeys: Hotkeys, action: HotkeyAction, shortcut: string) {
  if (!shortcut) return [];
  const current = hotkeyActions.find(item => item.key === action)!;
  return hotkeyActions.filter(item => item.key !== action && hotkeys[item.key] === shortcut &&
    (item.scope === 'global' || current.scope === 'global' || item.scope === current.scope ||
      (item.scope === 'viewer' && current.scope === 'player') || (item.scope === 'player' && current.scope === 'viewer')));
}
