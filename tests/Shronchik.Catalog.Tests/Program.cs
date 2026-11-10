using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Shronchik.Server.Catalog;
using Shronchik.Server.Tags;

var workspace = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
var directory = Path.Combine(workspace, ".cache", "test-catalog", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
var libraryId = Guid.NewGuid();
var key = RandomNumberGenerator.GetBytes(32);
var store = new CatalogStore(directory, libraryId);
const string LegacyUser = "User";
const string Friend = "friend";
var passed = 0;
try
{
    await store.InitializeAsync(key);
    var marker = "catalog-private-marker-" + Guid.NewGuid().ToString("N");
    var tagged = Item("photo", "Тёплое " + marker, [" Один ", "CAFÉ", "Ａ"], 8123, true);
    await store.AddAsync(key, tagged, Hash(1));
    var excluded = Item("photo", "Другой объект", ["Один", "CAFÉ", "Запрет"]);
    await store.AddAsync(key, excluded, Hash(2));
    var restored = await store.GetAsync(key, tagged.Id);
    Check(restored is not null && restored.Title == tagged.Title && restored.Rating == 8123
        && restored.IsFavorite && restored.Tags.SequenceEqual(new[] { "Ａ", "CAFÉ", "Один" }),
        "Add/Get preserves metadata and normalized tag display names");

    var filter = Query() with { IncludeTags = ["один", "Cafe\u0301"], ExcludeTags = ["запрет"] };
    var filtered = await List(store, filter);
    Check(filtered.Items.Length == 1 && filtered.Items[0].Id == tagged.Id,
        "Unicode normalization and include-AND/exclude tag filters");
    Check((await List(store, Query() with { IncludeTags = ["A"] })).Items.Single().Id == tagged.Id,
        "Compatibility-normalized fullwidth tag matches ASCII");
    Check((await List(store, Query() with { Query = "тЁпЛоЕ" })).Items.Single().Id == tagged.Id,
        "Russian title search uses case-insensitive normalization");
    Check((await List(store, Query() with { Query = "Cafe\u0301" })).Items.Length == 2,
        "Search includes normalized tag names");

    await Throws<ArgumentOutOfRangeException>(() => store.SetRatingAsync(key, tagged.Id, LegacyUser, 0), "rating below range rejected");
    await Throws<ArgumentOutOfRangeException>(() => store.SetRatingAsync(key, tagged.Id, LegacyUser, 10001), "rating above range rejected");
    await store.SetRatingAsync(key, tagged.Id, LegacyUser, null);
    await store.SetFavoriteAsync(key, tagged.Id, false);
    restored = await store.GetAsync(key, tagged.Id);
    Check(restored is { Rating: null, IsFavorite: false }, "rating can be cleared and favorite is mutable");
    await store.SetRatingAsync(key, tagged.Id, LegacyUser, 10000);
    await store.SetRatingAsync(key, tagged.Id, LegacyUser, 1000);
    await store.SetRatingAsync(key, tagged.Id, Friend, 3000);
    restored = await store.GetAsync(key, tagged.Id, LegacyUser);
    Check(restored is { Rating: 2000, UserRating: 1000, RatingCount: 2 }
        && (await store.GetAsync(key, tagged.Id, Friend)) is { UserRating: 3000 }
        && (await store.GetAsync(key, tagged.Id, "Admin")) is { UserRating: null, Rating: 2000 },
        "ratings average independent user votes and expose only the current user's vote");
    Check((await List(store, Query())).Items.Single(item => item.Id == tagged.Id) is { Rating: 2000, UserRating: 1000, RatingCount: 2 },
        "gallery ratings use the same average and account-specific vote as media detail");
    await store.SetRatingAsync(key, tagged.Id, LegacyUser, 2001);
    Check((await store.GetAsync(key, tagged.Id)) is { Rating: 2501, RatingCount: 2 },
        "changing a vote replaces it and rounds the arithmetic mean to the nearest point");
    await store.SetRatingAsync(key, tagged.Id, Friend, null);
    Check((await store.GetAsync(key, tagged.Id, Friend)) is { Rating: 2001, UserRating: null, RatingCount: 1 },
        "clearing a personal rating removes only that vote");
    await Throws<ArgumentException>(() => store.SetRatingAsync(key, tagged.Id, "Admin", 9999),
        "catalog rejects administrator ratings");
    await store.SetRatingAsync(key, tagged.Id, LegacyUser, 10000);
    await store.SetFavoriteAsync(key, tagged.Id, true);
    Check((await List(store, Query() with { Tab = "favorites" }, Friend)).Items.Single().Id == tagged.Id,
        "shared favorites gallery reflects mutation");

    var duplicate = Item("photo", "Duplicate name", []);
    var duplicateError = await Throws<DuplicateMediaException>(() => store.AddAsync(key, duplicate, Hash(1)), "duplicate content rejected");
    Check(duplicateError.Id == tagged.Id, "duplicate exception identifies existing media");
    await store.TrashAsync(key, tagged.Id);
    Check(await store.GetAsync(key, tagged.Id) is null, "trashed media is absent from normal lookup");
    Check(!(await List(store, filter)).Items.Any(), "trash is excluded from search and filters");
    duplicateError = await Throws<DuplicateMediaException>(() => store.AddAsync(key, duplicate, Hash(1)), "duplicate detection includes trash");
    Check(duplicateError.Id == tagged.Id, "trashed duplicate preserves original identifier");
    var trash = (await store.TrashListAsync(key)).Single();
    Check(trash.Id == tagged.Id && trash.Rating == 10000 && trash.IsFavorite && trash.Tags.Length == 3,
        "trash retains rating, favorite and tag links");
    await store.RestoreAsync(key, tagged.Id);
    restored = await store.GetAsync(key, tagged.Id);
    Check(restored is { Rating: 10000, IsFavorite: true } && restored.Tags.Length == 3,
        "restoration recovers all metadata and links");

    for (var i = 0; i < 12; i++)
    {
        var item = Item("video", "Synthetic history " + i, []);
        await store.AddAsync(key, item, Hash(10 + i));
        await store.OpenedAsync(key, item.Id, LegacyUser);
    }
    var history = await List(store, Query() with { Type = "video", Tab = "history", Limit = 100 });
    Check(history.Items.Length == 10 && !history.HasMore, "personal history keeps only ten entries per type");
    var video = history.Items[0];
    await store.RecordViewAsync(key, video.Id, LegacyUser);
    Check((await store.GetAsync(key, video.Id))!.Views == 1, "view event and count update atomically");

    var pageQuery = Query() with { Type = "video", Limit = 3 };
    var allIds = new List<Guid>();
    var page = await List(store, pageQuery);
    var firstCursor = page.NextCursor!;
    while (true)
    {
        allIds.AddRange(page.Items.Select(item => item.Id));
        if (!page.HasMore) break;
        Check(page.NextCursor is not null, "non-final page supplies cursor");
        page = await List(store, pageQuery with { Cursor = page.NextCursor });
    }
    Check(allIds.Count == 12 && allIds.Distinct().Count() == 12, "stable seeded pagination covers every item without duplicates");
    var repeated = await List(store, pageQuery);
    Check(repeated.Items.Select(item => item.Id).SequenceEqual(allIds.Take(3)), "same random seed yields stable order");
    var tampered = firstCursor.ToCharArray();
    tampered[40] = tampered[40] == 'A' ? 'B' : 'A';
    await Throws<ArgumentException>(() => List(store, pageQuery with { Cursor = new string(tampered) }), "tampered cursor rejected");
    await Throws<ArgumentException>(() => List(store, pageQuery with { Cursor = firstCursor, IncludeTags = ["different"] }), "cursor cannot be reused with different filters");
    await Throws<ArgumentException>(() => List(store, pageQuery with { Cursor = firstCursor }, Friend), "cursor cannot be reused by a different user");
    await store.OpenedAsync(key, video.Id, Friend);
    Check((await List(store, pageQuery with { Cursor = firstCursor })).Items.Length == 3,
        "another user's activity leaves a personal feed cursor valid");
    await store.SetFavoriteAsync(key, video.Id, true);
    await Throws<ArgumentException>(() => List(store, pageQuery with { Cursor = firstCursor }), "stale cursor fails instead of returning shifted duplicate pages");

    var legacySettings = JsonSerializer.Deserialize<UiSettings>(
        """{"language":"en","gridColumns":5,"animationMs":200,"afkMinutes":7,"accentColor":"#123abc"}""",
        new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    Check(legacySettings is { Language: "en", GridColumns: 5, AfkMinutes: 7, AccentColor: "#123abc", SchemaVersion: 2,
        RatedPercent: 70, PageBatchSize: 60, ShowRelatedBelow: true } && legacySettings.Hotkeys == new HotkeySettings(),
        "legacy settings preserve user choices and receive new defaults");
    var settings = new UiSettings("en", 8, 0, 12, "#123abc");
    await store.SaveSettingsAsync(key, settings);
    Check(await store.GetSettingsAsync(key) == settings, "UI settings persist in encrypted catalog");
    await store.SaveSettingsAsync(key, settings with { Language = "ru", GridColumns = 4, AfkMinutes = 2 }, LegacyUser);
    await store.SaveSettingsAsync(key, settings with { Language = "en", GridColumns = 12, AfkMinutes = 9 }, Friend);
    await store.SaveSettingsAsync(key, settings with { Language = "ru", GridColumns = 7, TrashRetentionDays = 21 }, "Admin");
    Check((await store.GetSettingsAsync(key, LegacyUser)) is { Language: "ru", GridColumns: 4, AfkMinutes: 2, TrashRetentionDays: 21 }
        && (await store.GetSettingsAsync(key, Friend)) is { Language: "en", GridColumns: 12, AfkMinutes: 9, TrashRetentionDays: 21 }
        && (await store.GetSettingsAsync(key, "Admin")) is { GridColumns: 7 }
        && (await store.GetSettingsAsync(key, "new.user")) is { Language: "ru", GridColumns: 10, AfkMinutes: 5 },
        "account settings stay independent while protected storage policy remains shared");
    var personalCursor = (await List(store, Query() with { Type = "video", Limit = 3 })).NextCursor;
    await store.SaveSettingsAsync(key, new UiSettings { GridColumns = 6 }, Friend);
    Check((await List(store, Query() with { Type = "video", Limit = 3, Cursor = personalCursor })).Items.Length == 3,
        "another user's settings do not invalidate a personal feed cursor");
    await store.SaveSettingsAsync(key, settings with { GridColumns = 5 }, LegacyUser);
    await Throws<ArgumentException>(() => List(store, Query() with { Type = "video", Limit = 3, Cursor = personalCursor }),
        "changing feed settings invalidates only the current account's continuation");
    await Throws<ArgumentException>(() => store.SaveSettingsAsync(key, settings with { AfkMinutes = 0 }), "invalid settings rejected");
    var reopened = new CatalogStore(directory, libraryId);
    await reopened.InitializeAsync(key);
    Check((await reopened.GetAsync(key, tagged.Id))!.Title == tagged.Title, "catalog reopens without losing data");
    Check((await reopened.GetSettingsAsync(key, LegacyUser)).GridColumns == 5
        && (await reopened.GetSettingsAsync(key, Friend)).GridColumns == 6,
        "each account's settings survive catalog reopening");

    var wrongKey = RandomNumberGenerator.GetBytes(32);
    try { await Throws<SqliteException>(() => reopened.InitializeAsync(wrongKey), "wrong catalog key fails closed"); }
    finally { CryptographicOperations.ZeroMemory(wrongKey); }
    await reopened.InitializeAsync(key);
    Check((await reopened.GetAsync(key, tagged.Id))!.Rating == 10000, "wrong-key attempt does not replace catalog");

    // Keep one SQLCipher connection alive so a write's WAL remains on disk for the
    // privacy scan, rather than testing only the main database after checkpoint.
    var photoHistoryQuery = Query() with { Tab = "history" };
    var videoHistoryQuery = photoHistoryQuery with { Type = "video" };
    var derived = HKDF.DeriveKey(HashAlgorithmName.SHA256, key, 32, libraryId.ToByteArray(), "Shronchik/catalog/v1"u8.ToArray());
    try
    {
        await using var holder = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "db", "catalog.sqlite"),
            Mode = SqliteOpenMode.ReadWrite, Pooling = false,
            Password = "x'" + Convert.ToHexString(derived) + "'"
        }.ToString());
        await holder.OpenAsync();
        await using (var command = holder.CreateCommand())
        {
            command.CommandText = "SELECT count(*) FROM media;";
            _ = await command.ExecuteScalarAsync();
        }
        await store.SetRatingAsync(key, tagged.Id, LegacyUser, 9999);
        var database = await ReadSharedBytesAsync(Path.Combine(directory, "db", "catalog.sqlite"));
        Check(!database.AsSpan(0, 16).SequenceEqual("SQLite format 3\0"u8), "SQLCipher database has no plaintext SQLite header");
        var walPath = Path.Combine(directory, "db", "catalog.sqlite-wal");
        Check(File.Exists(walPath) && new FileInfo(walPath).Length > 32, "encrypted WAL exists during active connection");
        foreach (var file in Directory.EnumerateFiles(Path.Combine(directory, "db")))
        {
            var bytes = await ReadSharedBytesAsync(file);
            Check(bytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(marker)) < 0,
                "private catalog marker absent from " + Path.GetFileName(file));
        }

        await store.OpenedAsync(key, tagged.Id, LegacyUser);
        await WriteLegacySchemaAsync(holder, 1);
        await reopened.InitializeAsync(key);
        var migratedRating = await reopened.GetAsync(key, tagged.Id, LegacyUser);
        Check(migratedRating is { Rating: null, UserRating: null, RatingCount: 0 },
            "legacy unauthored scores do not become votes for a user or Admin");
        await using (var archived = holder.CreateCommand())
        {
            archived.CommandText = "SELECT rating FROM legacy_ratings WHERE media_id=$id;";
            archived.Parameters.AddWithValue("$id", tagged.Id.ToString("N"));
            Check(Convert.ToInt32(await archived.ExecuteScalarAsync()) == 9999,
                "legacy scores are preserved in the encrypted archive during migration");
        }
        Check((await reopened.GetSettingsAsync(key, "Admin")).GridColumns == settings.GridColumns
            && (await reopened.GetSettingsAsync(key, LegacyUser)).GridColumns == settings.GridColumns,
            "migration seeds independent Admin and legacy User settings from the previous shared preferences");
        Check((await List(reopened, photoHistoryQuery)).Items.Length == 0
            && (await List(reopened, videoHistoryQuery)).Items.Select(item => item.Id).SequenceEqual([video.Id])
            && (await reopened.GetAsync(key, video.Id))!.Views == 1,
            "v1 mixed-role opens are removed, keeping confirmed User playback");

        await reopened.OpenedAsync(key, tagged.Id, LegacyUser);
        await WriteLegacySchemaAsync(holder, 2);
        var afterMigration = new CatalogStore(directory, libraryId);
        await afterMigration.InitializeAsync(key);
        Check((await List(afterMigration, photoHistoryQuery)).Items.Select(item => item.Id).SequenceEqual([tagged.Id])
            && (await List(afterMigration, videoHistoryQuery)).Items.Select(item => item.Id).SequenceEqual([video.Id])
            && (await List(afterMigration, photoHistoryQuery, Friend)).Items.Length == 0,
            "v2 opens migrate intact to legacy User only");
        await afterMigration.OpenedAsync(key, excluded.Id, Friend);
        await afterMigration.InitializeAsync(key);
        Check((await List(afterMigration, photoHistoryQuery)).Items.Select(item => item.Id).SequenceEqual([tagged.Id])
            && (await List(afterMigration, photoHistoryQuery, Friend)).Items.Select(item => item.Id).SequenceEqual([excluded.Id]),
            "personal histories remain separate after reopening a migrated catalog");
    }
    finally { CryptographicOperations.ZeroMemory(derived); }

    var dictionary = TagDictionary.Load(Path.Combine(workspace, "shared", "tags.json"));
    var tagLabels = new Dictionary<string, string>
    {
        ["asia"] = "Asia", ["black"] = "Black", ["white"] = "White", ["latina"] = "Latina", ["european"] = "European",
        ["dark-hair"] = "Dark hair", ["light-hair"] = "Light hair", ["with-makeup"] = "With makeup",
        ["without-makeup"] = "Without makeup", ["with-tattoos"] = "With tattoos", ["without-tattoos"] = "Without tattoos"
    };
    Check(dictionary.AllIds.Count == 11 && dictionary.AllIds.ToHashSet().SetEquals(tagLabels.Keys),
        "built-in dictionary contains exactly the eleven requested tag IDs");
    Check(tagLabels.All(tag => dictionary.Label(tag.Key, "ru") == tag.Value && dictionary.Label(tag.Key, "en") == tag.Value),
        "every tag keeps its English label in both interface languages");
    using (var dictionaryJson = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(workspace, "shared", "tags.json"))))
    {
        var groups = dictionaryJson.RootElement.GetProperty("groups").EnumerateArray().ToArray();
        Check(groups.Select(group => group.GetProperty("ru").GetString()).SequenceEqual(["Раса", "Прическа", "Макияж", "Тату"])
            && groups.Select(group => group.GetProperty("en").GetString()).SequenceEqual(["Race", "Hairstyle", "Makeup", "Tattoos"])
            && dictionaryJson.RootElement.GetProperty("tags").EnumerateArray()
                .All(tag => !tag.TryGetProperty("ru", out _) && !tag.TryGetProperty("en", out _)),
            "only the four group headings have Russian and English localization");
    }
    Check(dictionary.Canonicalize("  Темные волосы  ") == "dark-hair"
        && dictionary.Canonicalize("DARK HAIR") == "dark-hair"
        && dictionary.Canonicalize("brunette") == "dark-hair"
        && dictionary.Canonicalize("asian") == "asia" && dictionary.Canonicalize("ebony") == "black"
        && dictionary.Canonicalize("blonde") == "light-hair" && dictionary.Canonicalize("tattooed") == "with-tattoos",
        "legacy Russian labels and former IDs resolve to their new canonical IDs");
    Check(!dictionary.TryCanonicalize("amateur", out _) && !dictionary.TryCanonicalize("Retired custom tag", out _),
        "retired and arbitrary tag names are absent from the allowed dictionary");
    Check(dictionary.Canonicalize("  Моя Метка  ") == "Моя Метка"
        && dictionary.Label("Моя Метка", "en") == "Моя Метка",
        "custom tags keep their spelling and language");

    var tagMigrationRoot = Path.Combine(directory, "tag-migration");
    var tagMigrationId = Guid.NewGuid();
    var oldTagStore = new CatalogStore(tagMigrationRoot, tagMigrationId);
    await oldTagStore.InitializeAsync(key);
    var oldHair = Item("photo", "Keep this photo and metadata", ["brunette", "Темные волосы", "amateur", "Retired custom tag"], favorite: true);
    var oldAppearance = Item("photo", "Keep former appearance tags", ["asian", "ebony", "blonde", "tattooed", "studio"]);
    var oldTrashed = Item("photo", "Keep trashed photo", ["Светлые волосы", "solo"]);
    await oldTagStore.AddAsync(key, oldHair, Hash(90));
    await oldTagStore.AddAsync(key, oldAppearance, Hash(91));
    await oldTagStore.AddAsync(key, oldTrashed, Hash(92));
    await oldTagStore.SetRatingAsync(key, oldHair.Id, LegacyUser, 8123);
    await oldTagStore.SaveSettingsAsync(key, new UiSettings { GridColumns = 7 }, LegacyUser);
    var retainedAlbum = await oldTagStore.CreateAlbumAsync(key, LegacyUser, "Retained album");
    await oldTagStore.SetAlbumItemAsync(key, LegacyUser, retainedAlbum.Id, oldHair.Id, true);
    await oldTagStore.TrashAsync(key, oldTrashed.Id);
    var oldTagQuery = Query() with { Limit = 1 };
    var oldTagPage = await List(oldTagStore, oldTagQuery);
    var migratedTags = new CatalogStore(tagMigrationRoot, tagMigrationId, dictionary);
    await migratedTags.InitializeAsync(key);
    var migratedHair = await migratedTags.GetAsync(key, oldHair.Id, LegacyUser);
    Check(migratedHair is { Rating: 8123, UserRating: 8123, RatingCount: 1, IsFavorite: true }
        && migratedHair.Title == oldHair.Title && migratedHair.Description == oldHair.Description
        && migratedHair.Size == oldHair.Size && migratedHair.CreatedAt == oldHair.CreatedAt
        && migratedHair.Tags.SequenceEqual(["dark-hair"]),
        "tag migration merges legacy spellings, removes retired/custom tags and preserves media metadata and votes");
    Check((await migratedTags.GetAsync(key, oldAppearance.Id))!.Tags.ToHashSet()
        .SetEquals(["asia", "black", "light-hair", "with-tattoos"]),
        "tag migration keeps matching appearance assignments under the new IDs");
    var migratedTrash = (await migratedTags.TrashListAsync(key)).Single();
    Check(migratedTrash.Id == oldTrashed.Id && migratedTrash.Tags.SequenceEqual(["light-hair"])
        && await migratedTags.GetAsync(key, oldTrashed.Id) is null,
        "tag migration updates trashed media without restoring or deleting it");
    Check((await migratedTags.GetSettingsAsync(key, LegacyUser)).GridColumns == 7
        && (await migratedTags.ListMediaAlbumIdsAsync(key, LegacyUser, oldHair.Id)).SequenceEqual([retainedAlbum.Id])
        && (await migratedTags.TagsAsync(key)).All(tag => dictionary.AllIds.Contains(tag)),
        "tag migration preserves account settings and albums and removes obsolete active tag names");
    await Throws<ArgumentException>(() => List(migratedTags, oldTagQuery with { Cursor = oldTagPage.NextCursor }),
        "tag migration invalidates cursors created for the former catalog revision");
    var migratedTagPage = await List(migratedTags, oldTagQuery);
    await migratedTags.InitializeAsync(key);
    Check((await List(migratedTags, oldTagQuery with { Cursor = migratedTagPage.NextCursor })).Items.Length == 1,
        "reopening the current dictionary leaves tags and catalog cursors unchanged");

    var legacy = Item("photo", "Legacy translated tag", ["Темные волосы"]);
    await store.AddAsync(key, legacy, Hash(100));
    var discovery = new CatalogStore(directory, libraryId, dictionary);
    Check((await List(discovery, Query() with { IncludeTags = ["dark-hair"] })).Items.Single().Id == legacy.Id,
        "new tag ID includes an existing Russian alias");
    var canonical = Item("photo", "Canonical tag", [dictionary.Canonicalize("Dark hair")]);
    await discovery.AddAsync(key, canonical, Hash(101));
    var aliasMatches = await List(discovery, Query() with { IncludeTags = ["Темные волосы"] });
    Check(aliasMatches.Items.Select(item => item.Id).ToHashSet().SetEquals([legacy.Id, canonical.Id]),
        "Russian tag filter matches both legacy spelling and canonical ID");
    var aliasExcluded = await List(discovery, Query() with { ExcludeTags = ["dark-hair"] });
    Check(aliasExcluded.Items.Select(item => item.Id).ToHashSet().SetEquals([tagged.Id, excluded.Id]),
        "canonical exclude filter removes both tag spellings");

    const string feedTag = "Synthetic feed sample";
    var feedItems = new List<MediaItem>();
    for (var index = 0; index < 20; index++)
    {
        string[] tags = index < 4 ? [feedTag, "dark-hair"] : [feedTag];
        int? rating = index < 10 ? 9000 - index * 100 : null;
        var candidate = Item("video", "Synthetic discovery " + index, tags, rating);
        feedItems.Add(candidate);
        await discovery.AddAsync(key, candidate, Hash(110 + index));
    }
    var feedQuery = Query() with { Type = "video", IncludeTags = [feedTag], Limit = 10 };
    var feed = await List(discovery, feedQuery);
    Check(feed.Items.Length == 10 && feed.Items.Count(item => item.Rating >= 7000) == 7 && feed.HasMore,
        "default recommendation page balances seven rated and three random candidates");
    var feedNext = await List(discovery, feedQuery with { Cursor = feed.NextCursor });
    var pagedFeed = feed.Items.Concat(feedNext.Items).Select(item => item.Id).ToArray();
    Check(!feedNext.HasMore && pagedFeed.Length == 20 && pagedFeed.Distinct().Count() == 20
        && pagedFeed.ToHashSet().SetEquals(feedItems.Select(item => item.Id)),
        "recommendation pagination covers its filtered candidates without repeats");

    var sourceId = feedItems[0].Id;
    var related = await discovery.RelatedAsync(key, sourceId, LegacyUser);
    Check(related.Length == 5 && related.Select(item => item.Id).Distinct().Count() == 5
        && related.All(item => item.Id != sourceId && item.Type == "video")
        && related.Take(3).Select(item => item.Id).SequenceEqual(feedItems.Skip(1).Take(3).Select(item => item.Id)),
        "related shelf places three strongest tag matches before two distinct random items and excludes itself");
    await discovery.SaveSettingsAsync(key, settings with { RelatedCount = 2, RandomRelatedCount = 1 }, LegacyUser);
    related = await discovery.RelatedAsync(key, sourceId, LegacyUser);
    Check(related.Length == 3 && related.Take(2).Select(item => item.Id).SequenceEqual(feedItems.Skip(1).Take(2).Select(item => item.Id)),
        "related shelf uses configured similar and random counts");

    const string profileGroup = "Private profile candidates";
    const string relatedGroup = "Private profile related";
    var firstTaste = Item("video", "First taste", [profileGroup, relatedGroup, "first taste"], 8000);
    var otherTaste = Item("video", "Other taste", [profileGroup, relatedGroup, "other taste"], 8000);
    var reference = Item("video", "Reference", [relatedGroup]);
    await discovery.AddAsync(key, firstTaste, Hash(201));
    await discovery.AddAsync(key, otherTaste, Hash(202));
    await discovery.AddAsync(key, reference, Hash(203));
    await discovery.RecordViewAsync(key, firstTaste.Id, LegacyUser);
    await discovery.RecordViewAsync(key, otherTaste.Id, Friend);
    await discovery.SaveSettingsAsync(key, settings with { RatedPercent = 100, RatingWeight = 0, RelatedCount = 1, RandomRelatedCount = 0 }, LegacyUser);
    await discovery.SaveSettingsAsync(key, settings with { RatedPercent = 100, RatingWeight = 0, RelatedCount = 1, RandomRelatedCount = 0 }, Friend);
    await discovery.SaveSettingsAsync(key, settings with { RatedPercent = 100, RatingWeight = 0, RelatedCount = 1, RandomRelatedCount = 0 }, "removed.account");
    await discovery.SaveSettingsAsync(key, settings with { RatedPercent = 100, RatingWeight = 0, RelatedCount = 1, RandomRelatedCount = 0 }, "fresh.account");
    var profileQuery = Query() with { Type = "video", IncludeTags = [profileGroup], Limit = 1 };
    Check((await List(discovery, profileQuery)).Items.Single().Id == firstTaste.Id
        && (await List(discovery, profileQuery, Friend)).Items.Single().Id == otherTaste.Id,
        "recommendation feed uses only the signed-in user's views");
    Check((await discovery.RelatedAsync(key, reference.Id, LegacyUser)).Single().Id == firstTaste.Id
        && (await discovery.RelatedAsync(key, reference.Id, Friend)).Single().Id == otherTaste.Id,
        "related matches use the signed-in user's preferences to resolve ties");
    await discovery.RecordViewAsync(key, firstTaste.Id, Friend);
    Check((await discovery.GetAsync(key, firstTaste.Id))!.Views == 2,
        "aggregate media view count remains shared across viewers");

    var album = await discovery.CreateAlbumAsync(key, LegacyUser, "  Private album  ");
    var otherAlbum = await discovery.CreateAlbumAsync(key, Friend, "Private album");
    Check(album.Name == "Private album"
        && (await discovery.ListAlbumsAsync(key, LegacyUser)).Single().Id == album.Id
        && (await discovery.ListAlbumsAsync(key, Friend)).Single().Id == otherAlbum.Id,
        "each user sees only their own albums even when names match");
    await discovery.SetAlbumItemAsync(key, LegacyUser, album.Id, tagged.Id, true);
    await discovery.SetAlbumItemAsync(key, LegacyUser, album.Id, firstTaste.Id, true);
    await discovery.SetAlbumItemAsync(key, LegacyUser, album.Id, firstTaste.Id, true);
    await discovery.SetAlbumItemAsync(key, Friend, otherAlbum.Id, firstTaste.Id, true);
    Check((await discovery.ListMediaAlbumIdsAsync(key, LegacyUser, firstTaste.Id)).SequenceEqual([album.Id])
        && (await discovery.ListMediaAlbumIdsAsync(key, Friend, firstTaste.Id)).SequenceEqual([otherAlbum.Id]),
        "membership lookup returns only albums owned by the signed-in user");
    var albumPage = await discovery.ListAlbumItemsAsync(key, LegacyUser, album.Id, 1, null);
    var nextAlbumPage = await discovery.ListAlbumItemsAsync(key, LegacyUser, album.Id, 1, albumPage.NextCursor);
    Check(albumPage.HasMore && !nextAlbumPage.HasMore
        && albumPage.Items.Concat(nextAlbumPage.Items).Select(item => item.Id).ToHashSet().SetEquals([tagged.Id, firstTaste.Id])
        && (await discovery.ListAlbumsAsync(key, LegacyUser)).Single().ItemCount == 2,
        "album membership is idempotent and paginates across media types");
    await Throws<KeyNotFoundException>(() => discovery.ListAlbumItemsAsync(key, Friend, album.Id, 1, null), "foreign album contents are inaccessible");
    await Throws<KeyNotFoundException>(() => discovery.RenameAlbumAsync(key, Friend, album.Id, "Forbidden"), "foreign album rename is rejected");
    await Throws<KeyNotFoundException>(() => discovery.SetAlbumItemAsync(key, Friend, album.Id, tagged.Id, false), "foreign album membership change is rejected");
    await Throws<KeyNotFoundException>(() => discovery.DeleteAlbumAsync(key, Friend, album.Id), "foreign album deletion is rejected");
    await Throws<ArgumentException>(() => discovery.ListAlbumItemsAsync(key, Friend, otherAlbum.Id, 1, albumPage.NextCursor),
        "album cursor cannot be reused for a different album or owner");
    var renamed = await discovery.RenameAlbumAsync(key, LegacyUser, album.Id, "Renamed");
    Check(renamed.Name == "Renamed" && renamed.ItemCount == 2, "album rename keeps its media links");
    await discovery.TrashAsync(key, tagged.Id);
    Check((await discovery.ListAlbumsAsync(key, LegacyUser)).Single().ItemCount == 1
        && (await discovery.ListAlbumItemsAsync(key, LegacyUser, album.Id, 10, null)).Items.Single().Id == firstTaste.Id,
        "trashed media is hidden from private album contents and counts");
    await discovery.RestoreAsync(key, tagged.Id);
    Check((await discovery.ListAlbumsAsync(key, LegacyUser)).Single().ItemCount == 2, "restoring shared media restores its album links");
    await discovery.SetAlbumItemAsync(key, LegacyUser, album.Id, tagged.Id, false);
    await discovery.DeleteAlbumAsync(key, LegacyUser, album.Id);
    Check((await discovery.ListAlbumsAsync(key, LegacyUser)).Length == 0
        && (await discovery.ListAlbumsAsync(key, Friend)).Single().ItemCount == 1
        && await discovery.GetAsync(key, tagged.Id) is not null,
        "removing private links or an album never deletes shared media or another user's links");

    const string removedUser = "removed.account";
    const string freshUser = "fresh.account";
    var neutralRelated = (await discovery.RelatedAsync(key, reference.Id, freshUser)).First().Id;
    var removedTaste = neutralRelated == firstTaste.Id ? otherTaste.Id : firstTaste.Id;
    await discovery.RecordViewAsync(key, removedTaste, removedUser);
    await discovery.OpenedAsync(key, tagged.Id, removedUser);
    await discovery.OpenedAsync(key, firstTaste.Id, removedUser);
    var removedAlbum = await discovery.CreateAlbumAsync(key, removedUser, "Account to remove");
    await discovery.SetAlbumItemAsync(key, removedUser, removedAlbum.Id, tagged.Id, true);
    Check((await discovery.RelatedAsync(key, reference.Id, removedUser)).First().Id == removedTaste
        && removedTaste != neutralRelated,
        "deletion fixture has personal preferences different from a fresh account");
    var removedCursor = (await List(discovery, profileQuery, removedUser)).NextCursor;
    Check(removedCursor is not null, "deletion fixture has a personal feed continuation");
    var sharedQuery = Query() with { Type = "", Sort = "name_asc", Limit = 150 };
    var sharedBeforeDeletion = JsonSerializer.Serialize((await List(discovery, sharedQuery)).Items);
    var countsBeforeDeletion = JsonSerializer.Serialize(await discovery.HomeAsync(key));
    var friendHistoryBeforeDeletion = (await List(discovery, videoHistoryQuery, Friend)).Items.Select(item => item.Id).ToArray();
    var friendPhotosBeforeDeletion = (await List(discovery, photoHistoryQuery, Friend)).Items.Select(item => item.Id).ToArray();
    var friendRelatedBeforeDeletion = (await discovery.RelatedAsync(key, reference.Id, Friend)).Select(item => item.Id).ToArray();
    var friendFeedBeforeDeletion = (await List(discovery, profileQuery, Friend)).Items.Select(item => item.Id).ToArray();

    await discovery.DeletePersonalDataAsync(key, removedUser);
    Check((await List(discovery, videoHistoryQuery, removedUser)).Items.Length == 0
        && (await List(discovery, photoHistoryQuery, removedUser)).Items.Length == 0
        && (await discovery.ListAlbumsAsync(key, removedUser)).Length == 0
        && (await discovery.ListMediaAlbumIdsAsync(key, removedUser, tagged.Id)).Length == 0,
        "account deletion removes history, albums and private media membership");
    await Throws<KeyNotFoundException>(() => discovery.ListAlbumItemsAsync(key, removedUser, removedAlbum.Id, 10, null),
        "deleted private album cannot be reopened by the same username");
    Check((await List(discovery, profileQuery, removedUser)).Items.Select(item => item.Id)
            .SequenceEqual((await List(discovery, profileQuery, freshUser)).Items.Select(item => item.Id))
        && (await discovery.RelatedAsync(key, reference.Id, removedUser)).First().Id == neutralRelated,
        "deleted account recommendations return to a fresh profile in both feed and related shelf");
    Check((await List(discovery, videoHistoryQuery, Friend)).Items.Select(item => item.Id).SequenceEqual(friendHistoryBeforeDeletion)
        && (await List(discovery, photoHistoryQuery, Friend)).Items.Select(item => item.Id).SequenceEqual(friendPhotosBeforeDeletion)
        && (await discovery.ListAlbumsAsync(key, Friend)).First().Id == otherAlbum.Id
        && (await discovery.ListAlbumItemsAsync(key, Friend, otherAlbum.Id, 10, null)).Items.First().Id == firstTaste.Id
        && (await discovery.RelatedAsync(key, reference.Id, Friend)).Select(item => item.Id).SequenceEqual(friendRelatedBeforeDeletion)
        && (await List(discovery, profileQuery, Friend)).Items.Select(item => item.Id).SequenceEqual(friendFeedBeforeDeletion),
        "deleting one account preserves another account's history, albums and recommendations");
    Check(JsonSerializer.Serialize((await List(discovery, sharedQuery)).Items) == sharedBeforeDeletion
        && JsonSerializer.Serialize(await discovery.HomeAsync(key)) == countsBeforeDeletion,
        "account deletion preserves every shared media item, tag, rating, favorite, view count and category total");
    await discovery.DeletePersonalDataAsync(key, removedUser);
    Check((await discovery.ListAlbumsAsync(key, removedUser)).Length == 0
        && (await List(discovery, videoHistoryQuery, removedUser)).Items.Length == 0
        && JsonSerializer.Serialize((await List(discovery, sharedQuery)).Items) == sharedBeforeDeletion,
        "repeating completed personal-data deletion is safe");

    // Reusing the username can repeat the old activity count. Its old cursor
    // must still be rejected, and only the new viewing preference may apply.
    var reusedTaste = removedTaste == firstTaste.Id ? otherTaste.Id : firstTaste.Id;
    await discovery.RecordViewAsync(key, reusedTaste, removedUser);
    await discovery.OpenedAsync(key, tagged.Id, removedUser);
    await discovery.OpenedAsync(key, firstTaste.Id, removedUser);
    Check((await discovery.RelatedAsync(key, reference.Id, removedUser)).First().Id == reusedTaste,
        "a reused username learns only its new viewing preferences");
    await Throws<ArgumentException>(() => List(discovery, profileQuery with { Cursor = removedCursor }, removedUser),
        "a deleted account's cursor stays invalid when the username repeats its former activity count");
    var affinityStore = new CatalogStore(Path.Combine(directory, "affinity"), Guid.NewGuid());
    await affinityStore.InitializeAsync(key);
    var tasteSource = Item("video", "Viewed preference", ["preferred"]);
    var focused = Item("video", "Focused match", ["preferred"], 8000);
    var diluted = Item("video", "Many unrelated tags", ["preferred", "unrelated-a", "unrelated-b", "unrelated-c"], 8000);
    var unrelatedCandidate = Item("video", "Unrelated", ["other"], 8000);
    var affinityCandidates = new[] { tasteSource, focused, diluted, unrelatedCandidate };
    for (var i = 0; i < affinityCandidates.Length; i++)
        await affinityStore.AddAsync(key, affinityCandidates[i], Hash(3000 + i));
    await affinityStore.SaveSettingsAsync(key, new UiSettings { RatedPercent = 100, MinimumRating = 1, RatingWeight = 0 }, "affinity.user");
    await affinityStore.RecordViewAsync(key, tasteSource.Id, "affinity.user");
    var affinityFeed = await List(affinityStore, Query() with { Type = "video", Limit = 20 }, "affinity.user");
    var affinityOrder = affinityFeed.Items.Select(item => item.Id).ToList();
    Check(affinityOrder.IndexOf(focused.Id) < affinityOrder.IndexOf(diluted.Id)
        && affinityOrder.IndexOf(diluted.Id) < affinityOrder.IndexOf(unrelatedCandidate.Id),
        "recommendation affinity averages tag weights so adding unrelated tags cannot improve relevance");
    var fallbackStore = new CatalogStore(Path.Combine(directory, "related-fallback"), Guid.NewGuid());
    await fallbackStore.InitializeAsync(key);
    var fallbackReference = Item("video", "Reference", ["reference-only"]);
    await fallbackStore.AddAsync(key, fallbackReference, Hash(4000));
    for (var i = 0; i < 6; i++)
        await fallbackStore.AddAsync(key, Item("video", "Unrelated " + i, ["other-" + i]), Hash(4001 + i));
    var fallbackRelated = await fallbackStore.RelatedAsync(key, fallbackReference.Id, "fallback.user");
    Check(fallbackRelated.Length == 5 && fallbackRelated.Select(item => item.Id).Distinct().Count() == 5
        && fallbackRelated.All(item => item.Id != fallbackReference.Id),
        "related shelf fills missing similar slots with distinct random videos");
    var onlyMatch = Item("video", "Only matching video", ["reference-only"]);
    await fallbackStore.AddAsync(key, onlyMatch, Hash(4007));
    fallbackRelated = await fallbackStore.RelatedAsync(key, fallbackReference.Id, "fallback.user");
    Check(fallbackRelated.Length == 5 && fallbackRelated[0].Id == onlyMatch.Id
        && fallbackRelated.Select(item => item.Id).Distinct().Count() == 5,
        "related fallback preserves available similar videos before filling the remaining slots");
    await fallbackStore.SaveSettingsAsync(key, new UiSettings { RelatedCount = 6, RandomRelatedCount = 4 }, "fallback.user");
    fallbackRelated = await fallbackStore.RelatedAsync(key, fallbackReference.Id, "fallback.user");
    Check(fallbackRelated.Length == 7 && fallbackRelated.Select(item => item.Id).Distinct().Count() == 7,
        "small related pools return all available videos without duplicates");
    var voting = new CatalogStore(Path.Combine(directory, "voting"), Guid.NewGuid());
    await voting.InitializeAsync(key);
    var votedPhoto = Item("photo", "Independent user votes", []);
    await voting.AddAsync(key, votedPhoto, Hash(5000));
    await Task.WhenAll(voting.SetRatingAsync(key, votedPhoto.Id, "alice", 1000),
        voting.SetRatingAsync(key, votedPhoto.Id, "bob", 3000));
    Check(await voting.GetAsync(key, votedPhoto.Id, "alice") is { Rating: 2000, UserRating: 1000, RatingCount: 2 },
        "concurrent user votes retain both votes and the correct aggregate");
    await voting.SaveSettingsAsync(key, new UiSettings { GridColumns = 4 }, "alice");
    await voting.SaveSettingsAsync(key, new UiSettings { GridColumns = 7 }, "bob");
    await voting.DeletePersonalDataAsync(key, "alice");
    Check(await voting.GetAsync(key, votedPhoto.Id, "bob") is { Rating: 3000, UserRating: 3000, RatingCount: 1 }
        && await voting.GetAsync(key, votedPhoto.Id, "alice") is { UserRating: null },
        "deleting an account removes only its votes and recomputes the mean");
    Check((await voting.GetSettingsAsync(key, "alice")).GridColumns == new UiSettings().GridColumns
        && (await voting.GetSettingsAsync(key, "bob")).GridColumns == 7,
        "reused usernames receive fresh settings while other account preferences remain intact");
    await voting.SetRatingAsync(key, votedPhoto.Id, "bob", null);
    Check(await voting.GetAsync(key, votedPhoto.Id, "bob") is { Rating: null, UserRating: null, RatingCount: 0 },
        "removing the last user vote restores an unrated media item");
    Console.WriteLine($"PASS: {passed} catalog checks. Synthetic test artifacts remain under .cache/test-catalog.");
}
finally { CryptographicOperations.ZeroMemory(key); }

MediaItem Item(string type, string title, string[] tags, int? rating = null, bool favorite = false) =>
    new(Guid.NewGuid(), type, title, "Synthetic test description", rating, 0, favorite, 1234,
        DateTimeOffset.UtcNow, tags, type == "video" ? "video/mp4" : "image/png");
MediaQuery Query() => new("photo", "", [], [], "home", "random", "repeatable", 60, null);
Task<MediaPage> List(CatalogStore catalog, MediaQuery query, string user = LegacyUser) => catalog.ListAsync(key, query, user);
string Hash(int value) => Convert.ToHexString(SHA256.HashData(BitConverter.GetBytes(value))).ToLowerInvariant();
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    passed++;
    Console.WriteLine("PASS: " + name);
}
async Task<T> Throws<T>(Func<Task> action, string name) where T : Exception
{
    try { await action(); }
    catch (T exception) { passed++; Console.WriteLine("PASS: " + name); return exception; }
    throw new Exception("FAIL: " + name);
}

static async Task<byte[]> ReadSharedBytesAsync(string path)
{
    await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    using var output = new MemoryStream();
    await stream.CopyToAsync(output);
    return output.ToArray();
}

static async Task WriteLegacySchemaAsync(SqliteConnection connection, int version)
{
    using var transaction = connection.BeginTransaction();
    await using var command = connection.CreateCommand();
    command.Transaction = transaction;
    command.CommandText = $"""
        DROP TABLE user_ratings;
        DROP TABLE legacy_ratings;
        DELETE FROM settings WHERE key LIKE 'user:%';
        DROP TABLE album_items;
        DROP TABLE albums;
        DROP TABLE user_activity;
        ALTER TABLE recent_opened RENAME TO recent_opened_new;
        ALTER TABLE view_events RENAME TO view_events_new;
        CREATE TABLE recent_opened(
          media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN('video','photo','gif')),opened_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX ix_recent_type_time ON recent_opened(type,opened_at DESC,media_id DESC);
        CREATE TABLE view_events(
          id INTEGER PRIMARY KEY,media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,occurred_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX ix_views_time ON view_events(occurred_at DESC,id DESC);
        INSERT INTO recent_opened(media_id,type,opened_at)
        SELECT media_id,type,opened_at FROM recent_opened_new WHERE user_id='User';
        INSERT INTO view_events(id,media_id,occurred_at)
        SELECT id,media_id,occurred_at FROM view_events_new WHERE user_id='User';
        DROP TABLE recent_opened_new;
        DROP TABLE view_events_new;
        PRAGMA user_version={version};
        """;
    await command.ExecuteNonQueryAsync();
    transaction.Commit();
}
