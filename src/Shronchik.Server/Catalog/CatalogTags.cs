using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Shronchik.Server.Catalog;

public sealed partial class CatalogStore
{
    private async Task MigrateTagDictionaryAsync(SqliteConnection connection, CancellationToken ct)
    {
        if (tagDictionary is null) return;

        using var transaction = connection.BeginTransaction();
        var dictionaryVersion = tagDictionary.Version.ToString(CultureInfo.InvariantCulture);
        // Recheck under the write lock: concurrent logins must not migrate the same dictionary twice.
        if (await ScalarAsync(connection,
                "SELECT value FROM metadata WHERE key='tag_dictionary_version';", ct, transaction)
            is string storedVersion && storedVersion == dictionaryVersion)
            return;

        var storedTags = new List<(string Key, string Name)>();
        await using (var read = connection.CreateCommand())
        {
            read.Transaction = transaction;
            read.CommandText = "SELECT normalized,name FROM tags;";
            await using var reader = await read.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                storedTags.Add((reader.GetString(0), reader.GetString(1)));
        }

        var changed = false;
        foreach (var (oldKey, oldName) in storedTags)
        {
            var known = tagDictionary.TryCanonicalize(oldName, out var canonical)
                || tagDictionary.TryCanonicalize(oldKey, out canonical);
            var canonicalKey = known ? NormalizeText(canonical) : "";
            if (known && oldKey == canonicalKey && oldName == canonical) continue;

            changed = true;
            await using var update = connection.CreateCommand();
            update.Transaction = transaction;
            if (!known)
            {
                update.Parameters.AddWithValue("$old", oldKey);
                update.CommandText = "DELETE FROM media_tags WHERE tag=$old; DELETE FROM tags WHERE normalized=$old;";
            }
            else
            {
                update.Parameters.AddWithValue("$canonical", canonicalKey);
                update.Parameters.AddWithValue("$name", canonical);
                update.CommandText = """
                    INSERT INTO tags(normalized,name) VALUES($canonical,$name)
                    ON CONFLICT(normalized) DO UPDATE SET name=excluded.name;
                    """;
                if (oldKey != canonicalKey)
                {
                    update.Parameters.AddWithValue("$old", oldKey);
                    // Several historical labels may converge on one ID for the same media item.
                    update.CommandText += """

                        INSERT OR IGNORE INTO media_tags(media_id,tag)
                        SELECT media_id,$canonical FROM media_tags WHERE tag=$old;
                        DELETE FROM media_tags WHERE tag=$old;
                        DELETE FROM tags WHERE normalized=$old;
                        """;
                }
            }
            await update.ExecuteNonQueryAsync(ct);
        }

        await using (var marker = connection.CreateCommand())
        {
            marker.Transaction = transaction;
            marker.CommandText = """
                INSERT INTO metadata(key,value) VALUES('tag_dictionary_version',$version)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value;
                """;
            marker.Parameters.AddWithValue("$version", dictionaryVersion);
            await marker.ExecuteNonQueryAsync(ct);
        }
        if (changed) await BumpRevisionAsync(connection, transaction, ct);
        transaction.Commit();
    }
}
