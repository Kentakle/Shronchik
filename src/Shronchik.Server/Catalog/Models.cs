namespace Shronchik.Server.Catalog;

public sealed record MediaItem(Guid Id, string Type, string Title, string Description,
    int? Rating, long Views, bool IsFavorite, long Size, DateTimeOffset CreatedAt,
    string[] Tags, string MimeType)
{
    public string? PosterVersion { get; init; }
    public int? UserRating { get; init; }
    public int RatingCount { get; init; }
}

public sealed record MediaQuery(string Type, string Query, string[] IncludeTags,
    string[] ExcludeTags, string Tab, string Sort, string Seed, int Limit,
    string? Cursor);

public sealed record MediaPage(MediaItem[] Items, string? NextCursor, bool HasMore);
public sealed record AlbumSummary(Guid Id, string Name, long ItemCount, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public sealed record UiSettings(string Language = "ru", int GridColumns = 10,
    int AnimationMs = 300, int AfkMinutes = 5, string AccentColor = "#B9A1EF")
{
    public const int CurrentSchemaVersion = 2;
    public int SchemaVersion { get; init; } = CurrentSchemaVersion;
    public string Theme { get; init; } = "custom_dark";
    public string BackgroundColor { get; init; } = "#111116";
    public string SurfaceColor { get; init; } = "#1A1A22";
    public string TextColor { get; init; } = "#F4F3F7";
    public string MutedTextColor { get; init; } = "#A4A0AF";
    public double ShadowStrength { get; init; } = 0.35;
    public double HoverNeighborDim { get; init; } = 0.18;
    public int CardRadiusPx { get; init; } = 14;
    public string ReduceMotion { get; init; } = "auto";
    public int GridGapPx { get; init; } = 12;
    public string CardAspectRatio { get; init; } = "16:9";
    public int CardTitleLines { get; init; } = 2;
    public bool SidebarExpanded { get; init; }
    public bool ShowSkeletons { get; init; } = true;
    public double FontScale { get; init; } = 1;

    public double Volume { get; init; } = 0.7;
    public int SeekSeconds { get; init; } = 5;
    public int HoverDelayMs { get; init; } = 300;
    public int ThumbnailCandidates { get; init; } = 5;
    public int GifVisibilityMarginPx { get; init; } = 80;
    public int MaxAnimatedCards { get; init; } = 12;
    public string GpuDecodePreference { get; init; } = "auto";
    public int RamCacheMB { get; init; } = 512;
    public bool ShowRelatedBelow { get; init; } = true;

    public int RatedPercent { get; init; } = 70;
    public int MinimumRating { get; init; } = 7000;
    public double RatingWeight { get; init; } = 0.6;
    public int RelatedCount { get; init; } = 3;
    public int RandomRelatedCount { get; init; } = 2;
    public int QueryDebounceMs { get; init; } = 200;
    public int PageBatchSize { get; init; } = 60;

    public int TrashRetentionDays { get; init; } = 30;
    public string VerifyOnStartup { get; init; } = "quick";
    public int BackupReminderDays { get; init; } = 7;
    public int WorkerConcurrency { get; init; } = 2;
    public int MaxTranscodes { get; init; } = 1;
    public bool PauseOnBattery { get; init; }
    public int FfmpegThreads { get; init; }
    public int LowDiskWarningGB { get; init; } = 5;
    public HotkeySettings Hotkeys { get; init; } = new();
}

public sealed record HotkeySettings(
    string PlayPause = "Space", string SeekBackward = "ArrowLeft", string SeekForward = "ArrowRight",
    string VolumeUp = "ArrowUp", string VolumeDown = "ArrowDown", string ToggleFullscreen = "F",
    string ExitFullscreen = "Escape", string ToggleMute = "M", string ToggleFilters = "Ctrl+F",
    string GoHome = "Alt+Home", string Lock = "Ctrl+Shift+L",
    string NextMedia = "Alt+ArrowRight", string PreviousMedia = "Alt+ArrowLeft");

public sealed class DuplicateMediaException(Guid id) : Exception("Media already exists in the library.")
{
    public Guid Id { get; } = id;
}
