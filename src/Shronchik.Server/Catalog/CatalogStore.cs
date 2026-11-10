using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Shronchik.Server.Tags;

namespace Shronchik.Server.Catalog;

/// <summary>
/// SQLCipher catalog. A connection owns its key for one operation only; pooling is
/// deliberately disabled, and SQLite temporary sorting data stays in memory.
/// </summary>
public sealed partial class CatalogStore(string libraryRoot, Guid libraryId, TagDictionary? tagDictionary = null)
{
    private const int SchemaVersion = 4;
    private const string LegacyUserId = "User";
    private const int MaximumPageSize = 150;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly Lazy<bool> NativeReady = new(() =>
    {
        SQLitePCL.Batteries_V2.Init();
        return true;
    });
    private readonly string _path = Path.Combine(Path.GetFullPath(libraryRoot), "db", "catalog.sqlite");

    public async Task InitializeAsync(byte[] masterKey, CancellationToken ct = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var existed = File.Exists(_path);
        if (existed && new FileInfo(_path).Length == 0)
            throw new InvalidDataException("Existing catalog is empty or incomplete.");
        await using var connection = await OpenAsync(masterKey, create: !existed, ct);
        var version = Convert.ToInt32(await ScalarAsync(connection, "PRAGMA user_version;", ct), CultureInfo.InvariantCulture);
        if (version == 0)
        {
            var tableCount = Convert.ToInt64(await ScalarAsync(connection,
                "SELECT count(*) FROM sqlite_master WHERE type='table';", ct), CultureInfo.InvariantCulture);
            if (existed || tableCount != 0)
                throw new InvalidDataException("Existing catalog has no supported schema version.");
            using var transaction = connection.BeginTransaction();
            await ExecuteAsync(connection, SchemaSql, ct, transaction);
            await using (var metadata = connection.CreateCommand())
            {
                metadata.Transaction = transaction;
                metadata.CommandText = "INSERT INTO metadata(key,value) VALUES('library_id',$id);";
                metadata.Parameters.AddWithValue("$id", libraryId.ToString("N"));
                await metadata.ExecuteNonQueryAsync(ct);
            }
            transaction.Commit();
        }
        else if (version is not (1 or 2 or 3 or SchemaVersion))
            throw new InvalidDataException("Unsupported catalog schema version.");

        await using (var identity = connection.CreateCommand())
        {
            identity.CommandText = "SELECT value FROM metadata WHERE key='library_id';";
            if (await identity.ExecuteScalarAsync(ct) is not string storedId || storedId != libraryId.ToString("N"))
                throw new InvalidDataException("Catalog belongs to a different library.");
        }
        if (!string.Equals(await ScalarAsync(connection, "PRAGMA quick_check;", ct) as string,
                "ok", StringComparison.Ordinal))
            throw new InvalidDataException("Catalog integrity check failed.");
        var mode = await ScalarAsync(connection, "PRAGMA journal_mode=WAL;", ct) as string;
        if (!string.Equals(mode, "wal", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Encrypted catalog WAL mode is unavailable.");
        if (version is 1 or 2)
            await MigratePersonalDataAsync(connection, ct);
        if (version is 1 or 2 or 3)
            await MigrateRatingsAndSettingsAsync(connection, ct);
        await MigrateTagDictionaryAsync(connection, ct);
    }

    private static async Task MigratePersonalDataAsync(SqliteConnection connection, CancellationToken ct)
    {
        using var transaction = connection.BeginTransaction();
        // Concurrent logins may have both seen the old version before acquiring the write lock.
        var version = Convert.ToInt32(await ScalarAsync(connection, "PRAGMA user_version;", ct, transaction),
            CultureInfo.InvariantCulture);
        if (version is 3 or SchemaVersion) return;
        if (version is not (1 or 2)) throw new InvalidDataException("Unsupported catalog schema version.");

        if (version == 1)
        {
            // v1 mixed Admin and User opens. Only playback events reliably belong to User.
            await ExecuteAsync(connection, """
                DELETE FROM recent_opened;
                INSERT INTO recent_opened(media_id,type,opened_at)
                SELECT events.media_id,'video',max(events.occurred_at) AS last_play
                FROM view_events events JOIN media ON media.id=events.media_id
                WHERE media.type='video'
                GROUP BY events.media_id
                ORDER BY last_play DESC,events.media_id DESC
                LIMIT 10;
                """, ct, transaction);
        }

        await ExecuteAsync(connection, """
            ALTER TABLE recent_opened RENAME TO recent_opened_legacy;
            ALTER TABLE view_events RENAME TO view_events_legacy;
            """, ct, transaction);
        await ExecuteAsync(connection, PersonalSchemaSql, ct, transaction);
        await using var copy = connection.CreateCommand();
        copy.Transaction = transaction;
        copy.CommandText = """
            INSERT INTO recent_opened(user_id,media_id,type,opened_at)
            SELECT $legacy,media_id,type,opened_at FROM recent_opened_legacy;
            INSERT INTO view_events(id,user_id,media_id,occurred_at)
            SELECT id,$legacy,media_id,occurred_at FROM view_events_legacy;
            DROP TABLE recent_opened_legacy;
            DROP TABLE view_events_legacy;
            PRAGMA user_version=3;
            """;
        copy.Parameters.AddWithValue("$legacy", LegacyUserId);
        await copy.ExecuteNonQueryAsync(ct);
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    public Task<MediaPage> ListAsync(byte[] masterKey, MediaQuery query, string userId, CancellationToken ct = default) =>
        ListMediaAsync(masterKey, query, userId, albumId: null, ct);

    private async Task<MediaPage> ListMediaAsync(byte[] masterKey, MediaQuery query, string userId, Guid? albumId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(query);
        ValidateUserId(userId);
        var normalized = NormalizeQuery(query);
        var personalizedFeed = albumId is null && normalized.Type == "video"
            && normalized.Tab is "home" or "recommendations" && normalized.Sort == "random";
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var snapshot = connection.BeginTransaction(deferred: true);
        var scopeRevision = 0L;
        if (albumId is { } requestedAlbum)
            scopeRevision = await RequireAlbumAsync(connection, snapshot, userId, requestedAlbum, ct);
        else if (normalized.Tab == "history" || personalizedFeed)
            scopeRevision = await ActivityRevisionAsync(connection, snapshot, userId, ct);
        long catalogRevision;
        await using (var revisionCommand = connection.CreateCommand())
        {
            revisionCommand.Transaction = snapshot;
            revisionCommand.CommandText = "SELECT value FROM metadata WHERE key='catalog_revision';";
            catalogRevision = long.Parse((string)(await revisionCommand.ExecuteScalarAsync(ct)
                ?? throw new InvalidDataException("Missing catalog revision.")), CultureInfo.InvariantCulture);
        }
        var fingerprint = QueryFingerprint(normalized, userId, albumId, catalogRevision, scopeRevision);
        var offset = DecodeCursor(masterKey, normalized.Cursor, fingerprint);
        connection.CreateFunction("stable_rank", (string id, string seed) =>
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id + ":" + seed))), isDeterministic: true);
        await using var command = connection.CreateCommand();
        command.Transaction = snapshot;
        command.Parameters.AddWithValue("$user", userId);
        var conditions = new List<string> { "m.deleted_at IS NULL" };
        if (albumId is { } selectedAlbum)
        {
            command.Parameters.AddWithValue("$album", selectedAlbum.ToString("N"));
            conditions.Add("EXISTS (SELECT 1 FROM album_items ai WHERE ai.owner_id=$user AND ai.album_id=$album AND ai.media_id=m.id)");
        }
        if (normalized.Type.Length > 0)
        {
            conditions.Add("m.type=$type");
            command.Parameters.AddWithValue("$type", normalized.Type);
        }
        if (normalized.Query.Length > 0)
        {
            var matchingIds = tagDictionary?.AllIds.Where(id => tagDictionary.ExpandAliases(id).Any(alias => NormalizeText(alias).Contains(NormalizeText(normalized.Query)))).ToArray() ?? [];
            var matchedTags = matchingIds.Select((id, index) => TagCondition(command, id, $"search{index}", false)).ToArray();
            var dictionarySearch = matchedTags.Length == 0 ? "" : " OR " + string.Join(" OR ", matchedTags);
            conditions.Add("(instr(m.search_text,$query)>0 OR EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.normalized=mt.tag WHERE mt.media_id=m.id AND instr(t.normalized,$query)>0)" + dictionarySearch + ")");
            command.Parameters.AddWithValue("$query", NormalizeText(normalized.Query));
        }
        for (var i = 0; i < normalized.IncludeTags.Length; i++)
        {
            conditions.Add(TagCondition(command, normalized.IncludeTags[i], $"include{i}", false));
        }
        for (var i = 0; i < normalized.ExcludeTags.Length; i++)
        {
            conditions.Add(TagCondition(command, normalized.ExcludeTags[i], $"exclude{i}", true));
        }
        if (normalized.Tab == "favorites") conditions.Add("m.is_favorite=1");
        if (normalized.Tab == "history") conditions.Add("EXISTS (SELECT 1 FROM recent_opened r WHERE r.user_id=$user AND r.media_id=m.id)");
        var order = albumId is not null
            ? "(SELECT ai.added_at FROM album_items ai WHERE ai.owner_id=$user AND ai.album_id=$album AND ai.media_id=m.id) DESC,m.id DESC"
            : normalized.Tab == "history"
            ? "(SELECT r.opened_at FROM recent_opened r WHERE r.user_id=$user AND r.media_id=m.id) DESC,m.id DESC"
            : normalized.Sort switch
            {
                "rating_desc" => "m.rating IS NULL,m.rating DESC,m.id DESC",
                "rating_asc" => "m.rating IS NULL,m.rating ASC,m.id DESC",
                "name_asc" => "m.search_text ASC,m.id ASC",
                "date_asc" => "m.created_at ASC,m.id ASC",
                "date_desc" => "m.created_at DESC,m.id DESC",
                _ => "stable_rank(m.id,$seed),m.id"
            };
        command.Parameters.AddWithValue("$seed", normalized.Seed);
        command.Parameters.AddWithValue("$limit", normalized.Limit + 1);
        command.Parameters.AddWithValue("$offset", offset);
        command.CommandText = $"SELECT {MediaColumns} FROM media m WHERE {string.Join(" AND ", conditions)} ORDER BY {order} LIMIT $limit OFFSET $offset;";
        if (personalizedFeed)
        {
            var settings = await ReadSettingsAsync(connection, snapshot, userId, ct);
            ConfigureFeed(command, conditions, settings);
        }
        var items = await ReadItemsAsync(command, ct);
        var hasMore = items.Count > normalized.Limit;
        if (hasMore) items.RemoveAt(items.Count - 1);
        await FillTagsAsync(connection, items, ct, snapshot);
        snapshot.Commit();
        return new(items.ToArray(), hasMore ? EncodeCursor(masterKey, checked(offset + items.Count), fingerprint) : null, hasMore);
    }

    public Task<MediaItem?> GetAsync(byte[] masterKey, Guid id, CancellationToken ct = default) =>
        GetAsync(masterKey, id, "Admin", ct);

    public async Task<MediaItem?> GetAsync(byte[] masterKey, Guid id, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(masterKey, false, ct);
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT {MediaColumns} FROM media m WHERE m.id=$id AND m.deleted_at IS NULL;";
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        command.Parameters.AddWithValue("$user", userId);
        var items = await ReadItemsAsync(command, ct);
        await FillTagsAsync(connection, items, ct);
        return items.SingleOrDefault();
    }

    public async Task<string[]> TagsAsync(byte[] masterKey, CancellationToken ct = default)
    {
        await using var connection = await OpenAsync(masterKey, false, ct);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT t.name FROM tags t WHERE EXISTS (SELECT 1 FROM media_tags mt JOIN media m ON m.id=mt.media_id WHERE mt.tag=t.normalized AND m.deleted_at IS NULL) ORDER BY t.normalized;";
        var names = new List<string>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) names.Add(reader.GetString(0));
        return names.ToArray();
    }

    public async Task<object> HomeAsync(byte[] masterKey, CancellationToken ct = default)
    {
        await using var connection = await OpenAsync(masterKey, false, ct);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT type,count(*),coalesce(sum(size),0) FROM media WHERE deleted_at IS NULL GROUP BY type;";
        var counts = new Dictionary<string, (long Count, long Bytes)>(StringComparer.Ordinal);
        await using (var reader = await command.ExecuteReaderAsync(ct))
            while (await reader.ReadAsync(ct))
                counts[reader.GetString(0)] = (reader.GetInt64(1), reader.GetInt64(2));
        var categories = new[] { "gif", "video", "photo" }.Select(type =>
        {
            var values = counts.GetValueOrDefault(type);
            return new { type, count = values.Count, totalBytes = values.Bytes };
        }).ToArray();
        return new { totalCount = categories.Sum(c => c.count), totalBytes = categories.Sum(c => c.totalBytes), categories };
    }

    public async Task AddAsync(byte[] masterKey, MediaItem item, string sha256, CancellationToken ct = default)
    {
        ValidateItem(item);
        if (sha256 is null || !Sha256Pattern().IsMatch(sha256)) throw new ArgumentException("Invalid content hash.", nameof(sha256));
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await using (var duplicate = connection.CreateCommand())
        {
            duplicate.Transaction = transaction;
            duplicate.CommandText = "SELECT id FROM media WHERE sha256=$hash AND size=$size;";
            duplicate.Parameters.AddWithValue("$hash", sha256.ToLowerInvariant());
            duplicate.Parameters.AddWithValue("$size", item.Size);
            if (await duplicate.ExecuteScalarAsync(ct) is string existing)
                throw new DuplicateMediaException(Guid.ParseExact(existing, "N"));
        }
        await using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO media(id,type,title,description,search_text,rating,views,is_favorite,size,created_at,mime_type,sha256)
                VALUES($id,$type,$title,$description,$search,$rating,$views,$favorite,$size,$created,$mime,$hash);
                """;
            insert.Parameters.AddWithValue("$id", item.Id.ToString("N"));
            insert.Parameters.AddWithValue("$type", item.Type);
            insert.Parameters.AddWithValue("$title", item.Title);
            insert.Parameters.AddWithValue("$description", item.Description);
            insert.Parameters.AddWithValue("$search", NormalizeText(item.Title + "\n" + item.Description));
            insert.Parameters.AddWithValue("$rating", (object?)item.Rating ?? DBNull.Value);
            insert.Parameters.AddWithValue("$views", item.Views);
            insert.Parameters.AddWithValue("$favorite", item.IsFavorite ? 1 : 0);
            insert.Parameters.AddWithValue("$size", item.Size);
            insert.Parameters.AddWithValue("$created", item.CreatedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            insert.Parameters.AddWithValue("$mime", item.MimeType);
            insert.Parameters.AddWithValue("$hash", sha256.ToLowerInvariant());
            await insert.ExecuteNonQueryAsync(ct);
        }
        foreach (var tag in item.Tags.Select(t => t.Trim()).DistinctBy(NormalizeText))
        {
            await using var insertTag = connection.CreateCommand();
            insertTag.Transaction = transaction;
            insertTag.CommandText = "INSERT INTO tags(normalized,name) VALUES($tag,$name) ON CONFLICT(normalized) DO NOTHING; INSERT INTO media_tags(media_id,tag) VALUES($id,$tag);";
            insertTag.Parameters.AddWithValue("$tag", NormalizeText(tag));
            insertTag.Parameters.AddWithValue("$name", tag);
            insertTag.Parameters.AddWithValue("$id", item.Id.ToString("N"));
            await insertTag.ExecuteNonQueryAsync(ct);
        }
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    public async Task SetRatingAsync(byte[] masterKey, Guid id, string userId, int? rating, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        if (userId.Equals("Admin", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Administrators cannot rate media.", nameof(userId));
        ValidateRating(rating);
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await RequireLiveMediaAsync(connection, transaction, id, ct);
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$rating", (object?)rating ?? DBNull.Value);
        command.CommandText = rating is null
            ? "DELETE FROM user_ratings WHERE user_id=$user AND media_id=$id;"
            : """
                INSERT INTO user_ratings(user_id,media_id,rating) VALUES($user,$id,$rating)
                ON CONFLICT(user_id,media_id) DO UPDATE SET rating=excluded.rating;
                """;
        await command.ExecuteNonQueryAsync(ct);
        command.CommandText = "UPDATE media SET rating=(SELECT CAST(round(avg(rating)) AS INTEGER) FROM user_ratings WHERE media_id=$id) WHERE id=$id;";
        await command.ExecuteNonQueryAsync(ct);
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    public Task SetFavoriteAsync(byte[] masterKey, Guid id, bool favorite, CancellationToken ct = default) =>
        MutateAsync(masterKey, id, "UPDATE media SET is_favorite=$value WHERE id=$id AND deleted_at IS NULL;", favorite ? 1 : 0, ct);

    public async Task OpenedAsync(byte[] masterKey, Guid id, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO recent_opened(user_id,media_id,type,opened_at)
            SELECT $user,id,type,$now FROM media WHERE id=$id AND deleted_at IS NULL
            ON CONFLICT(user_id,media_id) DO UPDATE SET opened_at=excluded.opened_at;
            """;
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$now", UtcNow());
        if (await command.ExecuteNonQueryAsync(ct) == 0) throw new KeyNotFoundException("Media does not exist.");
        command.CommandText = """
            DELETE FROM recent_opened WHERE user_id=$user AND type=(SELECT type FROM media WHERE id=$id)
              AND media_id NOT IN (SELECT media_id FROM recent_opened WHERE user_id=$user AND type=(SELECT type FROM media WHERE id=$id)
                ORDER BY opened_at DESC,media_id DESC LIMIT 10);
            """;
        await command.ExecuteNonQueryAsync(ct);
        await BumpActivityRevisionAsync(connection, transaction, userId, ct);
        transaction.Commit();
    }

    public async Task RecordViewAsync(byte[] masterKey, Guid id, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE media SET views=views+1 WHERE id=$id AND deleted_at IS NULL;";
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        if (await command.ExecuteNonQueryAsync(ct) == 0) throw new KeyNotFoundException("Media does not exist.");
        command.CommandText = "INSERT INTO view_events(user_id,media_id,occurred_at) VALUES($user,$id,$now);";
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$now", UtcNow());
        await command.ExecuteNonQueryAsync(ct);
        await BumpActivityRevisionAsync(connection, transaction, userId, ct);
        transaction.Commit();
    }

    public async Task TrashAsync(byte[] masterKey, Guid id, CancellationToken ct = default)
    {
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE media SET deleted_at=coalesce(deleted_at,$now),purge_after=coalesce(purge_after,$purge) WHERE id=$id;";
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        var now = DateTimeOffset.UtcNow;
        command.Parameters.AddWithValue("$now", now.ToString("O", CultureInfo.InvariantCulture));
        var settings = await ReadSettingsAsync(connection, transaction, ct);
        command.Parameters.AddWithValue("$purge", now.AddDays(settings.TrashRetentionDays).ToString("O", CultureInfo.InvariantCulture));
        if (await command.ExecuteNonQueryAsync(ct) == 0) throw new KeyNotFoundException("Media does not exist.");
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    public Task RestoreAsync(byte[] masterKey, Guid id, CancellationToken ct = default) =>
        MutateAsync(masterKey, id, "UPDATE media SET deleted_at=NULL,purge_after=NULL WHERE id=$id;", null, ct);

    public async Task<MediaItem[]> TrashListAsync(byte[] masterKey, CancellationToken ct = default)
    {
        await using var connection = await OpenAsync(masterKey, false, ct);
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT {MediaColumns} FROM media m WHERE m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC,m.id DESC;";
        command.Parameters.AddWithValue("$user", "Admin");
        var items = await ReadItemsAsync(command, ct);
        await FillTagsAsync(connection, items, ct);
        return items.ToArray();
    }

    public async Task<UiSettings> GetSettingsAsync(byte[] masterKey, CancellationToken ct = default)
    {
        await using var connection = await OpenAsync(masterKey, false, ct);
        return await ReadSettingsAsync(connection, null, ct);
    }

    private static async Task<UiSettings> ReadSettingsAsync(SqliteConnection connection, SqliteTransaction? transaction, CancellationToken ct)
    {
        var serialized = await ScalarAsync(connection, "SELECT value FROM settings WHERE key='ui';", ct, transaction) as string;
        if (serialized is null) return new();
        var settings = JsonSerializer.Deserialize<UiSettings>(serialized, JsonOptions)
            ?? throw new InvalidDataException("Invalid UI settings.");
        ValidateSettings(settings);
        return settings with { SchemaVersion = UiSettings.CurrentSchemaVersion };
    }

    public async Task SaveSettingsAsync(byte[] masterKey, UiSettings settings, CancellationToken ct = default)
    {
        ValidateSettings(settings);
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO settings(key,value) VALUES('ui',$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value;";
        command.Parameters.AddWithValue("$value", JsonSerializer.Serialize(
            settings with { SchemaVersion = UiSettings.CurrentSchemaVersion }, JsonOptions));
        await command.ExecuteNonQueryAsync(ct);
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    private async Task MutateAsync(byte[] masterKey, Guid id, string sql, object? value, CancellationToken ct)
    {
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        if (value is not null) command.Parameters.AddWithValue("$value", value);
        if (await command.ExecuteNonQueryAsync(ct) == 0) throw new KeyNotFoundException("Media does not exist.");
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    private async Task<SqliteConnection> OpenAsync(byte[] masterKey, bool create, CancellationToken ct)
    {
        if (masterKey is null || masterKey.Length != 32) throw new ArgumentException("A 256-bit master key is required.", nameof(masterKey));
        _ = NativeReady.Value;
        var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, masterKey, 32, libraryId.ToByteArray(), "Shronchik/catalog/v1"u8.ToArray());
        SqliteConnection connection;
        try
        {
            connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = _path,
                Mode = create ? SqliteOpenMode.ReadWriteCreate : SqliteOpenMode.ReadWrite,
                Pooling = false,
                Cache = SqliteCacheMode.Private,
                Password = "x'" + Convert.ToHexString(key) + "'",
                DefaultTimeout = 5
            }.ToString());
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        try
        {
            await connection.OpenAsync(ct);
            if (await ScalarAsync(connection, "PRAGMA cipher_version;", ct) is not string cipherVersion || string.IsNullOrWhiteSpace(cipherVersion))
                throw new CryptographicException("SQLCipher is required; unencrypted SQLite is forbidden.");
            await ExecuteAsync(connection,
                "PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA cipher_memory_security=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;", ct);
            // Authenticate at least the schema page immediately. A wrong key never
            // falls back to creating or replacing a catalog.
            _ = await ScalarAsync(connection, "SELECT count(*) FROM sqlite_master;", ct);
            return connection;
        }
        catch { await connection.DisposeAsync(); throw; }
    }

    private static async Task<List<MediaItem>> ReadItemsAsync(SqliteCommand command, CancellationToken ct)
    {
        var items = new List<MediaItem>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            items.Add(new(Guid.ParseExact(reader.GetString(0), "N"), reader.GetString(1), reader.GetString(2),
                reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetInt32(4), reader.GetInt64(5),
                reader.GetInt64(6) != 0, reader.GetInt64(7),
                DateTimeOffset.ParseExact(reader.GetString(8), "O", CultureInfo.InvariantCulture), [], reader.GetString(9))
                { UserRating = reader.IsDBNull(10) ? null : reader.GetInt32(10), RatingCount = reader.GetInt32(11) });
        return items;
    }

    private static async Task FillTagsAsync(SqliteConnection connection, List<MediaItem> items, CancellationToken ct,
        SqliteTransaction? transaction = null)
    {
        // Bounded batches also cover the administrative trash list without exceeding
        // SQLite's native parameter limit.
        for (var start = 0; start < items.Count; start += MaximumPageSize)
        {
            var end = Math.Min(start + MaximumPageSize, items.Count);
            var tags = new Dictionary<Guid, List<string>>();
            await using var command = connection.CreateCommand();
            command.Transaction = transaction;
            var parameters = new List<string>();
            for (var i = start; i < end; i++)
            {
                var parameter = "$id" + (i - start).ToString(CultureInfo.InvariantCulture);
                parameters.Add(parameter);
                command.Parameters.AddWithValue(parameter, items[i].Id.ToString("N"));
                tags[items[i].Id] = [];
            }
            command.CommandText = $"SELECT mt.media_id,t.name FROM media_tags mt JOIN tags t ON t.normalized=mt.tag WHERE mt.media_id IN ({string.Join(',', parameters)}) ORDER BY t.normalized;";
            await using (var reader = await command.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct))
                    tags[Guid.ParseExact(reader.GetString(0), "N")].Add(reader.GetString(1));
            for (var i = start; i < end; i++) items[i] = items[i] with { Tags = tags[items[i].Id].ToArray() };
        }
    }

    private static async Task<object?> ScalarAsync(SqliteConnection connection, string sql, CancellationToken ct,
        SqliteTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        return await command.ExecuteScalarAsync(ct);
    }

    private static async Task ExecuteAsync(SqliteConnection connection, string sql, CancellationToken ct,
        SqliteTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        await command.ExecuteNonQueryAsync(ct);
    }

    private static string UtcNow() => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
    private static string NormalizeText(string text) => text.Trim().Normalize(NormalizationForm.FormKC).ToUpperInvariant();

    private static MediaQuery NormalizeQuery(MediaQuery query)
    {
        var type = (query.Type ?? "").Trim().ToLowerInvariant();
        if (type == "all") type = "";
        if (type is not ("" or "video" or "photo" or "gif")) throw new ArgumentException("Invalid media type.");
        var text = (query.Query ?? "").Trim();
        if (text.Length > 512) throw new ArgumentException("Search query is too long.");
        var tab = (query.Tab ?? "home").ToLowerInvariant();
        if (tab is not ("home" or "recommendations" or "favorites" or "history")) throw new ArgumentException("Invalid gallery tab.");
        var sort = (query.Sort ?? "random").ToLowerInvariant();
        if (sort is "newest" or "recent") sort = "date_desc";
        if (sort is "rating") sort = "rating_desc";
        if (sort is "title") sort = "name_asc";
        if (sort is not ("random" or "date_desc" or "date_asc" or "rating_desc" or "rating_asc" or "name_asc")) throw new ArgumentException("Invalid media sort.");
        var seed = query.Seed ?? "";
        if (seed.Length > 128) throw new ArgumentException("Invalid random seed.");
        return query with
        {
            Type = type, Query = text, Tab = tab, Sort = sort, Seed = seed,
            IncludeTags = NormalizeFilterTags(query.IncludeTags), ExcludeTags = NormalizeFilterTags(query.ExcludeTags),
            Limit = Math.Clamp(query.Limit, 1, MaximumPageSize)
        };
    }

    private static string[] NormalizeFilterTags(string[]? tags)
    {
        if (tags is null) return [];
        if (tags.Length > 100 || tags.Any(t => string.IsNullOrWhiteSpace(t) || t.Length > 128))
            throw new ArgumentException("Invalid tag filter.");
        return tags.Select(NormalizeText).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
    }

    private static byte[] QueryFingerprint(MediaQuery query, string userId, Guid? albumId, long catalogRevision, long scopeRevision) =>
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            query.Type, query.Query, query.IncludeTags, query.ExcludeTags, query.Tab, query.Sort, query.Seed,
            query.Limit, userId, albumId, catalogRevision, scopeRevision
        }));

    private static Task BumpRevisionAsync(SqliteConnection connection, SqliteTransaction transaction, CancellationToken ct) =>
        ExecuteAsync(connection, "UPDATE metadata SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='catalog_revision';", ct, transaction);

    private string EncodeCursor(byte[] masterKey, long offset, byte[] fingerprint)
    {
        var bytes = new byte[73];
        bytes[0] = 1;
        BinaryPrimitives.WriteInt64BigEndian(bytes.AsSpan(1), offset);
        fingerprint.CopyTo(bytes, 9);
        var key = CursorKey(masterKey);
        try { HMACSHA256.HashData(key, bytes.AsSpan(0, 41)).CopyTo(bytes, 41); }
        finally { CryptographicOperations.ZeroMemory(key); }
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private long DecodeCursor(byte[] masterKey, string? cursor, byte[] fingerprint)
    {
        if (string.IsNullOrEmpty(cursor)) return 0;
        if (cursor.Length > 128) throw new ArgumentException("Invalid gallery cursor.");
        byte[] bytes;
        try
        {
            var base64 = cursor.Replace('-', '+').Replace('_', '/');
            bytes = Convert.FromBase64String(base64.PadRight((base64.Length + 3) / 4 * 4, '='));
        }
        catch (FormatException) { throw new ArgumentException("Invalid gallery cursor."); }
        if (bytes.Length != 73 || bytes[0] != 1 || !CryptographicOperations.FixedTimeEquals(bytes.AsSpan(9, 32), fingerprint))
            throw new ArgumentException("Gallery cursor does not match the query.");
        var key = CursorKey(masterKey);
        try
        {
            var mac = HMACSHA256.HashData(key, bytes.AsSpan(0, 41));
            if (!CryptographicOperations.FixedTimeEquals(mac, bytes.AsSpan(41, 32))) throw new ArgumentException("Invalid gallery cursor.");
        }
        finally { CryptographicOperations.ZeroMemory(key); }
        var offset = BinaryPrimitives.ReadInt64BigEndian(bytes.AsSpan(1));
        if (offset < 0) throw new ArgumentException("Invalid gallery cursor.");
        return offset;
    }

    private byte[] CursorKey(byte[] masterKey)
    {
        if (masterKey is null || masterKey.Length != 32) throw new ArgumentException("A 256-bit master key is required.", nameof(masterKey));
        return HKDF.DeriveKey(HashAlgorithmName.SHA256, masterKey, 32, libraryId.ToByteArray(), "Shronchik/catalog-cursor/v1"u8.ToArray());
    }

    private static void ValidateItem(MediaItem item)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (item.Id == Guid.Empty || item.Type is not ("video" or "photo" or "gif") || item.Size < 0 || item.Views < 0)
            throw new ArgumentException("Invalid media metadata.");
        if (item.Title is null || item.Title.Length > 512 || item.Description is null || item.Description.Length > 10000
            || string.IsNullOrWhiteSpace(item.MimeType) || item.MimeType.Length > 128)
            throw new ArgumentException("Invalid media text metadata.");
        if (item.Tags is null || item.Tags.Length > 1000 || item.Tags.Any(t => string.IsNullOrWhiteSpace(t) || t.Length > 128))
            throw new ArgumentException("Invalid media tags.");
        ValidateRating(item.Rating);
    }

    private static void ValidateRating(int? rating)
    {
        if (rating is < 1 or > 10000) throw new ArgumentOutOfRangeException(nameof(rating), "Rating must be absent or between 1 and 10000.");
    }

    private static void ValidateSettings(UiSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        string?[] colors = [settings.AccentColor, settings.BackgroundColor, settings.SurfaceColor,
            settings.TextColor, settings.MutedTextColor];
        if (settings.SchemaVersion is not (1 or UiSettings.CurrentSchemaVersion)
            || settings.Language is not ("ru" or "en")
            || settings.Theme is not ("custom_dark" or "midnight" or "light")
            || colors.Any(color => color is null || !HexColorPattern().IsMatch(color))
            || !InRange(settings.ShadowStrength, 0, 1) || !InRange(settings.HoverNeighborDim, 0, 0.6)
            || settings.CardRadiusPx is < 0 or > 30 || settings.AnimationMs is < 0 or > 1000
            || settings.ReduceMotion is not ("auto" or "on" or "off")
            || settings.GridColumns is < 2 or > 20 || settings.GridGapPx is < 2 or > 32
            || settings.CardAspectRatio is not ("16:9" or "4:3" or "1:1")
            || settings.CardTitleLines is < 1 or > 3 || !InRange(settings.FontScale, 0.8, 1.4)
            || !InRange(settings.Volume, 0, 1) || settings.SeekSeconds is < 1 or > 30
            || settings.HoverDelayMs is < 0 or > 1200 || settings.ThumbnailCandidates is < 3 or > 12
            || settings.GifVisibilityMarginPx is < 0 or > 300 || settings.MaxAnimatedCards is < 1 or > 40
            || settings.GpuDecodePreference is not ("auto" or "on" or "off")
            || settings.RamCacheMB is < 128 or > 4096
            || settings.RatedPercent is < 0 or > 100 || settings.MinimumRating is < 1 or > 10000
            || !InRange(settings.RatingWeight, 0, 1) || settings.RelatedCount is < 0 or > 30
            || settings.RandomRelatedCount is < 0 or > 30 || settings.QueryDebounceMs is < 0 or > 600
            || settings.PageBatchSize is < 20 or > 150 || settings.AfkMinutes is < 1 or > 120
            || settings.TrashRetentionDays is < 1 or > 365 || settings.VerifyOnStartup is not ("quick" or "full")
            || settings.BackupReminderDays is < 0 or > 90 || settings.WorkerConcurrency is < 1 or > 8
            || settings.MaxTranscodes is < 1 or > 3 || settings.FfmpegThreads is < 0 or > 32
            || settings.LowDiskWarningGB is < 0 or > 1000)
            throw new ArgumentException("Invalid UI settings.");
        ValidateHotkeys(settings.Hotkeys);
    }

    private static bool InRange(double value, double min, double max) => double.IsFinite(value) && value >= min && value <= max;

    private static void ValidateHotkeys(HotkeySettings hotkeys)
    {
        ArgumentNullException.ThrowIfNull(hotkeys);
        string[] global = [hotkeys.GoHome, hotkeys.Lock];
        string[] player = [hotkeys.PlayPause, hotkeys.SeekBackward, hotkeys.SeekForward, hotkeys.VolumeUp,
            hotkeys.VolumeDown, hotkeys.ToggleFullscreen, hotkeys.ExitFullscreen, hotkeys.ToggleMute];
        string[] gallery = [hotkeys.ToggleFilters];
        string[] photo = [hotkeys.NextMedia, hotkeys.PreviousMedia];
        foreach (var group in new[] { player, gallery, photo })
        {
            var assigned = global.Concat(group).Where(value => value != "").ToArray();
            if (assigned.Any(value => value is null || !HotkeyPattern().IsMatch(value) || ReservedHotkeys.Contains(value))
                || assigned.Distinct(StringComparer.Ordinal).Count() != assigned.Length)
                throw new ArgumentException("Invalid or conflicting keyboard shortcut.");
        }
    }

    private static readonly HashSet<string> ReservedHotkeys = new(StringComparer.Ordinal)
    {
        "Alt+F4", "Ctrl+W", "Ctrl+Shift+W", "Ctrl+L", "Ctrl+R", "Ctrl+T", "Ctrl+Shift+T",
        "Ctrl+N", "Ctrl+Shift+N", "Ctrl+P", "Ctrl+S", "Ctrl+O", "F5", "F11", "F12"
    };

    [GeneratedRegex("^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();
    [GeneratedRegex("\\A#[0-9a-fA-F]{6}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex HexColorPattern();
    [GeneratedRegex("\\A(?:Ctrl\\+)?(?:Alt\\+)?(?:Shift\\+)?(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space|Escape|Enter|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right))\\z", RegexOptions.CultureInvariant)]
    private static partial Regex HotkeyPattern();

    private const string MediaColumns = """
        m.id,m.type,m.title,m.description,m.rating,m.views,m.is_favorite,m.size,m.created_at,m.mime_type,
        (SELECT r.rating FROM user_ratings r WHERE r.media_id=m.id AND r.user_id=$user),
        (SELECT count(*) FROM user_ratings r WHERE r.media_id=m.id)
        """;
    private const string SchemaSql = """
        CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
        INSERT INTO metadata(key,value) VALUES('catalog_revision','0');
        CREATE TABLE media(
          id TEXT PRIMARY KEY,type TEXT NOT NULL CHECK(type IN('video','photo','gif')),
          title TEXT NOT NULL,description TEXT NOT NULL,search_text TEXT NOT NULL,
          rating INTEGER CHECK(rating BETWEEN 1 AND 10000),views INTEGER NOT NULL CHECK(views>=0),
          is_favorite INTEGER NOT NULL CHECK(is_favorite IN(0,1)),size INTEGER NOT NULL CHECK(size>=0),
          created_at TEXT NOT NULL,mime_type TEXT NOT NULL,sha256 TEXT NOT NULL,
          deleted_at TEXT,purge_after TEXT,UNIQUE(sha256,size)
        ) STRICT;
        CREATE INDEX ix_media_type_date ON media(type,deleted_at,created_at DESC,id DESC);
        CREATE INDEX ix_media_type_rating ON media(type,deleted_at,rating DESC,id DESC);
        CREATE INDEX ix_media_favorite ON media(is_favorite,deleted_at,type);
        CREATE TABLE tags(normalized TEXT PRIMARY KEY,name TEXT NOT NULL) STRICT;
        CREATE TABLE media_tags(
          media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
          tag TEXT NOT NULL REFERENCES tags(normalized),PRIMARY KEY(media_id,tag)
        ) STRICT;
        CREATE INDEX ix_media_tags_tag ON media_tags(tag,media_id);
        CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
        PRAGMA user_version=4;
        """ + PersonalSchemaSql + RatingsSchemaSql;
}
