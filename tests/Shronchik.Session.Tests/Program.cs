using System.Security.Cryptography;
using Shronchik.Server.Auth;
using Shronchik.Server.Storage;

var passed = 0;
var clock = new ManualClock();
var owned = RandomNumberGenerator.GetBytes(32);
var session = new AppSession("test", "User", owned, clock);
var lease = session.Acquire()!;
session.Lock();
Check(session.Locked && session.Acquire() is null, "lock refuses further key leases");
Check(owned.All(b => b == 0), "lock clears session-owned master key");
Check(lease.Token.IsCancellationRequested, "lock cancels active requests");
lease.Dispose();
Check(lease.Key.All(b => b == 0), "completed lease clears its temporary key");

var replacement = RandomNumberGenerator.GetBytes(32);
session.Unlock(replacement);
using var generation = session.Acquire()!;
Check(!generation.Token.IsCancellationRequested, "unlock creates usable fresh generation");
session.Unlock(RandomNumberGenerator.GetBytes(32));
Check(generation.Token.IsCancellationRequested, "repeated unlock cancels previous generation");
Check(replacement.All(b => b == 0), "repeated unlock clears old owned key");
Check(session.Role == "User", "unlock preserves session role");
session.Lock();

var idle = new AppSession("idle", "Admin", RandomNumberGenerator.GetBytes(32), clock);
clock.Advance(TimeSpan.FromMinutes(4));
idle.CheckIdle();
Check(!idle.Locked, "session stays open before AFK deadline");
clock.Advance(TimeSpan.FromSeconds(61));
idle.CheckIdle();
Check(idle.Locked, "server locks idle session after five minutes");

var active = new AppSession("active", "User", RandomNumberGenerator.GetBytes(32), clock);
clock.Advance(TimeSpan.FromMinutes(4));
active.Heartbeat(active: true, playing: false);
clock.Advance(TimeSpan.FromMinutes(4));
active.CheckIdle();
Check(!active.Locked, "actual activity resets AFK deadline");
clock.Advance(TimeSpan.FromSeconds(61));
Check(active.Acquire() is null, "acquiring a key enforces overdue AFK without UI heartbeat");

var movie = new AppSession("movie", "User", RandomNumberGenerator.GetBytes(32), clock);
for (var i = 0; i < 40; i++)
{
    movie.Heartbeat(active: false, playing: true);
    clock.Advance(TimeSpan.FromSeconds(15));
    movie.CheckIdle();
}
Check(!movie.Locked, "actual video playback suspends AFK over a long viewing period");
movie.Heartbeat(active: false, playing: false);
clock.Advance(TimeSpan.FromMinutes(4));
movie.CheckIdle();
Check(!movie.Locked, "pause begins a new idle interval");
clock.Advance(TimeSpan.FromSeconds(61));
movie.CheckIdle();
Check(movie.Locked, "paused video eventually locks");

var missing = new AppSession("missing", "User", RandomNumberGenerator.GetBytes(32), clock);
missing.Heartbeat(active: false, playing: true);
clock.Advance(TimeSpan.FromMinutes(6));
missing.CheckIdle();
Check(missing.Locked, "stale playback heartbeat cannot suspend AFK indefinitely");

using var accounts = new SessionStore();
var firstFriend = accounts.Create("alice", RandomNumberGenerator.GetBytes(32));
var secondFriend = accounts.Create("bob", RandomNumberGenerator.GetBytes(32));
Check(firstFriend.AccountId == "alice" && firstFriend.Role == "User", "personal login is separate from role");
var anotherAliceSession = accounts.Create("alice", RandomNumberGenerator.GetBytes(32));
accounts.SetAfkMinutes("alice", 12);
Check(firstFriend.AfkMinutes == 12 && anotherAliceSession.AfkMinutes == 12 && secondFriend.AfkMinutes == 5,
    "personal AFK settings update all sessions of one account without changing another account");
using var friendLease = firstFriend.Acquire()!;
accounts.RevokeAccount("alice");
Check(firstFriend.Locked && friendLease.Token.IsCancellationRequested && !secondFriend.Locked,
    "account revocation cancels only that account's active leases");
var revokedKey = RandomNumberGenerator.GetBytes(32);
Check(!firstFriend.Unlock(revokedKey) && revokedKey.All(b => b == 0),
    "revoked sessions cannot be unlocked by a racing request");
secondFriend.Lock();

var deleting = accounts.Create("deleting", RandomNumberGenerator.GetBytes(32));
var firstLease = deleting.Acquire()!;
var secondLease = deleting.Acquire()!;
var deletionDrain = accounts.RevokeAccountAndDrainAsync("deleting");
Check(firstLease.Token.IsCancellationRequested && secondLease.Token.IsCancellationRequested && !deletionDrain.IsCompleted,
    "account deletion revokes requests and waits for their key leases");
firstLease.Dispose();
firstLease.Dispose();
Check(!deletionDrain.IsCompleted, "disposing one lease twice cannot finish another active request");
secondLease.Dispose();
await deletionDrain;
Check(deletionDrain.IsCompletedSuccessfully, "account deletion can purge only after every lease is released");

var retrying = accounts.Create("retrying", RandomNumberGenerator.GetBytes(32));
var pendingLease = retrying.Acquire()!;
using var canceledWait = new CancellationTokenSource();
var interruptedDrain = accounts.RevokeAccountAndDrainAsync("retrying", canceledWait.Token);
canceledWait.Cancel();
try { await interruptedDrain; throw new Exception("Expected canceled drain wait."); }
catch (OperationCanceledException) { }
var retryDrain = accounts.RevokeAccountAndDrainAsync("retrying");
Check(!retryDrain.IsCompleted, "a deletion retry still waits for requests removed by an interrupted drain");
pendingLease.Dispose();
await retryDrain;
Check(retryDrain.IsCompletedSuccessfully, "a retried deletion finishes after the retained request drains");

var loggingOut = accounts.Create("logging-out", RandomNumberGenerator.GetBytes(32));
var logoutLease = loggingOut.Acquire()!;
accounts.Remove(loggingOut);
var logoutDrain = accounts.RevokeAccountAndDrainAsync("logging-out");
Check(!logoutDrain.IsCompleted, "account deletion includes requests from an already logged-out session");
logoutLease.Dispose();
await logoutDrain;
using var bounded = new SessionStore();
var oldestKey = RandomNumberGenerator.GetBytes(32);
var oldest = bounded.Create("repeat-login", oldestKey);
using var oldestRequest = oldest.Acquire()!;
var untouched = bounded.Create("unrelated", RandomNumberGenerator.GetBytes(32));
for (var i = 0; i < SessionStore.MaxSessionsPerAccount; i++)
    bounded.Create("repeat-login", RandomNumberGenerator.GetBytes(32));
Check(oldest.Locked && oldestRequest.Token.IsCancellationRequested && oldestKey.All(b => b == 0),
    "repeated cookie-less logins revoke the oldest session and clear its owned key");
Check(!untouched.Locked, "per-account session quota leaves another account's session intact");
var globalOldest = bounded.Create("global-oldest", RandomNumberGenerator.GetBytes(32));
AppSession latest = globalOldest;
for (var i = 0; i < SessionStore.MaxSessions; i++)
    latest = bounded.Create("bounded-" + i, RandomNumberGenerator.GetBytes(32));
Check(globalOldest.Locked && !latest.Locked,
    "global session quota revokes oldest sessions while allowing a fresh login");
await bounded.StopAsync(CancellationToken.None);
var markerClock = new ManualClock();
var markerSession = new AppSession("markers", "alice", RandomNumberGenerator.GetBytes(32), markerClock);
var mediaId = Guid.NewGuid();
var oldMarker = markerSession.CreatePlaySession(mediaId);
var retainedMarker = oldMarker;
for (var i = 0; i < AppSession.MaxPlaySessions; i++)
{
    markerClock.Advance(TimeSpan.FromSeconds(1));
    retainedMarker = markerSession.CreatePlaySession(mediaId);
}
Check(markerSession.FindPlaySession(oldMarker) is null && markerSession.FindPlaySession(retainedMarker)?.MediaId == mediaId,
    "playback marker quota discards the oldest marker while keeping the newest usable");
Check(secondFriend.FindPlaySession(retainedMarker) is null, "playback markers belong only to the creating session");
markerSession.Lock();
markerSession.Unlock(RandomNumberGenerator.GetBytes(32));
Check(markerSession.FindPlaySession(retainedMarker) is not null, "AFK lock preserves playback counting state after unlock");
markerClock.Advance(TimeSpan.FromHours(5));
Check(markerSession.FindPlaySession(retainedMarker) is null, "expired playback marker cannot count a new view");
var revokedMarker = markerSession.CreatePlaySession(mediaId);
markerSession.Revoke();
Check(markerSession.FindPlaySession(revokedMarker) is null, "revocation discards the session's playback markers");

var posterClock = new ManualClock();
var uploader = new AppSession("uploader", "alice", RandomNumberGenerator.GetBytes(32), posterClock);
var importedVideo = Guid.NewGuid();
var initialPoster = uploader.CreateImportPosterToken(importedVideo);
Check(uploader.ReserveImportPoster(Guid.NewGuid(), initialPoster) is null,
    "an initial-poster capability cannot edit another media item");
Check(secondFriend.ReserveImportPoster(importedVideo, initialPoster) is null,
    "an initial-poster capability is bound to the uploading session");
using (var pendingPoster = uploader.ReserveImportPoster(importedVideo, initialPoster))
{
    Check(pendingPoster is not null && uploader.ReserveImportPoster(importedVideo, initialPoster) is null,
        "a reserved initial-poster capability rejects concurrent reuse");
}
using (var retriedPoster = uploader.ReserveImportPoster(importedVideo, initialPoster))
{
    Check(retriedPoster is not null, "failed poster writes release the capability for retry");
    retriedPoster!.Complete();
}
Check(uploader.ReserveImportPoster(importedVideo, initialPoster) is null,
    "a successful initial poster consumes its capability");
var expiredPoster = uploader.CreateImportPosterToken(importedVideo);
posterClock.Advance(TimeSpan.FromMinutes(15));
Check(uploader.ReserveImportPoster(importedVideo, expiredPoster) is null,
    "an expired initial-poster capability cannot edit the imported video");
var oldestPoster = uploader.CreateImportPosterToken(importedVideo);
var newestPoster = oldestPoster;
for (var i = 0; i < AppSession.MaxImportPosterGrants; i++)
{
    posterClock.Advance(TimeSpan.FromSeconds(1));
    newestPoster = uploader.CreateImportPosterToken(importedVideo);
}
using (var newestGrant = uploader.ReserveImportPoster(importedVideo, newestPoster))
    Check(uploader.ReserveImportPoster(importedVideo, oldestPoster) is null && newestGrant is not null,
        "initial-poster capabilities stay bounded while the latest upload remains usable");
uploader.Revoke();
Check(uploader.ReserveImportPoster(importedVideo, newestPoster) is null,
    "revoking the uploading session invalidates its initial-poster capabilities");

var allSessions = new SessionStore();
var oldAdmin = allSessions.Create("Admin", RandomNumberGenerator.GetBytes(32));
var oldUser = allSessions.Create("alice", RandomNumberGenerator.GetBytes(32));
using (var userStream = oldUser.Acquire()!)
{
    allSessions.RevokeAll();
    Check(oldAdmin.Locked && oldUser.Locked && userStream.Token.IsCancellationRequested,
        "connecting another library revokes every account and cancels its streams");
}
allSessions.Dispose();

var storageGate = new StorageRequestGate();
using var changingRequest = storageGate.Enter();
using var streamRequest = storageGate.Enter();
var transitionTask = storageGate.BeginTransitionAsync(changingRequest, CancellationToken.None);
Check(streamRequest.Token.IsCancellationRequested && !transitionTask.IsCompleted,
    "storage transition cancels requests and waits for streams and writes to drain");
var refused = false;
try { storageGate.Enter().Dispose(); }
catch (StorageException ex) when (ex.Code == "storage_busy") { refused = true; }
Check(refused, "storage transition refuses new API work while paths change");
streamRequest.Dispose();
using (await transitionTask) { }
using var freshRequest = storageGate.Enter();
Check(!freshRequest.Token.IsCancellationRequested, "completed storage transition admits work with a fresh cancellation generation");
using var cancelledChange = storageGate.Enter();
using var cancelChange = new CancellationTokenSource();
var cancelledTransition = storageGate.BeginTransitionAsync(cancelledChange, cancelChange.Token);
cancelChange.Cancel();
try { await cancelledTransition; throw new Exception("Expected cancellation"); }
catch (OperationCanceledException) { }
using var afterCancellation = storageGate.Enter();
Check(!afterCancellation.Token.IsCancellationRequested, "cancelled storage transition restores access to the current library");
freshRequest.Dispose();

if (OperatingSystem.IsWindows())
{
    var saveFailure = CreateStorageFixture("move-save-failure");
    using (var library = new LibraryStorage(saveFailure.Root, saveFailure.Config))
    {
        var failedProgress = new List<StorageMoveProgress>();
        using (var preventReplacement = new FileStream(saveFailure.Config, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await ExpectStorageIoFailure(() => library.MoveAsync(saveFailure.Destination,
                progress: new InlineStorageProgress(failedProgress.Add)));
        }
        Check(library.Root == saveFailure.Root && File.ReadAllBytes(saveFailure.DataPath).SequenceEqual(saveFailure.Data)
            && File.ReadAllBytes(Path.Combine(saveFailure.Root, "library.json")).SequenceEqual(saveFailure.Manifest)
            && File.ReadAllBytes(saveFailure.Config).SequenceEqual(saveFailure.Selection)
            && !Directory.Exists(saveFailure.Destination) && !HasStorageTemporaryFiles(saveFailure)
            && IsFileLocked(saveFailure.Root + ".instance.lock")
            && failedProgress.All(update => update.Percent < 100 && update.Phase != "completed"),
            "failed move selection replacement retains original bytes, root and lock and rolls back its published copy");
    }

    var readFailure = CreateStorageFixture("move-read-failure");
    using (var library = new LibraryStorage(readFailure.Root, readFailure.Config))
    {
        using (var preventRead = new FileStream(readFailure.DataPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            await ExpectStorageIoFailure(() => library.MoveAsync(readFailure.Destination));
        }
        Check(library.Root == readFailure.Root && File.ReadAllBytes(readFailure.DataPath).SequenceEqual(readFailure.Data)
            && File.ReadAllBytes(readFailure.Config).SequenceEqual(readFailure.Selection)
            && !Directory.Exists(readFailure.Destination) && !HasStorageTemporaryFiles(readFailure)
            && IsFileLocked(readFailure.Root + ".instance.lock"),
            "copy read failure keeps the source usable and removes only its own staging files");
    }

    var connectFailure = CreateStorageFixture("connect-save-failure");
    CreateSyntheticLibrary(connectFailure.Destination, "candidate");
    var candidateManifest = File.ReadAllBytes(Path.Combine(connectFailure.Destination, "library.json"));
    var candidateData = File.ReadAllBytes(Path.Combine(connectFailure.Destination, "db", "catalog.sqlite"));
    using (var library = new LibraryStorage(connectFailure.Root, connectFailure.Config))
    {
        using (var preventReplacement = new FileStream(connectFailure.Config, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var candidate = library.OpenCandidate(connectFailure.Destination))
        {
            await ExpectStorageIoFailure(() => library.CommitCandidateAsync(candidate));
        }
        Check(library.Root == connectFailure.Root
            && File.ReadAllBytes(connectFailure.DataPath).SequenceEqual(connectFailure.Data)
            && File.ReadAllBytes(connectFailure.Config).SequenceEqual(connectFailure.Selection)
            && File.ReadAllBytes(Path.Combine(connectFailure.Destination, "library.json")).SequenceEqual(candidateManifest)
            && File.ReadAllBytes(Path.Combine(connectFailure.Destination, "db", "catalog.sqlite")).SequenceEqual(candidateData)
            && IsFileLocked(connectFailure.Root + ".instance.lock")
            && !IsFileLocked(connectFailure.Destination + ".instance.lock")
            && !HasStorageTemporaryFiles(connectFailure),
            "failed connect selection replacement keeps both libraries intact and disposes the candidate lock");
    }
}

var cancelledMove = CreateStorageFixture("move-cancelled");
using (var library = new LibraryStorage(cancelledMove.Root, cancelledMove.Config))
using (var cancelMove = new CancellationTokenSource())
{
    var cancelledProgress = new List<StorageMoveProgress>();
    cancelMove.Cancel();
    try { await library.MoveAsync(cancelledMove.Destination, cancelMove.Token,
        new InlineStorageProgress(cancelledProgress.Add)); throw new Exception("Expected canceled move."); }
    catch (OperationCanceledException) { }
    Check(library.Root == cancelledMove.Root && File.ReadAllBytes(cancelledMove.DataPath).SequenceEqual(cancelledMove.Data)
        && File.ReadAllBytes(cancelledMove.Config).SequenceEqual(cancelledMove.Selection)
        && !Directory.Exists(cancelledMove.Destination) && !HasStorageTemporaryFiles(cancelledMove)
        && IsFileLocked(cancelledMove.Root + ".instance.lock")
        && cancelledProgress.All(update => update.Percent < 100 && update.Phase != "completed"),
        "cancelled move retains original bytes and lock, leaves selection unchanged and cleans staging");
}

var progressMove = CreateStorageFixture("move-progress");
File.WriteAllBytes(Path.Combine(progressMove.Root, "vault", "large-media.bin"), new byte[4 * 1024 * 1024 + 17]);
using (var library = new LibraryStorage(progressMove.Root, progressMove.Config))
{
    var updates = new List<StorageMoveProgress>();
    var completedAfterCommit = false;
    var observer = new InlineStorageProgress(update =>
    {
        updates.Add(update);
        if (update.Percent == 100)
            completedAfterCommit = library.Root == progressMove.Destination
                && File.Exists(Path.Combine(progressMove.Destination, "vault", "large-media.bin"))
                && !Directory.Exists(progressMove.Root);
    });
    await library.MoveAsync(progressMove.Destination, progress: observer);
    Check(updates.First().Phase == "preparing" && updates.Last().Phase == "completed"
        && updates.Last().Percent == 100 && completedAfterCommit
        && updates.Zip(updates.Skip(1)).All(pair => pair.First.Percent <= pair.Second.Percent)
        && updates.Any(update => update.Phase == "copying" && update.BytesCompleted > 0 && update.BytesCompleted < update.TotalBytes)
        && updates.Any(update => update.Phase == "verifying" && update.BytesCompleted > 0 && update.BytesCompleted < update.TotalBytes)
        && updates.Any(update => update.Phase == "finishing" && update.Percent is >= 95 and < 100)
        && updates.All(update => update.BytesCompleted >= 0 && update.BytesCompleted <= update.TotalBytes),
        "move reports measured copy and verification byte progress monotonically and reaches 100 only after commit and cleanup");
}

var emptyProgressMove = CreateStorageFixture("move-empty-progress");
foreach (var file in Directory.EnumerateFiles(emptyProgressMove.Root, "*", SearchOption.AllDirectories))
    File.WriteAllBytes(file, []);
using (var library = new LibraryStorage(emptyProgressMove.Root, emptyProgressMove.Config))
{
    var updates = new List<StorageMoveProgress>();
    await library.MoveAsync(emptyProgressMove.Destination, progress: new InlineStorageProgress(updates.Add));
    Check(updates.All(update => update.BytesCompleted == 0 && update.TotalBytes == 0)
        && updates.Zip(updates.Skip(1)).All(pair => pair.First.Percent <= pair.Second.Percent)
        && updates.Last().Percent == 100 && updates.Last().Phase == "completed"
        && File.Exists(Path.Combine(emptyProgressMove.Destination, "db", "catalog.sqlite")),
        "zero-byte library files finish with finite monotonic progress and preserve empty files");
}

var failedObserverMove = CreateStorageFixture("move-failed-observer");
using (var library = new LibraryStorage(failedObserverMove.Root, failedObserverMove.Config))
{
    await library.MoveAsync(failedObserverMove.Destination,
        progress: new InlineStorageProgress(_ => throw new InvalidOperationException("Disconnected progress consumer")));
    Check(library.Root == failedObserverMove.Destination
        && File.ReadAllBytes(Path.Combine(failedObserverMove.Destination, "db", "catalog.sqlite")).SequenceEqual(failedObserverMove.Data),
        "a failed progress consumer cannot interrupt or corrupt a library move");
}

Console.WriteLine($"PASS: {passed} session checks.");

StorageFixture CreateStorageFixture(string scenario)
{
    var directory = Path.GetFullPath(Path.Combine(".cache", "test-storage", Guid.NewGuid().ToString("N"), scenario));
    var root = Path.Combine(directory, "source");
    CreateSyntheticLibrary(root, "original");
    var config = Path.Combine(directory, "selection.json");
    var selection = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { libraryRoot = root });
    File.WriteAllBytes(config, selection);
    var dataPath = Path.Combine(root, "db", "catalog.sqlite");
    return new(root, config, dataPath, Path.Combine(directory, "destination"),
        File.ReadAllBytes(dataPath), File.ReadAllBytes(Path.Combine(root, "library.json")), selection);
}

void CreateSyntheticLibrary(string root, string marker)
{
    Directory.CreateDirectory(Path.Combine(root, "db"));
    File.WriteAllText(Path.Combine(root, "library.json"), "{\"synthetic\":\"" + marker + "\"}");
    File.WriteAllBytes(Path.Combine(root, "db", "catalog.sqlite"), System.Text.Encoding.UTF8.GetBytes(marker + "-catalog-bytes"));
    Directory.CreateDirectory(Path.Combine(root, "vault", "nested"));
    File.WriteAllText(Path.Combine(root, "vault", "nested", "media.bin"), marker + "-encrypted-media-fixture");
}

async Task ExpectStorageIoFailure(Func<Task> operation)
{
    try { await operation(); }
    catch (IOException) { return; }
    catch (UnauthorizedAccessException) { return; }
    throw new Exception("Expected storage I/O failure.");
}

bool IsFileLocked(string path)
{
    try { using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None); return false; }
    catch (IOException) { return true; }
}

bool HasStorageTemporaryFiles(StorageFixture fixture)
{
    var parent = Path.GetDirectoryName(fixture.Root)!;
    return Directory.EnumerateDirectories(parent, ".shronchik-moving-*").Any()
        || Directory.EnumerateFiles(parent, "selection.json.*.tmp").Any();
}

void Check(bool condition, string message)
{
    if (!condition) throw new Exception("FAIL: " + message);
    passed++;
    Console.WriteLine("PASS: " + message);
}
sealed record StorageFixture(string Root, string Config, string DataPath, string Destination,
    byte[] Data, byte[] Manifest, byte[] Selection);
sealed class InlineStorageProgress(Action<StorageMoveProgress> report) : IProgress<StorageMoveProgress>
{
    public void Report(StorageMoveProgress value) => report(value);
}
sealed class ManualClock : TimeProvider
{
    private DateTimeOffset now = DateTimeOffset.Parse("2026-11-04T00:00:00Z");
    public override DateTimeOffset GetUtcNow() => now;
    public void Advance(TimeSpan duration) => now += duration;
}
