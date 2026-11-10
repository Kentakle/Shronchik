import { ApiError } from './api';
import type { Language } from './types';

const ru = {
  library: 'Медиатека', privateLibrary: 'Закрытая медиатека', home: 'Главная', video: 'Видео', photo: 'Фото', gif: 'GIF',
  recommendations: 'Рекомендации', albums: 'Альбомы', favorites: 'Избранное', history: 'История', settings: 'Настройки',
  lock: 'Заблокировать', logout: 'Выйти', import: 'Добавить файл', importShort: 'Добавить', search: 'Поиск по медиатеке',
  searchHint: 'Название, описание или тег', tags: 'Теги', clearFilters: 'Сбросить фильтры', filters: 'Поиск и фильтры',
  include: 'Включить', exclude: 'Исключить', neutral: 'Не учитывать', noTags: 'Нет доступных тегов',
  searchTags: 'Поиск по тегам', noMatchingTags: 'Теги не найдены',
  allFiles: 'Всего файлов', allMedia: 'Все файлы', storage: 'В медиатеке', connected: 'Подключено', disconnected: 'Нет связи', encrypted: 'Зашифрованное хранение',
  welcome: 'Ваше пространство. Ваша коллекция.', welcomeText: 'Любимые моменты собраны вместе. Выберите, что посмотреть сегодня.',
  gifDescription: 'Маленькие моменты в движении', videoDescription: 'Истории, к которым хочется вернуться', photoDescription: 'Моменты, которые остаются',
  openCategory: 'Открыть раздел', collection: 'Коллекция', noMedia: 'Здесь начинается ваша коллекция',
  noMediaText: 'Добавьте первый файл. Он будет скопирован в зашифрованное хранилище.', noUserMediaText: 'Пока нет файлов. Администратор может добавить их в медиатеку.',
  noResults: 'Ничего не найдено', noResultsText: 'Измените запрос или снимите часть фильтров.', noFavorites: 'Пока нет избранного',
  noFavoritesText: 'Нажмите на сердце у понравившегося файла — он появится здесь.', noHistory: 'История пока пуста',
  noHistoryText: 'Здесь будут последние открытые файлы этого раздела.',
  newFirst: 'Сначала новые', byRating: 'По рейтингу', byTitle: 'По названию', shuffle: 'Обновить подборку', randomOrder: 'Случайный порядок', sortOrder: 'Порядок сортировки',
  loadMore: 'Показать ещё', loading: 'Загрузка…', retry: 'Повторить', close: 'Закрыть', back: 'Назад',
  backGallery: 'Вернуться в галерею', rating: 'Рейтинг', unrated: 'Без оценки', clearRating: 'Убрать оценку', editPoster: 'Сменить обложку',
  copyLink: 'Копировать ссылку', linkCopied: 'Ссылка скопирована', copyLinkFailed: 'Не удалось скопировать ссылку.',
  favorite: 'В избранное', unfavorite: 'Убрать из избранного', views: 'просмотров', fileSize: 'Размер файла',
  created: 'Добавлено', type: 'Тип', delete: 'В корзину', deleteConfirm: 'Переместить файл в корзину?',
  deleteText: 'Файл исчезнет из галереи. Восстановить его можно из корзины.', confirm: 'Подтвердить', cancel: 'Отмена',
  save: 'Сохранить', saved: 'Сохранено', title: 'Название', description: 'Описание', file: 'Файл',
  chooseFile: 'Выберите один файл', dropFile: 'Перетащите файл сюда',
  importHelp: 'Оригинал останется на месте. В медиатеку попадёт зашифрованная копия.',
  importTypeMismatch: 'Файл не подходит для этого раздела. Выберите один из указанных форматов.',
  emptyImportFile: 'Выбранный файл пуст.',
  uploadGif: 'Загрузить GIF', convertGif: 'Видео → GIF', convertAndImport: 'Преобразовать и добавить',
  gifConverting: 'Конвертация в GIF',
  gifVideoRequired: 'Для конвертации выберите видео одного из указанных форматов.',
  gifConversionHelp: 'Браузер преобразует видео целиком с исходным разрешением. GIF поддерживает до 256 цветов на кадр.',
  gifConversionError: 'Не удалось преобразовать видео целиком. Проверьте, поддерживает ли браузер кодек видео.',
  tagsHint: 'Например: природа, путешествие', tagsHelp: 'Разделяйте теги запятыми', encrypting: 'Завершаем шифрование и проверку…',
  uploading: 'Передача файла', imported: 'Файл добавлен в медиатеку', oneFile: 'Добавляйте по одному файлу за операцию.',
  password: 'Пароль', signIn: 'Войти', unlock: 'Разблокировать', locked: 'Медиатека заблокирована',
  lockedText: 'Введите пароль, чтобы вернуться к просмотру.', authTitle: 'Общая медиатека',
  authText: 'Войдите в свой аккаунт, чтобы открыть коллекцию, личные альбомы и рекомендации.',
  username: 'Логин', accountsByAdmin: 'Аккаунты создаёт администратор.',
  temporaryPassword: 'Временный пароль', temporaryPasswordPrompt: 'Задайте новый пароль из 12 символов или длиннее, чтобы открыть медиатеку.',
  weakPassword: 'Слабый пароль аккаунта. Измените его в настройках безопасности.', changePassword: 'Сменить пароль',
  appearance: 'Внешний вид', security: 'Безопасность', language: 'Язык интерфейса', gridColumns: 'Карточек в строке',
  gridHelp: 'На узком экране количество автоматически уменьшается.', animation: 'Длительность анимаций', milliseconds: 'мс',
  accent: 'Цвет акцента', afk: 'Блокировать при бездействии', minutes: 'мин', afkHelp: 'Таймер приостановлен, пока видео воспроизводится.',
  resetUi: 'Вернуть стандартные настройки', resetConfirm: 'Сбросить настройки интерфейса?', resetText: 'Файлы, пароли и данные медиатеки сохранятся.',
  currentPassword: 'Текущий пароль', newPassword: 'Новый пароль', confirmPassword: 'Повторите новый пароль',
  passwordsMismatch: 'Новые пароли не совпадают.',
  passwordMustDiffer: 'Новый пароль должен отличаться от текущего.',
  passwordHelp: 'Не менее 12 символов.', passwordChanged: 'Пароль изменён',
  trash: 'Корзина', trashEmpty: 'Корзина пуста', trashEmptyText: 'Удалённые файлы появятся здесь.', restore: 'Восстановить', restored: 'Файл восстановлен',
  accountAccess: 'Доступ по аккаунту',
  preparingVideo: 'Подготавливаем видео…',
  videoUnavailable: 'Браузер не смог воспроизвести видео. Возможно, кодек пока не поддерживается.',
  imageUnavailable: 'Не удалось открыть изображение.',
  mediaUnavailable: 'Файл недоступен или удалён.',
  more: 'Ещё', filtersActive: 'активных фильтров', ratingInvalid: 'Оценка должна быть целым числом от 1 до 10000.',
  connectionError: 'Не удалось подключиться к сайту. Проверьте соединение и попробуйте ещё раз.',
  generalError: 'Не удалось выполнить действие. Попробуйте ещё раз.', wrongPassword: 'Неверный логин или пароль.',
  duplicate: 'Этот файл уже есть в медиатеке.', unsupported: 'Формат файла не поддерживается или его содержимое повреждено.',
  forbidden: 'Недостаточно прав для этого действия.', adminLocalOnly: 'Admin может войти только на компьютере с сервером через локальный адрес 127.0.0.1.', rateLimited: 'Слишком много попыток. Подождите немного.',
  cancelled: 'Импорт отменён.', invalidPassword: 'Проверьте текущий пароль и длину нового пароля.',
  selectFileError: 'Сначала выберите файл.', account: 'Аккаунт', importBusy: 'Другой файл уже импортируется. Дождитесь завершения.',
  storageError: 'Хранилище медиатеки недоступно. Попробуйте позже.', corruptMedia: 'Не удалось проверить целостность файла. Открытие остановлено.',
  sessionError: 'Сессия устарела. Обновите страницу и войдите снова.', invalidSettings: 'Проверьте допустимые значения настроек.', incompleteUpload: 'Передача файла не завершена. Попробуйте импорт ещё раз.',
};
type Strings = { [Key in keyof typeof ru]: string };
const en: Strings = {
  library: 'Library', privateLibrary: 'Private media library', home: 'Home', video: 'Videos', photo: 'Photos', gif: 'GIFs',
  recommendations: 'Recommendations', albums: 'Albums', favorites: 'Favorites', history: 'History', settings: 'Settings',
  lock: 'Lock library', logout: 'Sign out', import: 'Add a file', importShort: 'Add', search: 'Search your library',
  searchHint: 'Title, description, or tag', tags: 'Tags', clearFilters: 'Clear filters', filters: 'Search & filters',
  include: 'Include', exclude: 'Exclude', neutral: 'Ignore', noTags: 'No tags available',
  searchTags: 'Search tags', noMatchingTags: 'No matching tags',
  allFiles: 'Total files', allMedia: 'All files', storage: 'In your library', connected: 'Connected', disconnected: 'No connection', encrypted: 'Encrypted storage',
  welcome: 'Your space. Your collection.', welcomeText: 'Your favorite moments, together. Choose what to explore today.',
  gifDescription: 'Little moments in motion', videoDescription: 'Stories worth coming back to', photoDescription: 'Moments that stay with you',
  openCategory: 'Open category', collection: 'Collection', noMedia: 'Your collection starts here',
  noMediaText: 'Add your first file. A copy will be stored in your encrypted library.', noUserMediaText: 'No files yet. An administrator can add them to the library.',
  noResults: 'No matches found', noResultsText: 'Try another search or remove a filter.', noFavorites: 'No favorites yet',
  noFavoritesText: 'Tap the heart on a file you like to find it here.', noHistory: 'No history yet',
  noHistoryText: 'Your recently opened files in this category will appear here.',
  newFirst: 'Newest first', byRating: 'By rating', byTitle: 'By title', shuffle: 'Refresh selection', randomOrder: 'Random order', sortOrder: 'Sort order',
  loadMore: 'Load more', loading: 'Loading…', retry: 'Try again', close: 'Close', back: 'Back',
  backGallery: 'Back to gallery', rating: 'Rating', unrated: 'Not rated', clearRating: 'Clear rating', editPoster: 'Change cover',
  copyLink: 'Copy link', linkCopied: 'Link copied', copyLinkFailed: 'Could not copy the link.',
  favorite: 'Add to favorites', unfavorite: 'Remove from favorites', views: 'views', fileSize: 'File size',
  created: 'Added', type: 'Type', delete: 'Move to trash', deleteConfirm: 'Move this file to trash?',
  deleteText: 'The file will leave the gallery. You can restore it from the trash.', confirm: 'Confirm', cancel: 'Cancel',
  save: 'Save', saved: 'Saved', title: 'Title', description: 'Description', file: 'File',
  chooseFile: 'Choose one file', dropFile: 'Drop a file here',
  importHelp: 'Your original stays where it is. An encrypted copy is added to the library.',
  importTypeMismatch: 'This file is not allowed in this section. Choose one of the listed formats.',
  emptyImportFile: 'The selected file is empty.',
  uploadGif: 'Upload GIF', convertGif: 'Video → GIF', convertAndImport: 'Convert and add',
  gifConverting: 'Converting to GIF',
  gifVideoRequired: 'Choose a video in one of the listed formats to convert it to GIF.',
  gifConversionHelp: 'Your browser converts the entire video at its original resolution. GIF supports up to 256 colors per frame.',
  gifConversionError: 'Could not convert the full video. Check whether your browser supports the video codec.',
  tagsHint: 'For example: nature, travel', tagsHelp: 'Separate tags with commas', encrypting: 'Finishing encryption and verification…',
  uploading: 'Uploading file', imported: 'File added to your library', oneFile: 'Add one file at a time.',
  password: 'Password', signIn: 'Sign in', unlock: 'Unlock', locked: 'Your library is locked',
  lockedText: 'Enter your password to return to the collection.', authTitle: 'Shared media library',
  authText: 'Sign in to open the collection, your private albums, and your recommendations.',
  username: 'Username', accountsByAdmin: 'The administrator creates accounts.',
  temporaryPassword: 'Temporary password', temporaryPasswordPrompt: 'Set a new password of at least 12 characters to open the library.',
  weakPassword: 'Your account password is weak. Change it in security settings.', changePassword: 'Change password',
  appearance: 'Appearance', security: 'Security', language: 'Interface language', gridColumns: 'Cards per row',
  gridHelp: 'The number adjusts automatically on smaller screens.', animation: 'Animation duration', milliseconds: 'ms',
  accent: 'Accent color', afk: 'Lock when inactive for', minutes: 'min', afkHelp: 'The timer pauses while a video is playing.',
  resetUi: 'Restore default settings', resetConfirm: 'Reset interface settings?', resetText: 'Your files, passwords, and library data will be preserved.',
  currentPassword: 'Current password', newPassword: 'New password', confirmPassword: 'Repeat new password',
  passwordsMismatch: 'The new passwords do not match.',
  passwordMustDiffer: 'Choose a password that differs from your current one.',
  passwordHelp: 'At least 12 characters.', passwordChanged: 'Password changed',
  trash: 'Trash', trashEmpty: 'Trash is empty', trashEmptyText: 'Deleted files will appear here.', restore: 'Restore', restored: 'File restored',
  accountAccess: 'Account access',
  preparingVideo: 'Preparing video…',
  videoUnavailable: 'This video could not be played. Its codec may not be supported yet.',
  imageUnavailable: 'The image could not be opened.',
  mediaUnavailable: 'This file is unavailable or has been deleted.',
  more: 'More', filtersActive: 'active filters', ratingInvalid: 'Rating must be a whole number from 1 to 10000.',
  connectionError: 'Could not connect to the site. Check your connection and try again.',
  generalError: 'The action could not be completed. Please try again.', wrongPassword: 'Incorrect username or password.',
  duplicate: 'This file is already in your library.', unsupported: 'This file format is unsupported or its contents are damaged.',
  forbidden: 'You do not have permission to perform this action.', adminLocalOnly: 'Admin can sign in only on the server computer using the local address 127.0.0.1.', rateLimited: 'Too many attempts. Please wait a moment.',
  cancelled: 'Import cancelled.', invalidPassword: 'Check the current password and the length of the new one.',
  selectFileError: 'Choose a file first.', account: 'Account', importBusy: 'Another file is being imported. Wait for it to finish.',
  storageError: 'Library storage is unavailable. Please try again later.', corruptMedia: 'File integrity could not be verified. Opening has been stopped.',
  sessionError: 'Your session has expired. Reload the page and sign in again.', invalidSettings: 'Check the allowed settings values.', incompleteUpload: 'The upload did not finish. Try importing the file again.',
};
export function strings(language: Language) { return language === 'en' ? en : ru; }
export type T = Strings;
export function errorMessage(error: unknown, t: Strings) {
  if (!(error instanceof ApiError)) return t.connectionError;
  const code = error.code.toLowerCase();
  if (code.includes('import_busy')) return t.importBusy;
  if (code.includes('duplicate')) return t.duplicate;
  if (code === 'media_type_mismatch') return t.importTypeMismatch;
  if (error.status === 415 || code.includes('unsupported') || code.includes('signature')) return t.unsupported;
  if (code.includes('single_file')) return t.oneFile;
  if (code.includes('incomplete_upload')) return t.incompleteUpload;
  if (code.includes('invalid_rating')) return t.ratingInvalid;
  if (code.includes('invalid_settings')) return t.invalidSettings;
  if (code.includes('storage_unavailable')) return t.storageError;
  if (code.includes('corrupt_media')) return t.corruptMedia;
  if (code === 'admin_local_only') return t.adminLocalOnly;
  if (code.includes('invalid_csrf') || code.includes('invalid_origin') || code.includes('invalid_host')) return t.sessionError;
  if (error.status === 403) return t.forbidden;
  if (error.status === 429) return t.rateLimited;
  if (error.status === 401 || code.includes('password') || code.includes('credentials')) return t.wrongPassword;
  if (code.includes('cancel')) return t.cancelled;
  if (error.status === 0) return t.connectionError;
  return t.generalError;
}
