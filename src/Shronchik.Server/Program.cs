using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Net;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.HttpOverrides;
using Shronchik.Server.Tags;
using Shronchik.Core.Crypto;
using Shronchik.Server.Auth;
using Shronchik.Server.Catalog;
using Shronchik.Server.Media;
using Shronchik.Server.Storage;

var builder = WebApplication.CreateBuilder(args);
var port = int.TryParse(Environment.GetEnvironmentVariable("SHRONCHIK_PORT"), out var selectedPort) ? selectedPort : 5271;
if (port is < 1024 or > 65535) throw new InvalidOperationException("Invalid SHRONCHIK_PORT.");
var publicOriginText = Environment.GetEnvironmentVariable("SHRONCHIK_PUBLIC_ORIGIN");
Uri? publicOrigin = null;
if (!string.IsNullOrWhiteSpace(publicOriginText))
{
    if (!Uri.TryCreate(publicOriginText, UriKind.Absolute, out publicOrigin) || publicOrigin.Scheme != "https"
        || publicOrigin.AbsolutePath != "/" || publicOrigin.UserInfo.Length > 0
        || publicOrigin.Query.Length > 0 || publicOrigin.Fragment.Length > 0)
        throw new InvalidOperationException("SHRONCHIK_PUBLIC_ORIGIN must be an HTTPS origin without a path.");
}
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
// Large bodies are allowed only on the streaming import endpoint.
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 64 * 1024);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
var configuredLibraryRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("SHRONCHIK_LIBRARY")
    ?? Path.Combine(builder.Environment.ContentRootPath, "../../data/library"));
var storageConfigPath = Path.GetFullPath(Environment.GetEnvironmentVariable("SHRONCHIK_STORAGE_CONFIG")
    ?? configuredLibraryRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + ".location.json");
using var storage = new LibraryStorage(LibraryStorage.ResolveRoot(configuredLibraryRoot, storageConfigPath), storageConfigPath);
var libraryRoot = storage.Root;
var identities = new IdentityStore(libraryRoot);
await identities.LoadAsync();
// Admin is restricted to the direct local listener below. Only accounts that
// can sign in through the public origin must satisfy the hosting password gate.
if (publicOrigin is not null && identities.Identity.Accounts.Any(pair => pair.Key != IdentityStore.AdminId
    && pair.Value.Enabled && pair.Value.WeakPassword))
    throw new InvalidOperationException("Change weak user passwords or disable those accounts locally before enabling SHRONCHIK_PUBLIC_ORIGIN.");
var tagDictionary = TagDictionary.Load(Path.Combine(AppContext.BaseDirectory, "tags.json"));
var catalog = new CatalogStore(libraryRoot, identities.LibraryId, tagDictionary);
var cipher = new VaultCipher();
var posters = new MediaPosterStore(libraryRoot, cipher);
var sessions = new SessionStore();
builder.Services.AddSingleton(sessions);
builder.Services.AddHostedService(provider => provider.GetRequiredService<SessionStore>());
var app = builder.Build();
// Decide before proxy middleware can rewrite the peer address and Host. An
// administrator must use the local listener directly, never a forwarded route.
app.Use((ctx, next) =>
{
    var remote = ctx.Connection.RemoteIpAddress;
    if (remote?.IsIPv4MappedToIPv6 == true) remote = remote.MapToIPv4();
    var host = ctx.Request.Host;
    var localPort = host.Port == port || (app.Environment.IsDevelopment() && host.Port == 5173);
    var forwarded = ctx.Request.Headers.Keys.Any(name =>
        name.Equals("Forwarded", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("X-Original-", StringComparison.OrdinalIgnoreCase));
    ctx.Items["localAdminRequest"] = remote is not null && IPAddress.IsLoopback(remote)
        && host.Host is "127.0.0.1" or "localhost" && localPort && !forwarded;
    return next(ctx);
});
if (publicOrigin is not null)
{
    var proxy = new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost,
        ForwardLimit = 1
    };
    proxy.KnownIPNetworks.Clear();
    proxy.KnownProxies.Clear();
    proxy.KnownProxies.Add(IPAddress.Loopback);
    proxy.KnownProxies.Add(IPAddress.IPv6Loopback);
    proxy.AllowedHosts.Add(publicOrigin.Host);
    app.UseForwardedHeaders(proxy);
}
var authGate = new SemaphoreSlim(1, 1);
var authWaiters = new SemaphoreSlim(32, 32);
var importGate = new SemaphoreSlim(1, 1);
var settingsGate = new SemaphoreSlim(1, 1);
var loginBackoff = new Dictionary<string, (int Failures, DateTimeOffset RetryAt)>(StringComparer.Ordinal);
var storageRequests = new StorageRequestGate();

app.Use(async (ctx, next) =>
{
    // Error responses clear their body headers. Apply these at send time so
    // failed/oversized requests keep the same privacy protections as successes.
    ctx.Response.OnStarting(() =>
    {
        ctx.Response.Headers.CacheControl = "no-store, max-age=0";
        ctx.Response.Headers.Pragma = "no-cache";
        ctx.Response.Headers.XContentTypeOptions = "nosniff";
        ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
        ctx.Response.Headers["X-Frame-Options"] = "DENY";
        ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        ctx.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
        return Task.CompletedTask;
    });
    try
    {
        var storageChange = HttpMethods.IsPost(ctx.Request.Method)
            && ctx.Request.Path.Value is "/api/v1/storage/move" or "/api/v1/storage/connect";
        using var storageRequest = ctx.Request.Path.StartsWithSegments("/api/v1") ? storageRequests.Enter() : null;
        using var storageCancellation = storageRequest is not null && !storageChange
            ? CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted, storageRequest.Token) : null;
        if (storageCancellation is not null) ctx.RequestAborted = storageCancellation.Token;
        var host = ctx.Request.Host;
        // A forwarded host left unconsumed was rejected by the proxy allowlist
        // or exceeded the single trusted proxy hop.
        if (publicOrigin is not null && ctx.Request.Headers.ContainsKey("X-Forwarded-Host"))
            throw new ApiError(403, "invalid_host");
        var validPort = host.Port == port || (app.Environment.IsDevelopment() && host.Port == 5173);
        var localHost = host.Host is "127.0.0.1" or "localhost" && validPort;
        var configuredHost = publicOrigin is not null && ctx.Request.IsHttps
            && string.Equals(host.Host, publicOrigin.Host, StringComparison.OrdinalIgnoreCase)
            && (host.Port ?? 443) == publicOrigin.Port;
        if (!localHost && !configuredHost)
            throw new ApiError(403, "invalid_host");
        var mutation = !HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method);
        if (mutation)
        {
            var expectedOrigin = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
            if (!string.Equals(ctx.Request.Headers.Origin, expectedOrigin, StringComparison.Ordinal))
                throw new ApiError(403, "invalid_origin");
        }
        var bodyLimit = ctx.GetEndpoint()?.Metadata.GetMetadata<RequestBodyLimit>()?.Bytes ?? 64 * 1024;
        if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } bodyFeature)
            bodyFeature.MaxRequestBodySize = bodyLimit;
        if (ctx.Request.ContentLength > bodyLimit) throw new ApiError(413, "request_too_large");
        var session = sessions.Find(ctx);
        var account = identities.Find(session?.AccountId);
        if (session is not null && account is not { Enabled: true })
        {
            sessions.Remove(session);
            session = null;
        }
        if (session?.Role == "Admin") RequireLocalAdmin(ctx);
        session?.CheckIdle();
        ctx.Items["session"] = session;
        if (ctx.Request.Path.StartsWithSegments("/api/v1"))
        {
            var path = ctx.Request.Path.Value!;
            var publicPath = path is "/api/v1/auth/login" or "/api/v1/session" or "/api/v1/health";
            if (!publicPath)
            {
                if (session is null) throw new ApiError(401, "unauthorized");
                if (mutation && !FixedEquals(ctx.Request.Headers["X-CSRF-Token"].ToString(), session.CsrfToken))
                    throw new ApiError(403, "invalid_csrf");
                if (path is not ("/api/v1/auth/unlock" or "/api/v1/auth/logout" or "/api/v1/auth/lock"))
                {
                    if (account?.MustChangePassword == true && path != "/api/v1/auth/password/self")
                        throw new ApiError(403, "password_change_required");
                    using var lease = session.Acquire() ?? throw new ApiError(423, "locked");
                    using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted, lease.Token);
                    ctx.Items["key"] = lease.Key;
                    ctx.Items["cancel"] = cancellation.Token;
                    // Authenticate before interrupting streams, and drain even logins and settings writes.
                    using var transition = storageChange
                        ? await BeginStorageChange(ctx, storageRequest!) : null;
                    await next(ctx);
                    return;
                }
            }
        }
        await next(ctx);
    }
    catch (OperationCanceledException) { ctx.Abort(); }
    catch (Exception ex)
    {
        var (status, code) = ex switch
        {
            ApiError error => (error.Status, error.Code),
            StorageException error => (error.Status, error.Code),
            DuplicateMediaException => (409, "duplicate_media"),
            PosterAlreadyExistsException => (403, "forbidden"),
            KeyNotFoundException => (404, "not_found"),
            BadHttpRequestException { StatusCode: 413 } => (413, "request_too_large"),
            ArgumentException or JsonException or BadHttpRequestException => (400, "invalid_request"),
            CryptographicException or InvalidDataException => (422, "corrupt_media"),
            IOException or UnauthorizedAccessException => (503, "storage_unavailable"),
            _ => (500, "internal_error")
        };
        if (status == 500) app.Logger.LogError("Unhandled API failure of type {ExceptionType}", ex.GetType().Name);
        if (ctx.Response.HasStarted) ctx.Abort();
        else
        {
            ctx.Response.Clear();
            ctx.Response.Headers.CacheControl = "no-store";
            ctx.Response.StatusCode = status;
            await ctx.Response.WriteAsJsonAsync(new { code, messageKey = $"errors.{code}" });
        }
    }
});

async Task<IDisposable> BeginStorageChange(HttpContext ctx, StorageRequestGate.RequestLease request)
{
    Admin(ctx);
    RequireLocalAdmin(ctx);
    return await storageRequests.BeginTransitionAsync(request, ctx.RequestAborted);
}

app.MapGet("/api/v1/health", () => new { status = "ok", version = "0.1.0", stage = "prototype" });
object SessionInfo(AppSession? s) => new
{
    authenticated = s is not null,
    locked = s?.Locked ?? false,
    role = s?.Role,
    accountId = s?.AccountId,
    csrfToken = s?.CsrfToken,
    canUpload = identities.CanUpload(s?.AccountId),
    weakPassword = identities.Find(s?.AccountId)?.WeakPassword == true,
    mustChangePassword = identities.Find(s?.AccountId)?.MustChangePassword == true
};
app.MapGet("/api/v1/session", (HttpContext ctx) => SessionInfo((AppSession?)ctx.Items["session"]));

// Keep credential verification, session creation and account changes serialized
// so a login cannot finish with an account that has just been disabled or reset.
async Task<T> WithAuthGate<T>(CancellationToken ct, Func<Task<T>> operation)
{
    // Keep expensive password derivation serialized without retaining an
    // unbounded queue of already parsed login requests during a burst.
    if (!await authWaiters.WaitAsync(0, ct)) throw new ApiError(429, "rate_limited");
    try
    {
        await authGate.WaitAsync(ct);
        try { return await operation(); }
        finally { authGate.Release(); }
    }
    finally { authWaiters.Release(); }
}

async Task<byte[]> CheckPassword(string? accountId, string? password, CancellationToken ct)
{
    // Unknown names share one bucket, bounding memory when unauthenticated requests invent IDs.
    var bucket = accountId is not null && identities.Find(accountId) is not null ? accountId : string.Empty;
    loginBackoff.TryGetValue(bucket, out var backoff);
    var now = DateTimeOffset.UtcNow;
    if (now < backoff.RetryAt) throw new ApiError(429, "rate_limited");
    var key = await identities.UnlockAsync(accountId, password, ct);
    if (key is null)
    {
        var failures = backoff.RetryAt.AddMinutes(5) < now ? 1 : Math.Min(backoff.Failures + 1, 8);
        loginBackoff[bucket] = (failures, now.AddMilliseconds(Math.Min(30_000, 500 * (1 << failures))));
        throw new ApiError(401, "invalid_credentials");
    }
    loginBackoff.Remove(bucket);
    return key;
}

app.MapPost("/api/v1/auth/login", (HttpContext ctx, LoginRequest request) => WithAuthGate(ctx.RequestAborted, async () =>
{
    var accountId = IdentityStore.NormalizeAccountId(request.Username ?? request.Role);
    if (accountId == IdentityStore.AdminId) RequireLocalAdmin(ctx);
    var key = await CheckPassword(accountId, request.Password, ctx.RequestAborted);
    UiSettings settings;
    try
    {
        await catalog.InitializeAsync(key, ctx.RequestAborted);
        if (accountId == IdentityStore.AdminId)
        {
            foreach (var pending in identities.Identity.Accounts.Where(pair => pair.Value.PendingDeletion).Select(pair => pair.Key).ToArray())
            {
                await sessions.RevokeAccountAndDrainAsync(pending, ctx.RequestAborted);
                await catalog.DeletePersonalDataAsync(key, pending, ctx.RequestAborted);
                await identities.CompleteDeletionAsync(pending, ctx.RequestAborted);
            }
        }
        settings = await catalog.GetSettingsAsync(key, accountId!, ctx.RequestAborted);
    }
    catch { CryptographicOperations.ZeroMemory(key); throw; }
    var old = sessions.Find(ctx);
    if (old is not null) sessions.Remove(old);
    var session = sessions.Create(accountId!, key);
    session.AfkMinutes = settings.AfkMinutes;
    ctx.Response.Cookies.Append(SessionStore.Cookie, session.Id, new CookieOptions
    {
        HttpOnly = true, SameSite = SameSiteMode.Strict, Secure = ctx.Request.IsHttps,
        Path = "/", IsEssential = true, MaxAge = TimeSpan.FromHours(24)
    });
    return SessionInfo(session);
}));
app.MapPost("/api/v1/auth/unlock", (HttpContext ctx, UnlockRequest request) => WithAuthGate(ctx.RequestAborted, async () =>
{
    var session = Session(ctx);
    var key = await CheckPassword(session.AccountId, request.Password, ctx.RequestAborted);
    if (!session.Unlock(key)) throw new ApiError(401, "unauthorized");
    return SessionInfo(session);
}));
app.MapPost("/api/v1/auth/lock", (HttpContext ctx) => { var s = Session(ctx); s.Lock(); return SessionInfo(s); });
app.MapPost("/api/v1/auth/logout", (HttpContext ctx) =>
{
    sessions.Remove(Session(ctx));
    ctx.Response.Cookies.Delete(SessionStore.Cookie);
    return SessionInfo(null);
});
app.MapPost("/api/v1/auth/password", (HttpContext ctx, PasswordRequest request) => WithAuthGate(Cancel(ctx), async () =>
{
    var session = Admin(ctx);
    var accountId = IdentityStore.NormalizeAccountId(request.Role);
    if (accountId is not (IdentityStore.AdminId or IdentityStore.LegacyUserId))
        throw new ApiError(400, "invalid_request");
    var verified = await CheckPassword(IdentityStore.AdminId, request.CurrentPassword, Cancel(ctx));
    try
    {
        if (!CryptographicOperations.FixedTimeEquals(verified, Key(ctx))) throw new ApiError(401, "invalid_credentials");
        await identities.ChangePasswordAsync(accountId, request.NewPassword, Key(ctx),
            temporary: accountId == IdentityStore.LegacyUserId, allowLegacyLength: publicOrigin is null, Cancel(ctx));
        sessions.RevokeAccount(accountId, session);
        return SessionInfo(session);
    }
    finally { CryptographicOperations.ZeroMemory(verified); }
}));
app.MapPost("/api/v1/auth/password/self", (HttpContext ctx, SelfPasswordRequest request) => WithAuthGate(Cancel(ctx), async () =>
{
    var session = Session(ctx);
    if (request.NewPassword == request.CurrentPassword) throw new ApiError(400, "invalid_request");
    var verified = await CheckPassword(session.AccountId, request.CurrentPassword, Cancel(ctx));
    try
    {
        if (!CryptographicOperations.FixedTimeEquals(verified, Key(ctx))) throw new ApiError(401, "invalid_credentials");
        await identities.ChangePasswordAsync(session.AccountId, request.NewPassword, Key(ctx),
            temporary: false, allowLegacyLength: false, Cancel(ctx));
        sessions.RevokeAccount(session.AccountId, session);
        return SessionInfo(session);
    }
    finally { CryptographicOperations.ZeroMemory(verified); }
}));

static object AccountInfo(string accountId, Account account) => new
{
    username = accountId,
    role = IdentityStore.RoleFor(accountId),
    enabled = account.Enabled,
    canUpload = accountId == IdentityStore.AdminId || account.CanUpload,
    mustChangePassword = account.MustChangePassword,
    pendingDeletion = account.PendingDeletion
};

static string ManagedAccountId(string? username)
{
    var accountId = IdentityStore.NormalizeAccountId(username) ?? throw new ApiError(400, "invalid_request");
    if (accountId == IdentityStore.AdminId) throw new ApiError(403, "forbidden");
    return accountId;
}

app.MapGet("/api/v1/accounts", (HttpContext ctx) =>
{
    Admin(ctx);
    return new
    {
        items = identities.Identity.Accounts.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
            .Select(pair => AccountInfo(pair.Key, pair.Value)).ToArray()
    };
});
app.MapPost("/api/v1/accounts", (HttpContext ctx, CreateAccountRequest request) => WithAuthGate(Cancel(ctx), async () =>
{
    Admin(ctx);
    var accountId = ManagedAccountId(request.Username);
    var account = await identities.CreateUserAsync(accountId, request.Password, Key(ctx), Cancel(ctx), request.CanUpload)
        ?? throw new ApiError(409, "account_exists");
    return Results.Created($"/api/v1/accounts/{accountId}", AccountInfo(accountId, account));
}));
app.MapPatch("/api/v1/accounts/{username}", (HttpContext ctx, string username, SetAccountStateRequest request) =>
    WithAuthGate(Cancel(ctx), async () =>
{
    Admin(ctx);
    var accountId = ManagedAccountId(username);
    if (request.Enabled is null && request.CanUpload is null) throw new ApiError(400, "invalid_request");
    if (request.Enabled == true && publicOrigin is not null && identities.Find(accountId) is { WeakPassword: true })
        throw new ApiError(400, "weak_password");
    var account = await identities.SetStateAsync(accountId, request.Enabled, request.CanUpload, Cancel(ctx));
    if (!account.Enabled) sessions.RevokeAccount(accountId);
    loginBackoff.Remove(accountId);
    return AccountInfo(accountId, account);
}));
app.MapPost("/api/v1/accounts/{username}/password", (HttpContext ctx, string username, ResetAccountPasswordRequest request) =>
    WithAuthGate(Cancel(ctx), async () =>
{
    Admin(ctx);
    var accountId = ManagedAccountId(username);
    var account = await identities.ChangePasswordAsync(accountId, request.Password, Key(ctx),
        temporary: true, allowLegacyLength: false, Cancel(ctx));
    sessions.RevokeAccount(accountId);
    loginBackoff.Remove(accountId);
    return AccountInfo(accountId, account);
}));
app.MapDelete("/api/v1/accounts/{username}", (HttpContext ctx, string username) => WithAuthGate(Cancel(ctx), async () =>
{
    Admin(ctx);
    var accountId = ManagedAccountId(username);
    await identities.BeginDeletionAsync(accountId, Cancel(ctx));
    await sessions.RevokeAccountAndDrainAsync(accountId, Cancel(ctx));
    await catalog.DeletePersonalDataAsync(Key(ctx), accountId, Cancel(ctx));
    await identities.CompleteDeletionAsync(accountId, Cancel(ctx));
    loginBackoff.Remove(accountId);
    return Results.NoContent();
}));
app.MapPost("/api/v1/session/heartbeat", (HttpContext ctx, HeartbeatRequest request) =>
{
    Session(ctx).Heartbeat(request.Active, request.Playing);
    return SessionInfo(Session(ctx));
});

app.MapGet("/api/v1/home", async (HttpContext ctx) => { return await catalog.HomeAsync(Key(ctx), Cancel(ctx)); });
app.MapGet("/api/v1/tags", () => tagDictionary.AllIds);
MediaItem WithPosterVersion(MediaItem item) => item.Type == "video"
    ? item with { PosterVersion = posters.Version(item.Id) }
    : item;

async Task<MediaItem> GetMedia(HttpContext ctx, Guid id) =>
    await catalog.GetAsync(Key(ctx), id, Session(ctx).AccountId, Cancel(ctx)) ?? throw new ApiError(404, "not_found");

app.MapGet("/api/v1/media", async (HttpContext ctx) =>
{
    var q = ctx.Request.Query;
    var query = new MediaQuery(q["type"].ToString(), q["query"].ToString(), Tags(q["includeTags"].ToString()),
        Tags(q["excludeTags"].ToString()), q["tab"].FirstOrDefault() ?? "home", q["sort"].FirstOrDefault() ?? "newest",
        q["seed"].FirstOrDefault() ?? "0", int.TryParse(q["limit"], out var limit) ? Math.Clamp(limit, 1, 150) : 60,
        q["cursor"].FirstOrDefault());
    var page = await catalog.ListAsync(Key(ctx), query, Session(ctx).AccountId, Cancel(ctx));
    return page with { Items = page.Items.Select(WithPosterVersion).ToArray() };
});
app.MapGet("/api/v1/media/{id:guid}/related", async (HttpContext ctx, Guid id) =>
    new { items = (await catalog.RelatedAsync(Key(ctx), id, Session(ctx).AccountId, Cancel(ctx))).Select(WithPosterVersion).ToArray() });
app.MapGet("/api/v1/media/{id:guid}/neighbor", async (HttpContext ctx, Guid id, string direction) =>
    WithPosterVersion(await catalog.NeighborAsync(Key(ctx), id, direction, Session(ctx).AccountId, Cancel(ctx)) ?? throw new ApiError(404, "not_found")));
app.MapGet("/api/v1/media/{id:guid}", async (HttpContext ctx, Guid id) =>
    WithPosterVersion(await GetMedia(ctx, id)));
app.MapPut("/api/v1/media/{id:guid}/rating", async (HttpContext ctx, Guid id, RatingRequest request) =>
{
    if (Session(ctx).Role != "User") throw new ApiError(403, "forbidden");
    if (request.Rating is not null && request.Rating is < 1 or > 10000) throw new ApiError(400, "invalid_rating");
    await catalog.SetRatingAsync(Key(ctx), id, Session(ctx).AccountId, request.Rating, Cancel(ctx));
    return WithPosterVersion(await GetMedia(ctx, id));
});
app.MapPut("/api/v1/media/{id:guid}/favorite", async (HttpContext ctx, Guid id, FavoriteRequest request) =>
{
    await catalog.SetFavoriteAsync(Key(ctx), id, request.IsFavorite, Cancel(ctx));
    return WithPosterVersion(await GetMedia(ctx, id));
});
app.MapPost("/api/v1/media/{id:guid}/opened", async (HttpContext ctx, Guid id) =>
{
    if (Session(ctx).Role == "User")
        await catalog.OpenedAsync(Key(ctx), id, Session(ctx).AccountId, Cancel(ctx));
    else
        _ = await GetMedia(ctx, id);
    return Results.NoContent();
});
app.MapPost("/api/v1/media/{id:guid}/play-sessions", async (HttpContext ctx, Guid id) =>
{
    var item = await catalog.GetAsync(Key(ctx), id, Cancel(ctx)) ?? throw new ApiError(404, "not_found");
    if (item.Type != "video") throw new ApiError(400, "invalid_request");
    var playId = Session(ctx).CreatePlaySession(id);
    return new { id = playId };
});
app.MapPost("/api/v1/play-sessions/{id}/first-play", async (HttpContext ctx, string id) =>
{
    var play = Session(ctx).FindPlaySession(id) ?? throw new ApiError(404, "not_found");
    if (Session(ctx).Role == "User" && Interlocked.CompareExchange(ref play.Counted, 1, 0) == 0)
    {
        try { await catalog.RecordViewAsync(Key(ctx), play.MediaId, Session(ctx).AccountId, Cancel(ctx)); }
        catch { Interlocked.Exchange(ref play.Counted, 0); throw; }
    }
    return Results.NoContent();
});

app.MapGet("/api/v1/albums", async (HttpContext ctx) =>
    new { items = await catalog.ListAlbumsAsync(Key(ctx), Session(ctx).AccountId, Cancel(ctx)) });
app.MapPost("/api/v1/albums", async (HttpContext ctx, AlbumNameRequest request) =>
{
    var album = await catalog.CreateAlbumAsync(Key(ctx), Session(ctx).AccountId, request.Name, Cancel(ctx));
    return Results.Json(album, statusCode: 201);
});
app.MapPatch("/api/v1/albums/{albumId:guid}", async (HttpContext ctx, Guid albumId, AlbumNameRequest request) =>
    await catalog.RenameAlbumAsync(Key(ctx), Session(ctx).AccountId, albumId, request.Name, Cancel(ctx)));
app.MapDelete("/api/v1/albums/{albumId:guid}", async (HttpContext ctx, Guid albumId) =>
{
    await catalog.DeleteAlbumAsync(Key(ctx), Session(ctx).AccountId, albumId, Cancel(ctx));
    return Results.NoContent();
});
app.MapGet("/api/v1/albums/{albumId:guid}/items", async (HttpContext ctx, Guid albumId) =>
{
    var limit = int.TryParse(ctx.Request.Query["limit"], out var requested) ? Math.Clamp(requested, 1, 150) : 60;
    var page = await catalog.ListAlbumItemsAsync(Key(ctx), Session(ctx).AccountId, albumId, limit,
        ctx.Request.Query["cursor"].FirstOrDefault(), Cancel(ctx));
    return page with { Items = page.Items.Select(WithPosterVersion).ToArray() };
});
app.MapMethods("/api/v1/albums/{albumId:guid}/items/{mediaId:guid}", ["PUT", "DELETE"],
    async (HttpContext ctx, Guid albumId, Guid mediaId) =>
    {
        await catalog.SetAlbumItemAsync(Key(ctx), Session(ctx).AccountId, albumId, mediaId,
            HttpMethods.IsPut(ctx.Request.Method), Cancel(ctx));
        return Results.NoContent();
    });
app.MapGet("/api/v1/media/{id:guid}/albums", async (HttpContext ctx, Guid id) =>
    new { albumIds = await catalog.ListMediaAlbumIdsAsync(Key(ctx), Session(ctx).AccountId, id, Cancel(ctx)) });

string VaultPath(Guid id) => Path.Combine(libraryRoot, "vault", id.ToString("N")[..2], id.ToString("N") + ".srm");
app.MapGet("/api/v1/media/{id:guid}/poster", async (HttpContext ctx, Guid id) =>
{
    var item = await GetMedia(ctx, id);
    if (item.Type != "video") throw new ApiError(404, "not_found");
    var bytes = await posters.ReadAsync(id, Key(ctx), Cancel(ctx)) ?? throw new ApiError(404, "not_found");
    try
    {
        ctx.Response.ContentType = MediaPosterStore.MimeType(bytes) ?? throw new InvalidDataException("Invalid poster signature.");
        ctx.Response.ContentLength = bytes.Length;
        ctx.Response.Headers.ContentDisposition = "inline";
        await ctx.Response.Body.WriteAsync(bytes, Cancel(ctx));
    }
    finally { CryptographicOperations.ZeroMemory(bytes); }
});
app.MapPut("/api/v1/media/{id:guid}/poster", async (HttpContext ctx, Guid id) =>
{
    var session = Session(ctx);
    var administrative = session.Role == "Admin";
    using var importPoster = administrative ? null : Uploader(ctx).ReserveImportPoster(id,
        ctx.Request.Headers["X-Import-Token"].ToString()) ?? throw new ApiError(403, "forbidden");
    var item = await GetMedia(ctx, id);
    if (item.Type != "video" || ctx.Request.ContentLength is not long length || length <= 0)
        throw new ApiError(400, "invalid_poster");
    if (length > MediaPosterStore.MaxBytes) throw new ApiError(413, "poster_too_large");

    var bytes = new byte[(int)length];
    try
    {
        await ctx.Request.Body.ReadExactlyAsync(bytes, Cancel(ctx));
        if (!MediaPosterStore.IsSupportedImage(bytes, ctx.Request.ContentType)) throw new ApiError(400, "invalid_poster");
        return await WithAuthGate(Cancel(ctx), async () =>
        {
            // Account changes cannot finish between the last permission check
            // and publishing this initial poster.
            Uploader(ctx);
            var version = await posters.WriteAsync(id, bytes, Key(ctx), Cancel(ctx), overwrite: administrative);
            importPoster?.Complete();
            return item with { PosterVersion = version };
        });
    }
    finally { CryptographicOperations.ZeroMemory(bytes); }
}).WithMetadata(new RequestBodyLimit(MediaPosterStore.MaxBytes));
app.MapMethods("/api/v1/media/{id:guid}/stream", ["GET", "HEAD"], async (HttpContext ctx, Guid id) =>
{
    var item = await catalog.GetAsync(Key(ctx), id, Cancel(ctx)) ?? throw new ApiError(404, "not_found");
    var path = VaultPath(id);
    var length = await cipher.GetLengthAsync(path, Key(ctx), id, Cancel(ctx));
    if (length != item.Size) throw new InvalidDataException("Catalogue size mismatch.");
    ctx.Response.Headers.AcceptRanges = "bytes";
    var range = MediaInput.Range(ctx.Request.Headers.Range, length);
    if (range is null)
    {
        ctx.Response.StatusCode = 416;
        ctx.Response.Headers.ContentRange = $"bytes */{length}";
        return;
    }
    var (offset, count, partial) = range.Value;
    ctx.Response.StatusCode = partial ? 206 : 200;
    ctx.Response.ContentType = item.MimeType;
    ctx.Response.ContentLength = count;
    ctx.Response.Headers.ContentDisposition = "inline";
    if (partial) ctx.Response.Headers.ContentRange = $"bytes {offset}-{offset + count - 1}/{length}";
    if (!HttpMethods.IsHead(ctx.Request.Method))
        await cipher.CopyRangeAsync(path, ctx.Response.Body, Key(ctx), id, offset, count, Cancel(ctx));
});

app.MapPost("/api/v1/imports", async (HttpContext ctx) =>
{
    var uploader = Uploader(ctx);
    if (ctx.Request.ContentType?.StartsWith("multipart/", StringComparison.OrdinalIgnoreCase) == true)
        throw new ApiError(400, "single_file_required");
    if (ctx.Request.ContentLength is null or <= 0) throw new ApiError(400, "single_file_required");
    var name = Path.GetFileName(ctx.Request.Query["fileName"].ToString());
    var title = ctx.Request.Query["title"].FirstOrDefault();
    if (string.IsNullOrWhiteSpace(title)) title = Path.GetFileNameWithoutExtension(name);
    if (string.IsNullOrWhiteSpace(title) || title.Length > 200) throw new ApiError(400, "invalid_request");
    var requestedTags = Tags(ctx.Request.Query["tags"].ToString());
    if (requestedTags.Length > 30 || requestedTags.Any(t => t.Length > 64)) throw new ApiError(400, "invalid_request");
    var tags = new HashSet<string>(StringComparer.Ordinal);
    foreach (var requestedTag in requestedTags)
    {
        if (!tagDictionary.TryCanonicalize(requestedTag, out var tag)) throw new ApiError(400, "invalid_request");
        tags.Add(tag);
    }
    if (ctx.Request.Query.ContainsKey("rating")) throw new ApiError(403, "forbidden");
    if (!await importGate.WaitAsync(0, Cancel(ctx))) throw new ApiError(409, "import_busy");
    var id = Guid.NewGuid();
    var final = VaultPath(id);
    var staging = Path.Combine(libraryRoot, "staging", id.ToString("N") + ".partial");
    try
    {
        var importSettings = await catalog.GetSettingsAsync(Key(ctx), Cancel(ctx));
        var freeBytes = FreeDiskBytes();
        if (freeBytes is not null && freeBytes < ctx.Request.ContentLength + importSettings.LowDiskWarningGB * 1_073_741_824L)
            throw new ApiError(409, "low_disk_space");
        Directory.CreateDirectory(Path.GetDirectoryName(final)!);
        Directory.CreateDirectory(Path.GetDirectoryName(staging)!);
        var prefix = new byte[(int)Math.Min(64, ctx.Request.ContentLength.Value)];
        await ctx.Request.Body.ReadExactlyAsync(prefix, Cancel(ctx));
        var (type, mime) = MediaInput.Identify(prefix, name);
        using var source = new PrefixStream(prefix, ctx.Request.Body);
        var info = await cipher.EncryptAsync(source, staging, Key(ctx), id, Cancel(ctx));
        if (info.Length != ctx.Request.ContentLength.Value) throw new ApiError(400, "incomplete_upload");
        return await WithAuthGate(Cancel(ctx), async () =>
        {
            // Receiving and encrypting the body stays outside the account gate;
            // its final check and publication are atomic with permission changes.
            Uploader(ctx);
            var item = new MediaItem(id, type, title.Trim(), "", null, 0, false, info.Length, DateTimeOffset.UtcNow, tags.ToArray(), mime);
            File.Move(staging, final);
            try { await catalog.AddAsync(Key(ctx), item, info.Sha256, Cancel(ctx)); }
            catch { File.Delete(final); throw; }
            if (type == "video" && uploader.Role != "Admin")
            {
                var result = JsonSerializer.SerializeToNode(item, new JsonSerializerOptions(JsonSerializerDefaults.Web))!.AsObject();
                result["importToken"] = uploader.CreateImportPosterToken(id);
                return Results.Json(result, statusCode: 201);
            }
            return Results.Json(item, statusCode: 201);
        });
    }
    finally
    {
        if (File.Exists(staging)) File.Delete(staging);
        importGate.Release();
    }
}).WithMetadata(new RequestBodyLimit(1_099_511_627_776));
app.MapPost("/api/v1/media/{id:guid}/trash", async (HttpContext ctx, Guid id) =>
{
    Admin(ctx);
    await catalog.TrashAsync(Key(ctx), id, Cancel(ctx));
    return Results.NoContent();
});
app.MapGet("/api/v1/trash", async (HttpContext ctx) =>
{
    Admin(ctx);
    return new { items = await catalog.TrashListAsync(Key(ctx), Cancel(ctx)) };
});
app.MapPost("/api/v1/trash/{id:guid}/restore", async (HttpContext ctx, Guid id) =>
{
    Admin(ctx);
    await catalog.RestoreAsync(Key(ctx), id, Cancel(ctx));
    return Results.NoContent();
});
app.MapGet("/api/v1/settings", async (HttpContext ctx) => { return await catalog.GetSettingsAsync(Key(ctx), Session(ctx).AccountId, Cancel(ctx)); });
async Task<UiSettings> UpdateSettings(HttpContext ctx, JsonElement patch, bool administrative)
{
    if (administrative) Admin(ctx);
    if (patch.ValueKind != JsonValueKind.Object) throw new ApiError(400, "invalid_settings");
    var adminFields = new HashSet<string> { "trashRetentionDays", "lowDiskWarningGB", "thumbnailCandidates" };
    var unavailable = new HashSet<string> { "verifyOnStartup", "backupReminderDays", "workerConcurrency", "maxTranscodes", "pauseOnBattery", "ffmpegThreads", "gpuDecodePreference" };
    var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    await settingsGate.WaitAsync(Cancel(ctx));
    try
    {
        var current = await catalog.GetSettingsAsync(Key(ctx), Session(ctx).AccountId, Cancel(ctx));
        var merged = JsonSerializer.SerializeToNode(current, jsonOptions)!.AsObject();
        foreach (var property in patch.EnumerateObject())
        {
            if (!merged.ContainsKey(property.Name)) throw new ApiError(400, "invalid_settings");
            var value = JsonNode.Parse(property.Value.GetRawText());
            if (JsonNode.DeepEquals(merged[property.Name], value)) continue;
            if (property.Name == "schemaVersion" || unavailable.Contains(property.Name)) throw new ApiError(400, "invalid_settings");
            if (administrative != adminFields.Contains(property.Name)) throw new ApiError(403, "forbidden");
            merged[property.Name] = value;
        }
        var updated = merged.Deserialize<UiSettings>(jsonOptions) ?? throw new ApiError(400, "invalid_settings");
        await catalog.SaveSettingsAsync(Key(ctx), updated, Session(ctx).AccountId, Cancel(ctx));
        sessions.SetAfkMinutes(Session(ctx).AccountId, updated.AfkMinutes);
        return updated;
    }
    finally { settingsGate.Release(); }
}
app.MapPatch("/api/v1/settings/ui", (HttpContext ctx, JsonElement patch) => UpdateSettings(ctx, patch, false));
app.MapPatch("/api/v1/settings/admin", (HttpContext ctx, JsonElement patch) => UpdateSettings(ctx, patch, true));
long? FreeDiskBytes()
{
    try { return new DriveInfo(Path.GetPathRoot(libraryRoot)!).AvailableFreeSpace; }
    catch (IOException) { return null; }
    catch (ArgumentException) { return null; }
}
object StorageStatus(bool sourceRetained = false) => new { mediaRoot = libraryRoot, databaseRoot = Path.Combine(libraryRoot, "db"), freeBytes = FreeDiskBytes(), available = Directory.Exists(libraryRoot), checkedAt = DateTimeOffset.UtcNow, sourceRetained };
app.MapGet("/api/v1/storage", (HttpContext ctx) => { Admin(ctx); return StorageStatus(); });
app.MapPost("/api/v1/storage/check", async (HttpContext ctx) =>
{
    Admin(ctx);
    await catalog.InitializeAsync(Key(ctx), Cancel(ctx));
    return StorageStatus();
});
app.MapGet("/api/v1/storage/folders", (HttpContext ctx, string? path) =>
{
    Admin(ctx);
    return LibraryStorage.ListFolders(path);
});
app.MapPost("/api/v1/storage/folders/pick", async (HttpContext ctx, StoragePickerRequest request) =>
{
    Admin(ctx);
    RequireLocalAdmin(ctx);
    var selected = await NativeFolderPicker.PickAsync(request.Path, Cancel(ctx));
    return new { path = selected };
});
async Task<object> MoveLibrary(HttpContext ctx, string path, IProgress<StorageMoveProgress>? progress = null)
{
    await catalog.InitializeAsync(Key(ctx), ctx.RequestAborted);
    var result = await storage.MoveAsync(path, ctx.RequestAborted, progress);
    libraryRoot = storage.Root;
    identities = identities.AtRoot(libraryRoot);
    catalog = new CatalogStore(libraryRoot, identities.LibraryId, tagDictionary);
    posters = new MediaPosterStore(libraryRoot, cipher);
    return StorageStatus(result.SourceRetained);
}
app.MapPost("/api/v1/storage/move", async (HttpContext ctx, StoragePathRequest request) =>
{
    Admin(ctx);
    if (!ctx.Request.Headers.Accept.Any(value => value?.Contains("application/x-ndjson", StringComparison.OrdinalIgnoreCase) == true))
        return Results.Json(await MoveLibrary(ctx, request.Path));

    // Progress travels on this request: other API work is deliberately paused by the storage gate.
    var updates = Channel.CreateBounded<StorageMoveProgress>(new BoundedChannelOptions(1)
    {
        SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.DropOldest
    });
    async Task<object> RunMove()
    {
        try { return await MoveLibrary(ctx, request.Path, new MoveProgressWriter(updates.Writer)); }
        finally { updates.Writer.TryComplete(); }
    }
    var operation = RunMove();
    ctx.Response.ContentType = "application/x-ndjson; charset=utf-8";
    ctx.Response.Headers["X-Accel-Buffering"] = "no";
    var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    async Task Send(object value)
    {
        await ctx.Response.WriteAsync(JsonSerializer.Serialize(value, jsonOptions) + "\n", ctx.RequestAborted);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
    }
    try
    {
        await foreach (var progress in updates.Reader.ReadAllAsync(ctx.RequestAborted))
            await Send(new { type = "progress", progress.Phase, progress.BytesCompleted, progress.TotalBytes,
                progress.FilesCompleted, progress.TotalFiles, progress.Percent });
        await Send(new { type = "complete", storage = await operation });
    }
    catch (Exception failure)
    {
        // Even after a browser disconnect, keep the exclusive gate until rollback or commit finishes.
        try { await operation; }
        catch (Exception moveFailure) { failure = moveFailure; }
        if (!ctx.RequestAborted.IsCancellationRequested)
        {
            var code = failure switch
            {
                StorageException error => error.Code,
                ApiError error => error.Code,
                ArgumentException => "invalid_storage_path",
                IOException or UnauthorizedAccessException => "storage_unavailable",
                _ => "internal_error"
            };
            if (code == "internal_error") app.Logger.LogError("Storage move stream failed with {ExceptionType}", failure.GetType().Name);
            await Send(new { type = "error", code });
        }
    }
    return Results.Empty;
});
app.MapPost("/api/v1/storage/connect", async (HttpContext ctx, StorageConnectRequest request) =>
{
    Admin(ctx);
    using var candidate = storage.OpenCandidate(request.Path);
    var nextIdentities = new IdentityStore(candidate.Root);
    byte[]? nextKey = null;
    CatalogStore nextCatalog;
    try
    {
        await nextIdentities.LoadAsync(ctx.RequestAborted);
        nextKey = await nextIdentities.UnlockAsync(IdentityStore.AdminId, request.Password, ctx.RequestAborted);
        if (nextKey is null) throw new ApiError(401, "invalid_credentials");
        if (publicOrigin is not null && nextIdentities.Identity.Accounts.Any(pair => pair.Key != IdentityStore.AdminId
            && pair.Value.Enabled && pair.Value.WeakPassword))
            throw new ApiError(409, "weak_library_passwords");
        nextCatalog = new CatalogStore(candidate.Root, nextIdentities.LibraryId, tagDictionary);
        await nextCatalog.InitializeAsync(nextKey, ctx.RequestAborted);
    }
    catch (Exception ex) when (ex is InvalidDataException or JsonException or CryptographicException
        or FormatException or Microsoft.Data.Sqlite.SqliteException)
    {
        throw new ApiError(422, "invalid_library");
    }
    finally { if (nextKey is not null) CryptographicOperations.ZeroMemory(nextKey); }
    await storage.CommitCandidateAsync(candidate, ctx.RequestAborted);
    libraryRoot = storage.Root;
    identities = nextIdentities;
    catalog = nextCatalog;
    posters = new MediaPosterStore(libraryRoot, cipher);
    loginBackoff.Clear();
    sessions.RevokeAll();
    ctx.Response.Cookies.Delete(SessionStore.Cookie);
    return StorageStatus();
});

app.MapFallback("/api/{**path}", () => Results.Json(new { code = "not_found", messageKey = "errors.not_found" }, statusCode: 404));
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");
app.Logger.LogInformation("Shronchik prototype listening on http://127.0.0.1:{Port}", port);
app.Run();

static AppSession Session(HttpContext ctx) => (AppSession?)ctx.Items["session"] ?? throw new ApiError(401, "unauthorized");
AppSession Uploader(HttpContext ctx)
{
    var session = Session(ctx);
    if (!identities.CanUpload(session.AccountId)) throw new ApiError(403, "forbidden");
    return session;
}
static void RequireLocalAdmin(HttpContext ctx)
{
    if (ctx.Items["localAdminRequest"] is not true) throw new ApiError(403, "admin_local_only");
}
static AppSession Admin(HttpContext ctx) => Session(ctx).Role == "Admin" ? Session(ctx) : throw new ApiError(403, "forbidden");
static byte[] Key(HttpContext ctx) => (byte[])ctx.Items["key"]!;
static CancellationToken Cancel(HttpContext ctx) => (CancellationToken)ctx.Items["cancel"]!;
static string[] Tags(string value) => value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
static bool FixedEquals(string a, string b) => a.Length == b.Length && CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(a), System.Text.Encoding.UTF8.GetBytes(b));

sealed class ApiError(int status, string code) : Exception(code)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}
sealed record LoginRequest(string? Username, string? Role, string Password);
sealed record UnlockRequest(string Password);
sealed record PasswordRequest(string Role, string CurrentPassword, string NewPassword);
sealed record SelfPasswordRequest(string CurrentPassword, string NewPassword);
sealed record StoragePathRequest(string Path);
sealed record StoragePickerRequest(string? Path);
sealed record StorageConnectRequest(string Path, string Password);
sealed record CreateAccountRequest(string Username, string Password, bool CanUpload = false);
sealed record SetAccountStateRequest(bool? Enabled, bool? CanUpload);
sealed record ResetAccountPasswordRequest(string Password);
sealed record HeartbeatRequest(bool Active, bool Playing);
sealed record RatingRequest(int? Rating);
sealed record FavoriteRequest(bool IsFavorite);
sealed record AlbumNameRequest(string Name);
sealed record RequestBodyLimit(long Bytes);
sealed class MoveProgressWriter(ChannelWriter<StorageMoveProgress> writer) : IProgress<StorageMoveProgress>
{
    public void Report(StorageMoveProgress value) => writer.TryWrite(value);
}
