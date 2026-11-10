using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Shronchik.Server.Catalog;

public sealed partial class CatalogStore
{
    private const string RecentPreferencesSql = """
        recent AS (
          SELECT media_id FROM view_events WHERE user_id=$user ORDER BY occurred_at DESC,id DESC LIMIT 30
        ), preferences AS (
          SELECT mt.tag,count(*) AS frequency FROM recent r JOIN media_tags mt ON mt.media_id=r.media_id GROUP BY mt.tag
        )
        """;

    private string TagCondition(SqliteCommand command, string tag, string prefix, bool exclude)
    {
        var aliases = (tagDictionary?.ExpandAliases(tag) ?? [tag]).Select(NormalizeText).Distinct().ToArray();
        var parameters = new List<string>();
        for (var index = 0; index < aliases.Length; index++)
        {
            var name = $"${prefix}_{index}";
            parameters.Add(name);
            command.Parameters.AddWithValue(name, aliases[index]);
        }
        return $"{(exclude ? "NOT " : "")}EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id=m.id AND mt.tag IN ({string.Join(',', parameters)}))";
    }

    private static void ConfigureFeed(SqliteCommand command, List<string> conditions, UiSettings settings)
    {
        command.Parameters.AddWithValue("$minimum", settings.MinimumRating);
        command.Parameters.AddWithValue("$rated", settings.RatedPercent);
        command.Parameters.AddWithValue("$weight", settings.RatingWeight);
        command.CommandText = $"""
            WITH {RecentPreferencesSql},
            candidates AS MATERIALIZED (
              SELECT m.id,m.rating,stable_rank(m.id,$seed) AS random_rank,
                coalesce(m.rating,0)/10000.0*$weight + (1-$weight)*coalesce(
                (SELECT sum(p.frequency)*1.0 FROM media_tags mt JOIN preferences p ON p.tag=mt.tag WHERE mt.media_id=m.id)
                /nullif((SELECT count(*) FROM recent)*(SELECT count(*) FROM media_tags mt WHERE mt.media_id=m.id),0),0) AS score
              FROM media m WHERE {string.Join(" AND ", conditions)}
            ), ranked AS (
              SELECT *,row_number() OVER (ORDER BY coalesce(rating,0)>=$minimum DESC,score DESC,random_rank,id) AS preference_order FROM candidates
            ), pools AS (
              SELECT *,CASE WHEN rating>=$minimum AND preference_order<=CAST(((SELECT count(*) FROM candidates)*$rated+99)/100 AS INTEGER) THEN 1 ELSE 0 END AS rated_pool FROM ranked
            ), balanced AS (
              SELECT *,row_number() OVER (PARTITION BY rated_pool ORDER BY CASE WHEN rated_pool=1 THEN score END DESC,random_rank,id) AS lane FROM pools
            ), page AS (
              SELECT id,rated_pool,CASE WHEN (CASE rated_pool WHEN 1 THEN $rated ELSE 100-$rated END)=0
                THEN (SELECT count(*) FROM candidates)+lane
                ELSE lane*100.0/(CASE rated_pool WHEN 1 THEN $rated ELSE 100-$rated END) END AS position
              FROM balanced ORDER BY position,rated_pool DESC,id LIMIT $limit OFFSET $offset
            )
            SELECT {MediaColumns} FROM page p JOIN media m ON m.id=p.id
            ORDER BY p.position,p.rated_pool DESC,m.id;
            """;
    }

    public async Task<MediaItem?> NeighborAsync(byte[] key, Guid id, string direction, string userId, CancellationToken ct)
    {
        if (direction is not ("next" or "previous")) throw new ArgumentException("Invalid direction.");
        var current = await GetAsync(key, id, ct) ?? throw new KeyNotFoundException();
        await using var connection = await OpenAsync(key, false, ct);
        await using var command = connection.CreateCommand();
        var comparison = direction == "next" ? ">" : "<";
        var order = direction == "next" ? "ASC" : "DESC";
        command.CommandText = $"SELECT {MediaColumns} FROM media m WHERE m.deleted_at IS NULL AND m.type=$type AND (m.created_at,m.id){comparison}($date,$id) ORDER BY m.created_at {order},m.id {order} LIMIT 1;";
        command.Parameters.AddWithValue("$type", current.Type);
        command.Parameters.AddWithValue("$date", current.CreatedAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        command.Parameters.AddWithValue("$user", userId);
        var items = await ReadItemsAsync(command, ct);
        await FillTagsAsync(connection, items, ct);
        return items.FirstOrDefault();
    }

    public async Task<MediaItem[]> RelatedAsync(byte[] key, Guid id, string userId, CancellationToken ct = default)
    {
        ValidateUserId(userId);
        await using var connection = await OpenAsync(key, false, ct);
        using var snapshot = connection.BeginTransaction(deferred: true);
        string currentType;
        await using (var current = connection.CreateCommand())
        {
            current.Transaction = snapshot;
            current.CommandText = "SELECT type FROM media WHERE id=$id AND deleted_at IS NULL;";
            current.Parameters.AddWithValue("$id", id.ToString("N"));
            currentType = await current.ExecuteScalarAsync(ct) as string ?? throw new KeyNotFoundException();
        }
        var settings = await ReadSettingsAsync(connection, snapshot, userId, ct);
        if (!settings.ShowRelatedBelow) return [];
        await using var command = connection.CreateCommand();
        command.Transaction = snapshot;
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$type", currentType);
        command.Parameters.AddWithValue("$similar", settings.RelatedCount);
        command.Parameters.AddWithValue("$random", settings.RandomRelatedCount);
        command.CommandText = $"""
            WITH {RecentPreferencesSql}, similar AS (
              SELECT m.id,
                (SELECT count(*) FROM media_tags a JOIN media_tags b ON a.tag=b.tag WHERE a.media_id=m.id AND b.media_id=$id) AS overlap,
                (SELECT coalesce(sum(p.frequency),0) FROM media_tags mt JOIN preferences p ON p.tag=mt.tag WHERE mt.media_id=m.id) AS affinity
              FROM media m WHERE m.deleted_at IS NULL AND m.type=$type AND m.id<>$id
                AND EXISTS(SELECT 1 FROM media_tags a JOIN media_tags b ON a.tag=b.tag WHERE a.media_id=m.id AND b.media_id=$id)
              ORDER BY overlap DESC,affinity DESC,m.rating DESC,m.id LIMIT $similar
            ), extras AS (
              SELECT id FROM media WHERE deleted_at IS NULL AND type=$type AND id<>$id AND id NOT IN (SELECT id FROM similar)
              ORDER BY random() LIMIT ($similar+$random)-(SELECT count(*) FROM similar)
            ), selected AS (
              SELECT id,overlap,affinity FROM similar
              UNION ALL SELECT id,NULL,NULL FROM extras
            ) SELECT {MediaColumns} FROM selected s JOIN media m ON m.id=s.id
            ORDER BY s.overlap DESC,s.affinity DESC,m.rating DESC,m.id;
            """;
        var items = await ReadItemsAsync(command, ct);
        await FillTagsAsync(connection, items, ct, snapshot);
        snapshot.Commit();
        return items.ToArray();
    }
}
