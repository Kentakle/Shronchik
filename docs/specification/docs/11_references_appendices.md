# Источники и приложения

> Часть технической документации Shronchik v1.1. Полный документ: [Shronchik_Technical_Spec_v1.1.md](../Shronchik_Technical_Spec_v1.1.md).

# Приложение А. Нормативные и технические источники

Ниже приведены основные первичные источники, на которых основаны именно **технические рекомендации**. Пользовательские требования получены напрямую из обсуждения и иллюстраций и отдельного источника не требуют. URL даны для проверки при реализации; конкретные версии компонентов и лицензии необходимо перепроверять при сборке релиза.

1. **Microsoft, .NET 10 и политика поддержки:** https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core
2. **Microsoft, распространение WebView2 Runtime:** https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
3. **SQLite, ограничения WAL и сетевых файловых систем:** https://www.sqlite.org/wal.html
4. **SQLite, Online Backup API:** https://www.sqlite.org/backup.html
5. **OWASP, Password Storage Cheat Sheet (Argon2id):** https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
6. **OWASP, Cryptographic Storage Cheat Sheet:** https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
7. **OWASP, Session Management Cheat Sheet:** https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
8. **NIST SP 800-38D, GCM/GMAC:** https://csrc.nist.gov/pubs/sp/800/38/d/final
9. **MDN, HTTP Range requests:** https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests
10. **Google Cast, Web Sender и HTTPS:** https://developers.google.com/cast/docs/web_sender
11. **Google Cast, CORS и Media Info:** https://developers.google.com/cast/docs/web_sender/advanced
12. **Google Cast, поддерживаемые медиа и потоки:** https://developers.google.com/cast/docs/media
13. **FFmpeg, лицензии LGPL/GPL:** https://ffmpeg.org/legal.html
14. **SQLCipher, официальный проект:** https://www.zetetic.net/sqlcipher/

# Приложение Б. Тестовые данные и нейтральный контент

Для разработки и GitHub всегда использовать **синтетический/свободный от личных медиа набор**: фотографии природы, абстрактные GIF, короткие демонстрационные видео с разрешённой лицензией, битые файлы, файлы с одинаковым содержимым, видео с разными кодеками и метаданными. Для performance-тестов генерировать фиктивные записи БД вместо хранения 20 ТБ тестового видео. Личные файлы владельца не отправлять в CI, публичные репозитории или issue-трекер.

# Приложение В. История решений (ADR-заготовки)

| ADR | Решение | Статус |
|---|---|---|
| ADR-001 | Web UI React/TypeScript + локальный ASP.NET Core, WebView2 Windows shell | Предложено |
| ADR-002 | SQLite индексированная БД, SQLCipher для шифрования метаданных | Предложено |
| ADR-003 | Файловый `SRM1` контейнер AES-GCM по отдельным блокам | Предложено |
| ADR-004 | Реальный просмотр User фиксировать при первом Play за открытие | Согласовано |
| ADR-005 | NAS как storage для шифрованных медиа, БД преимущественно на локальном SSD | Предложено |
| ADR-006 | Интерфейс/данные/ключи обновляются независимо | Согласовано по целям |
| ADR-007 | Google Cast — отдельный модуль с security-проверкой | Предложено |

**Итог:** документ является подробной проектной базой для Shronchik, а не подтверждением реализации. Согласованные уточнения v1.1 включены; оставшиеся вопросы не блокируют создание локального прототипа. Пройти этапы локальной разработки и тестирования, затем по отдельному решению рассматривать GitHub, Cast и веб-хостинг.

