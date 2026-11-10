using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Shronchik.Server.Catalog;

public sealed partial class CatalogStore
{
    private const string RatingsSchemaSql = """
        CREATE TABLE user_ratings(
          user_id TEXT NOT NULL CHECK(user_id<>'Admin'),
          media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 10000),
          PRIMARY KEY(user_id,media_id)
        ) STRICT;
        CREATE INDEX ix_user_ratings_media ON user_ratings(media_id,rating);
        CREATE TABLE legacy_ratings(
          media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 10000)
        ) STRICT;
        """;

    private static async Task MigrateRatingsAndSettingsAsync(SqliteConnection connection, CancellationToken ct)
    {
        using var transaction = connection.BeginTransaction();
        var version = Convert.ToInt32(await ScalarAsync(connection, "PRAGMA user_version;", ct, transaction), CultureInfo.InvariantCulture);
        if (version == SchemaVersion) return;
        if (version != 3) throw new InvalidDataException("Unsupported catalog schema version.");
        await ExecuteAsync(connection, RatingsSchemaSql, ct, transaction);
        // Previous scores have no author. Preserve them for recovery without
        // counting administrator edits or inventing votes for an account.
        await ExecuteAsync(connection, """
            INSERT INTO legacy_ratings(media_id,rating) SELECT id,rating FROM media WHERE rating IS NOT NULL;
            UPDATE media SET rating=NULL;
            INSERT INTO settings(key,value) SELECT 'user:Admin',value FROM settings WHERE key='ui';
            INSERT INTO settings(key,value) SELECT 'user:User',value FROM settings WHERE key='ui';
            PRAGMA user_version=4;
            """, ct, transaction);
        await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }

    public async Task<UiSettings> GetSettingsAsync(byte[] masterKey, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var snapshot = connection.BeginTransaction(deferred: true);
        var result = await ReadSettingsAsync(connection, snapshot, userId, ct);
        snapshot.Commit();
        return result;
    }

    private static async Task<UiSettings> ReadSettingsAsync(SqliteConnection connection, SqliteTransaction? transaction,
        string userId, CancellationToken ct)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT value FROM settings WHERE key=$key;";
        command.Parameters.AddWithValue("$key", "user:" + userId);
        var serialized = await command.ExecuteScalarAsync(ct) as string;
        var personal = serialized is null ? new UiSettings() : JsonSerializer.Deserialize<UiSettings>(serialized, JsonOptions)
            ?? throw new InvalidDataException("Invalid account settings.");
        ValidateSettings(personal);
        var shared = await ReadSettingsAsync(connection, transaction, ct);
        return WithInfrastructure(personal, shared) with { SchemaVersion = UiSettings.CurrentSchemaVersion };
    }

    private static UiSettings WithInfrastructure(UiSettings personal, UiSettings shared) => personal with
    {
        TrashRetentionDays = shared.TrashRetentionDays,
        LowDiskWarningGB = shared.LowDiskWarningGB,
        ThumbnailCandidates = shared.ThumbnailCandidates,
        VerifyOnStartup = shared.VerifyOnStartup,
        BackupReminderDays = shared.BackupReminderDays,
        WorkerConcurrency = shared.WorkerConcurrency,
        MaxTranscodes = shared.MaxTranscodes,
        PauseOnBattery = shared.PauseOnBattery,
        FfmpegThreads = shared.FfmpegThreads,
        GpuDecodePreference = shared.GpuDecodePreference,
    };

    public async Task SaveSettingsAsync(byte[] masterKey, UiSettings settings, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        ValidateSettings(settings);
        await using var connection = await OpenAsync(masterKey, false, ct);
        using var transaction = connection.BeginTransaction();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO settings(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value;";
        command.Parameters.AddWithValue("$key", "user:" + userId);
        command.Parameters.AddWithValue("$value", JsonSerializer.Serialize(settings with { SchemaVersion = UiSettings.CurrentSchemaVersion }, JsonOptions));
        await command.ExecuteNonQueryAsync(ct);
        if (userId == "Admin")
        {
            var shared = await ReadSettingsAsync(connection, transaction, ct);
            command.Parameters["$key"].Value = "ui";
            command.Parameters["$value"].Value = JsonSerializer.Serialize(WithInfrastructure(shared, settings), JsonOptions);
            await command.ExecuteNonQueryAsync(ct);
        }
        // Recommendation cursors depend on the account's settings, and remain
        // usable when another account changes its own preferences.
        await BumpActivityRevisionAsync(connection, transaction, userId, ct);
        transaction.Commit();
    }
}
