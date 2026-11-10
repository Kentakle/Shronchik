using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Shronchik.Server.Catalog;

public sealed partial class CatalogStore
{
    public async Task DeletePersonalDataAsync(byte[] key, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(key, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE media SET rating=(SELECT CAST(round(avg(rating)) AS INTEGER) FROM user_ratings r WHERE r.media_id=media.id AND r.user_id<>$user)
              WHERE id IN(SELECT media_id FROM user_ratings WHERE user_id=$user);
            DELETE FROM user_ratings WHERE user_id=$user;
            DELETE FROM settings WHERE key='user:' || $user;
            DELETE FROM albums WHERE owner_id=$user;
            DELETE FROM recent_opened WHERE user_id=$user;
            DELETE FROM view_events WHERE user_id=$user;
            DELETE FROM user_activity WHERE user_id=$user;
            """;
        command.Parameters.AddWithValue("$user", userId);
        await command.ExecuteNonQueryAsync(ct);
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    private const string PersonalSchemaSql = """
        CREATE TABLE recent_opened(
          user_id TEXT NOT NULL,media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN('video','photo','gif')),opened_at TEXT NOT NULL,
          PRIMARY KEY(user_id,media_id)
        ) STRICT;
        CREATE INDEX ix_recent_user_type_time ON recent_opened(user_id,type,opened_at DESC,media_id DESC);
        CREATE TABLE view_events(
          id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,
          media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,occurred_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX ix_views_user_time ON view_events(user_id,occurred_at DESC,id DESC);
        CREATE TABLE user_activity(
          user_id TEXT PRIMARY KEY,revision INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE albums(
          owner_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,id)
        ) STRICT;
        CREATE INDEX ix_albums_owner_updated ON albums(owner_id,updated_at DESC,id DESC);
        CREATE TABLE album_items(
          owner_id TEXT NOT NULL,album_id TEXT NOT NULL,
          media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,added_at TEXT NOT NULL,
          PRIMARY KEY(owner_id,album_id,media_id),
          FOREIGN KEY(owner_id,album_id) REFERENCES albums(owner_id,id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX ix_album_items_owner_media ON album_items(owner_id,media_id,album_id);
        """;

    private const string AlbumColumns = """
        a.id,a.name,(SELECT count(*) FROM album_items i JOIN media m ON m.id=i.media_id
          WHERE i.owner_id=a.owner_id AND i.album_id=a.id AND m.deleted_at IS NULL),a.created_at,a.updated_at
        """;

    public async Task<AlbumSummary[]> ListAlbumsAsync(byte[] key, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(key, false, ct);
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT {AlbumColumns} FROM albums a WHERE a.owner_id=$user ORDER BY a.updated_at DESC,a.id DESC;";
        command.Parameters.AddWithValue("$user", userId);
        var albums = new List<AlbumSummary>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) albums.Add(ReadAlbum(reader));
        return albums.ToArray();
    }

    public async Task<AlbumSummary> CreateAlbumAsync(byte[] key, string userId, string name, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        name = ValidateAlbumName(name);
        var id = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        await using var connection = await OpenAsync(key, false, ct);
        await using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO albums(owner_id,id,name,created_at,updated_at) VALUES($user,$album,$name,$now,$now);";
        AddAlbumParameters(command, userId, id);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$now", now.ToString("O", CultureInfo.InvariantCulture));
        await command.ExecuteNonQueryAsync(ct);
        return new(id, name, 0, now, now);
    }

    public async Task<AlbumSummary> RenameAlbumAsync(byte[] key, string userId, Guid albumId, string name, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        name = ValidateAlbumName(name);
        await using var connection = await OpenAsync(key, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE albums SET name=$name,updated_at=$now WHERE owner_id=$user AND id=$album;";
        AddAlbumParameters(command, userId, albumId);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$now", UtcNow());
        if (await command.ExecuteNonQueryAsync(ct) == 0) throw new KeyNotFoundException("Album does not exist.");
        command.CommandText = $"SELECT {AlbumColumns} FROM albums a WHERE a.owner_id=$user AND a.id=$album;";
        AlbumSummary result;
        await using (var reader = await command.ExecuteReaderAsync(ct))
        {
            if (!await reader.ReadAsync(ct)) throw new KeyNotFoundException("Album does not exist.");
            result = ReadAlbum(reader);
        }
        transaction.Commit();
        return result;
    }

    public async Task DeleteAlbumAsync(byte[] key, string userId, Guid albumId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(key, false, ct);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM albums WHERE owner_id=$user AND id=$album;";
        AddAlbumParameters(command, userId, albumId);
        if (await command.ExecuteNonQueryAsync(ct) == 0) throw new KeyNotFoundException("Album does not exist.");
    }

    public Task<MediaPage> ListAlbumItemsAsync(byte[] key, string userId, Guid albumId, int limit, string? cursor, CancellationToken ct = default) =>
        ListMediaAsync(key, new("", "", [], [], "home", "date_desc", "", limit, cursor), userId, albumId, ct);

    public async Task<Guid[]> ListMediaAlbumIdsAsync(byte[] key, string userId, Guid mediaId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(key, false, ct);
        using var snapshot = connection.BeginTransaction(deferred: true);
        await RequireLiveMediaAsync(connection, snapshot, mediaId, ct);
        await using var command = connection.CreateCommand();
        command.Transaction = snapshot;
        command.CommandText = "SELECT album_id FROM album_items WHERE owner_id=$user AND media_id=$media ORDER BY album_id;";
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$media", mediaId.ToString("N"));
        var ids = new List<Guid>();
        await using (var reader = await command.ExecuteReaderAsync(ct))
            while (await reader.ReadAsync(ct)) ids.Add(Guid.ParseExact(reader.GetString(0), "N"));
        snapshot.Commit();
        return ids.ToArray();
    }

    public async Task SetAlbumItemAsync(byte[] key, string userId, Guid albumId, Guid mediaId, bool included, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(key, false, ct);
        using var transaction = connection.BeginTransaction();
        await RequireAlbumAsync(connection, transaction, userId, albumId, ct);
        if (included) await RequireLiveMediaAsync(connection, transaction, mediaId, ct);

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = included
            ? """
                INSERT INTO album_items(owner_id,album_id,media_id,added_at) VALUES($user,$album,$media,$now)
                ON CONFLICT(owner_id,album_id,media_id) DO NOTHING;
                """
            : "DELETE FROM album_items WHERE owner_id=$user AND album_id=$album AND media_id=$media;";
        AddAlbumParameters(command, userId, albumId);
        command.Parameters.AddWithValue("$media", mediaId.ToString("N"));
        command.Parameters.AddWithValue("$now", UtcNow());
        if (await command.ExecuteNonQueryAsync(ct) > 0)
        {
            command.CommandText = "UPDATE albums SET revision=revision+1,updated_at=$now WHERE owner_id=$user AND id=$album;";
            await command.ExecuteNonQueryAsync(ct);
        }
        transaction.Commit();
    }

    private static void ValidateUserId(string userId)
    {
        if (string.IsNullOrWhiteSpace(userId) || userId.Length > 128) throw new ArgumentException("Invalid user ID.", nameof(userId));
    }

    private static string ValidateAlbumName(string name)
    {
        name = name?.Trim() ?? "";
        if (name.Length is < 1 or > 100 || name.Any(char.IsControl)) throw new ArgumentException("Invalid album name.", nameof(name));
        return name;
    }

    private static AlbumSummary ReadAlbum(SqliteDataReader reader) =>
        new(Guid.ParseExact(reader.GetString(0), "N"), reader.GetString(1), reader.GetInt64(2),
            DateTimeOffset.ParseExact(reader.GetString(3), "O", CultureInfo.InvariantCulture),
            DateTimeOffset.ParseExact(reader.GetString(4), "O", CultureInfo.InvariantCulture));

    private static void AddAlbumParameters(SqliteCommand command, string userId, Guid albumId)
    {
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$album", albumId.ToString("N"));
    }

    private static async Task<long> RequireAlbumAsync(SqliteConnection connection, SqliteTransaction transaction,
        string userId, Guid albumId, CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT revision FROM albums WHERE owner_id=$user AND id=$album;";
        AddAlbumParameters(command, userId, albumId);
        return await command.ExecuteScalarAsync(ct) is long revision ? revision : throw new KeyNotFoundException("Album does not exist.");
    }

    private static async Task RequireLiveMediaAsync(SqliteConnection connection, SqliteTransaction transaction, Guid mediaId, CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM media WHERE id=$media AND deleted_at IS NULL;";
        command.Parameters.AddWithValue("$media", mediaId.ToString("N"));
        if (await command.ExecuteScalarAsync(ct) is null) throw new KeyNotFoundException("Media does not exist.");
    }

    private static async Task<long> ActivityRevisionAsync(SqliteConnection connection, SqliteTransaction transaction, string userId, CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT revision FROM user_activity WHERE user_id=$user;";
        command.Parameters.AddWithValue("$user", userId);
        return await command.ExecuteScalarAsync(ct) is long revision ? revision : 0L;
    }

    private static async Task BumpActivityRevisionAsync(SqliteConnection connection, SqliteTransaction transaction, string userId, CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO user_activity(user_id,revision) VALUES($user,1)
            ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
            """;
        command.Parameters.AddWithValue("$user", userId);
        await command.ExecuteNonQueryAsync(ct);
    }
}
