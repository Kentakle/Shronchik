using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Shronchik.Server.Catalog;

// Synthetic metadata only: no media files or production library are opened.
var count = args.Length > 0 ? int.Parse(args[0], CultureInfo.InvariantCulture) : 10_000;
if (count is < 100 or > 1_000_000) throw new ArgumentOutOfRangeException(nameof(count));
var label = args.Length > 1 ? args[1] : "measurement";
if (label.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_'))) throw new ArgumentException("Invalid label.");
var root = Path.GetFullPath(Path.Combine(Environment.CurrentDirectory, ".cache", "performance", count.ToString(CultureInfo.InvariantCulture)));
Directory.CreateDirectory(root);
var libraryId = Guid.Parse("8db790aa-7af5-497c-8c58-258b11703afd");
var key = SHA256.HashData("Shronchik public synthetic benchmark key; never use for real data"u8);
var catalog = new CatalogStore(root, libraryId);
await catalog.InitializeAsync(key);
try
{
    var derived = HKDF.DeriveKey(HashAlgorithmName.SHA256, key, 32, libraryId.ToByteArray(), "Shronchik/catalog/v1"u8.ToArray());
    await using (var db = new SqliteConnection(new SqliteConnectionStringBuilder
    {
        DataSource = Path.Combine(root, "db", "catalog.sqlite"), Pooling = false,
        Password = "x'" + Convert.ToHexString(derived) + "'"
    }.ToString()))
    {
        CryptographicOperations.ZeroMemory(derived);
        await db.OpenAsync();
        await using var check = db.CreateCommand();
        check.CommandText = "SELECT count(*) FROM media;";
        if (Convert.ToInt64(await check.ExecuteScalarAsync(), CultureInfo.InvariantCulture) != count)
        {
            using var tx = db.BeginTransaction();
            await using var seed = db.CreateCommand();
            seed.Transaction = tx;
            seed.CommandText = """
                DELETE FROM media_tags; DELETE FROM view_events; DELETE FROM recent_opened;
                DELETE FROM media; DELETE FROM tags;
                WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<$count)
                INSERT INTO media(id,type,title,description,search_text,rating,views,is_favorite,size,created_at,mime_type,sha256)
                SELECT printf('%032x',i),CASE WHEN i%3=0 THEN 'photo' ELSE 'video' END,
                  'Synthetic item '||i,$description,'SYNTHETIC ITEM '||i||' '||$description,
                  CASE WHEN i%7=0 THEN NULL ELSE 1+i%10000 END,0,i%2,1000000,
                  '2026-11-01T00:00:00.0000000+00:00',CASE WHEN i%3=0 THEN 'image/png' ELSE 'video/mp4' END,
                  printf('%064x',i) FROM n;
                WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<23)
                INSERT INTO tags(normalized,name) SELECT 'TAG-'||i,'tag-'||i FROM n;
                INSERT INTO media_tags SELECT id,'TAG-'||(rowid%24) FROM media;
                INSERT INTO media_tags SELECT id,'TAG-'||((rowid+7)%24) FROM media;
                INSERT INTO media_tags SELECT id,'TAG-'||((rowid+13)%24) FROM media;
                UPDATE metadata SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='catalog_revision';
                """;
            seed.Parameters.AddWithValue("$count", count);
            seed.Parameters.AddWithValue("$description", new string('x', 800));
            await seed.ExecuteNonQueryAsync();
            tx.Commit();
        }
    }
    var query = new MediaQuery("photo", "", [], [], "home", "date_desc", "benchmark", 60, null);
    var measurements = new List<object>();
    await Measure("photo/date", () => catalog.ListAsync(key, query, "perf.user"));
    await Measure("photo/random", () => catalog.ListAsync(key, query with { Sort = "random" }, "perf.user"));
    await Measure("video/personalized", () => catalog.ListAsync(key, query with { Type = "video", Sort = "random" }, "perf.user"));
    await Measure("video/filtered", () => catalog.ListAsync(key, query with { Type = "video", Sort = "random", IncludeTags = ["tag-7"] }, "perf.user"));
    await Measure("video/related", () => catalog.RelatedAsync(key, Guid.ParseExact(1.ToString("x32"), "N"), "perf.user"));
    var report = new { records = count, label, runtime = Environment.Version.ToString(), measurements, peakWorkingSetMiB = Math.Round(Process.GetCurrentProcess().PeakWorkingSet64 / 1048576.0, 1) };
    var serialized = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
    await File.WriteAllTextAsync(Path.Combine(root, label + ".json"), serialized);
    Console.WriteLine(serialized);

    async Task Measure<T>(string name, Func<Task<T>> operation)
    {
        var times = new List<double>();
        for (var i = 0; i < 4; i++)
        {
            var watch = Stopwatch.StartNew();
            _ = await operation();
            times.Add(watch.Elapsed.TotalMilliseconds);
        }
        var warm = times.Skip(1).Order().ToArray();
        measurements.Add(new { name, firstMs = Math.Round(times[0], 1), warmMedianMs = Math.Round(warm[1], 1), warmMaxMs = Math.Round(warm[^1], 1) });
    }
}
finally { CryptographicOperations.ZeroMemory(key); }
