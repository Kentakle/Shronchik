using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Shronchik.Server.Auth;

public sealed class KeyLease(byte[] key, CancellationToken token, Action? onDispose = null) : IDisposable
{
    private int disposed;
    public byte[] Key { get; } = key;
    public CancellationToken Token { get; } = token;
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        CryptographicOperations.ZeroMemory(Key);
        onDispose?.Invoke();
    }
}

public sealed class AppSession(string id, string accountId, byte[] key, TimeProvider? timeProvider = null)
{
    public const int MaxPlaySessions = 128;
    public const int MaxImportPosterGrants = 128;
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly object sync = new();
    private byte[]? masterKey = key;
    private CancellationTokenSource streams = new();
    private bool revoked;
    private int activeLeases;
    private TaskCompletionSource? drained;
    private readonly Dictionary<string, PlayEntry> plays = new();
    private readonly Dictionary<string, ImportPosterGrant> importPosters = new();
    public string Id { get; } = id;
    public string AccountId { get; } = accountId;
    public string Role { get; } = IdentityStore.RoleFor(accountId);
    public string CsrfToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    public DateTimeOffset CreatedAt { get; } = (timeProvider ?? TimeProvider.System).GetUtcNow();
    private DateTimeOffset lastActivity = (timeProvider ?? TimeProvider.System).GetUtcNow();
    private DateTimeOffset playingUntil = DateTimeOffset.MinValue;
    private DateTimeOffset lastPlayingHeartbeat = DateTimeOffset.MinValue;
    public int AfkMinutes { get; set; } = 5;
    public bool Locked { get { lock (sync) return masterKey is null; } }
    public KeyLease? Acquire()
    {
        lock (sync)
        {
            CheckIdleCore();
            if (masterKey is null) return null;
            var copy = masterKey.ToArray();
            activeLeases++;
            return new(copy, streams.Token, ReleaseLease);
        }
    }
    public string CreatePlaySession(Guid mediaId)
    {
        lock (sync)
        {
            if (revoked) throw new OperationCanceledException();
            // One browser can open many videos over a day. Keep only its recent
            // markers, rather than scanning every viewer's unbounded dictionary.
            var now = clock.GetUtcNow();
            foreach (var expired in plays.Where(p => p.Value.Created < now.AddHours(-4)).Select(p => p.Key).ToArray())
                plays.Remove(expired);
            if (plays.Count >= MaxPlaySessions) plays.Remove(plays.MinBy(p => p.Value.Created).Key);
            var playId = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
            plays[playId] = new(mediaId, now);
            return playId;
        }
    }
    public PlayEntry? FindPlaySession(string playId)
    {
        lock (sync)
        {
            if (revoked || !plays.TryGetValue(playId, out var play)) return null;
            if (play.Created >= clock.GetUtcNow().AddHours(-4)) return play;
            plays.Remove(playId);
            return null;
        }
    }
    public string CreateImportPosterToken(Guid mediaId)
    {
        lock (sync)
        {
            if (revoked) throw new OperationCanceledException();
            var now = clock.GetUtcNow();
            foreach (var expired in importPosters.Where(p => p.Value.ExpiresAt <= now).Select(p => p.Key).ToArray())
                importPosters.Remove(expired);
            if (importPosters.Count >= MaxImportPosterGrants)
                importPosters.Remove(importPosters.MinBy(p => p.Value.ExpiresAt).Key);
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            importPosters[token] = new(mediaId, now.AddMinutes(15));
            return token;
        }
    }
    public ImportPosterLease? ReserveImportPoster(Guid mediaId, string token)
    {
        lock (sync)
        {
            if (revoked || token.Length != 64 || !importPosters.TryGetValue(token, out var grant)
                || grant.MediaId != mediaId || grant.ExpiresAt <= clock.GetUtcNow() || grant.InUse)
                return null;
            grant.InUse = true;
            return new(completed =>
            {
                lock (sync)
                {
                    if (completed) importPosters.Remove(token);
                    else grant.InUse = false;
                }
            });
        }
    }
    private void ReleaseLease()
    {
        lock (sync)
        {
            activeLeases--;
            if (activeLeases == 0) drained?.TrySetResult();
        }
    }
    public void Heartbeat(bool active, bool playing)
    {
        lock (sync)
        {
            CheckIdleCore();
            if (masterKey is null) return;
            var now = clock.GetUtcNow();
            if (active || playing || lastPlayingHeartbeat > now.AddSeconds(-35)) lastActivity = now;
            playingUntil = playing ? now.AddSeconds(35) : DateTimeOffset.MinValue;
            lastPlayingHeartbeat = playing ? now : DateTimeOffset.MinValue;
        }
    }
    public void CheckIdle() { lock (sync) CheckIdleCore(); }
    private void CheckIdleCore()
    {
        var now = clock.GetUtcNow();
        if (masterKey is not null && now > playingUntil && now - lastActivity > TimeSpan.FromMinutes(AfkMinutes)) LockCore();
    }
    public void Lock() { lock (sync) LockCore(); }
    public void Revoke() => _ = RevokeAndDrain();
    internal Task RevokeAndDrain()
    {
        lock (sync)
        {
            revoked = true;
            LockCore();
            plays.Clear();
            importPosters.Clear();
            if (activeLeases == 0) return Task.CompletedTask;
            return (drained ??= new(TaskCreationOptions.RunContinuationsAsynchronously)).Task;
        }
    }
    private void LockCore()
    {
        if (masterKey is null) return;
        streams.Cancel();
        CryptographicOperations.ZeroMemory(masterKey);
        masterKey = null;
        playingUntil = DateTimeOffset.MinValue;
    }
    public bool Unlock(byte[] key)
    {
        lock (sync)
        {
            if (revoked)
            {
                CryptographicOperations.ZeroMemory(key);
                return false;
            }
            // Repeated unlock must revoke the previous generation too; otherwise
            // an old active stream would escape the next lock operation.
            streams.Cancel();
            if (masterKey is not null) CryptographicOperations.ZeroMemory(masterKey);
            masterKey = key;
            // Existing requests retain the canceled token; a new generation serves the unlocked session.
            streams = new();
            lastActivity = clock.GetUtcNow();
            playingUntil = DateTimeOffset.MinValue;
            return true;
        }
    }
}

internal sealed class ImportPosterGrant(Guid mediaId, DateTimeOffset expiresAt)
{
    public Guid MediaId { get; } = mediaId;
    public DateTimeOffset ExpiresAt { get; } = expiresAt;
    public bool InUse;
}

public sealed class ImportPosterLease(Action<bool> release) : IDisposable
{
    private int disposed;
    private bool completed;
    public void Complete() => completed = true;
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0) release(completed);
    }
}

public sealed class PlayEntry(Guid mediaId, DateTimeOffset created)
{
    public Guid MediaId { get; } = mediaId;
    public DateTimeOffset Created { get; } = created;
    public int Counted;
}

public sealed class SessionStore : BackgroundService
{
    public const string Cookie = "shronchik.session";
    public const int MaxSessionsPerAccount = 16;
    public const int MaxSessions = 256;
    private readonly object creationSync = new();
    private readonly ConcurrentDictionary<string, AppSession> sessions = new();
    private readonly ConcurrentDictionary<string, DrainingSession> draining = new();
    private sealed record DrainingSession(string AccountId, Task Completion);
    public AppSession Create(string accountId, byte[] key)
    {
        lock (creationSync)
        {
            // Successful logins also need a bound: a client can omit its old
            // cookie, otherwise retaining a new master-key/session for 24h each time.
            foreach (var old in sessions.Values.Where(s => s.AccountId == accountId)
                .OrderBy(s => s.CreatedAt).Reverse().Skip(MaxSessionsPerAccount - 1)) Remove(old);
            foreach (var old in sessions.Values.OrderBy(s => s.CreatedAt).Reverse().Skip(MaxSessions - 1)) Remove(old);
            var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var session = new AppSession(id, accountId, key);
            sessions[id] = session;
            return session;
        }
    }
    public AppSession? Find(HttpContext ctx) => ctx.Request.Cookies.TryGetValue(Cookie, out var id)
        && sessions.TryGetValue(id, out var session) ? session : null;
    public void Remove(AppSession session)
    {
        var completion = session.RevokeAndDrain();
        if (!completion.IsCompleted)
        {
            // Register before removing the active session, so account deletion
            // cannot miss a request being logged out or revoked concurrently.
            draining[session.Id] = new(session.AccountId, completion);
            _ = completion.ContinueWith(_ => { draining.TryRemove(session.Id, out var removed); },
                CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }
        sessions.TryRemove(session.Id, out _);
    }
    public void RevokeAccount(string accountId, AppSession? except = null)
    {
        foreach (var session in sessions.Values.Where(s => s.AccountId == accountId && s != except)) Remove(session);
    }
    public void RevokeAll()
    {
        lock (creationSync)
            foreach (var session in sessions.Values) Remove(session);
    }
    public async Task RevokeAccountAndDrainAsync(string accountId, CancellationToken ct = default)
    {
        RevokeAccount(accountId);
        var completions = draining.Values.Where(entry => entry.AccountId == accountId).Select(entry => entry.Completion).ToArray();
        await Task.WhenAll(completions).WaitAsync(ct);
    }
    public void SetAfkMinutes(string accountId, int value)
    {
        foreach (var session in sessions.Values)
            if (session.AccountId == accountId) session.AfkMinutes = value;
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
                foreach (var session in sessions.Values)
                {
                    session.CheckIdle();
                    if (DateTimeOffset.UtcNow - session.CreatedAt > TimeSpan.FromHours(24)) Remove(session);
                }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { foreach (var session in sessions.Values) session.Lock(); }
    }
}
