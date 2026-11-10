using System.Security.Cryptography;
using System.Text.Json;
using System.Text;
using System.Runtime.InteropServices;
using System.Buffers;
using System.Diagnostics;
using Microsoft.Win32.SafeHandles;

namespace Shronchik.Server.Storage;

public sealed class StorageException(int status, string code) : Exception(code)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public sealed record StorageFolder(string Name, string Path);
public sealed record FolderListing(string? Path, string? ParentPath, IReadOnlyList<StorageFolder> Folders, bool IsLibrary);
public sealed record StorageMoveResult(bool SourceRetained);
public sealed record StorageMoveProgress(string Phase, long BytesCompleted, long TotalBytes,
    int FilesCompleted, int TotalFiles, int Percent);

/// <summary>
/// Owns the selected library and its process locks. Callers must stop and drain
/// all library requests before moving or committing a different library.
/// </summary>
public sealed class LibraryStorage : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly StringComparison PathComparison = OperatingSystem.IsWindows()
        ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private readonly string selectionPath;
    private readonly FileStream selectionLock;
    private FileStream instanceLock;
    public string Root { get; private set; }

    public LibraryStorage(string startRoot, string selectionPath)
    {
        Root = NormalizePath(startRoot);
        this.selectionPath = NormalizePath(selectionPath);
        if (Within(this.selectionPath, Root)) throw new StorageException(400, "invalid_storage_path");
        EnsureNoLinks(this.selectionPath);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(this.selectionPath)!);
        selectionLock = Lock(this.selectionPath + ".lock");
        try
        {
            // ResolveRoot is normally called before construction. Recheck while
            // holding the configuration lock to detect a competing selection.
            if (!Same(ResolveRoot(Root, this.selectionPath), Root))
                throw new StorageException(409, "library_in_use");
            EnsureNoLinks(Root);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Root)!);
            instanceLock = Lock(Root + ".instance.lock");
        }
        catch { selectionLock.Dispose(); throw; }
    }

    public static string ResolveRoot(string defaultRoot, string selectionPath)
    {
        var fallback = NormalizePath(defaultRoot);
        var config = NormalizePath(selectionPath);
        EnsureNoLinks(config);
        if (!File.Exists(config)) return fallback;
        try
        {
            var saved = JsonSerializer.Deserialize<Selection>(File.ReadAllText(config), Json);
            if (saved is null || string.IsNullOrWhiteSpace(saved.LibraryRoot))
                throw new StorageException(422, "invalid_library");
            var root = NormalizePath(saved.LibraryRoot);
            EnsureNoLinks(root);
            if (!IsLibrary(root)) throw new StorageException(422, "invalid_library");
            return root;
        }
        catch (JsonException) { throw new StorageException(422, "invalid_library"); }
    }

    public static FolderListing ListFolders(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            var drives = new List<StorageFolder>();
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.IsReady) drives.Add(new(drive.Name, drive.RootDirectory.FullName));
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            return new(null, null, drives, false);
        }
        var root = NormalizePath(path);
        EnsureNoLinks(root);
        if (!Directory.Exists(root)) throw new StorageException(400, "invalid_storage_path");
        var folders = new List<StorageFolder>();
        try
        {
            foreach (var directory in new DirectoryInfo(root).EnumerateDirectories())
            {
                try
                {
                    if ((directory.Attributes & FileAttributes.ReparsePoint) == 0)
                        folders.Add(new(directory.Name, directory.FullName));
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        catch (UnauthorizedAccessException) { throw new StorageException(403, "storage_unavailable"); }
        folders.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));
        return new(root, Directory.GetParent(root)?.FullName, folders, IsLibrary(root));
    }

    public Candidate OpenCandidate(string path)
    {
        var root = ValidateTarget(path);
        if (!IsLibrary(root)) throw new StorageException(422, "invalid_library");
        var candidate = new Candidate(this, root, Lock(root + ".instance.lock"));
        try
        {
            candidate.HoldRoot();
            // Do not let validation or a subsequent read follow a junction/file
            // symlink anywhere inside the selected library.
            Snapshot(root);
            return candidate;
        }
        catch { candidate.Dispose(); throw; }
    }

    public async Task CommitCandidateAsync(Candidate candidate, CancellationToken ct = default)
    {
        candidate.CheckOwner(this);
        await SaveSelectionAsync(candidate.Root, ct);
        var old = instanceLock;
        instanceLock = candidate.TakeLock(this);
        Root = candidate.Root;
        old.Dispose();
    }

    public async Task<StorageMoveResult> MoveAsync(string destination, CancellationToken ct = default,
        IProgress<StorageMoveProgress>? progress = null)
    {
        var reporting = new MoveProgressReporter(progress);
        reporting.Report("preparing", 0, 0, 0, 0, 0);
        var target = ValidateTarget(destination);
        var parent = System.IO.Path.GetDirectoryName(target)!;
        if (File.Exists(target)) throw new StorageException(409, "storage_not_empty");
        if (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any())
            throw new StorageException(409, "storage_not_empty");
        var source = Root;
        // Windows directory handles without FILE_SHARE_DELETE prevent an
        // external rename/replacement of the source while cleanup is running.
        using var sourceDirectory = HoldDirectory(source);
        var snapshot = Snapshot(source);
        Directory.CreateDirectory(parent);
        using var candidate = new Candidate(this, target, Lock(target + ".instance.lock"));
        var requiredBytes = snapshot.Files.Sum(file => file.Length);
        try
        {
            if (new DriveInfo(System.IO.Path.GetPathRoot(target)!).AvailableFreeSpace < requiredBytes + 16L * 1024 * 1024)
                throw new StorageException(507, "insufficient_storage");
        }
        catch (ArgumentException) { }
        var staging = System.IO.Path.Combine(parent, ".shronchik-moving-" + Guid.NewGuid().ToString("N"));
        var published = false;
        var committed = false;
        FileStream? sourceLock = null;
        try
        {
            Directory.CreateDirectory(staging);
            foreach (var directory in snapshot.Directories)
                Directory.CreateDirectory(System.IO.Path.Combine(staging, directory));
            long copied = 0;
            var copiedFiles = 0;
            reporting.Report("copying", 0, requiredBytes, 0, snapshot.Files.Count, 0);
            var buffer = ArrayPool<byte>.Shared.Rent(1024 * 1024);
            try
            {
                foreach (var file in snapshot.Files)
                {
                    ct.ThrowIfCancellationRequested();
                    var from = System.IO.Path.Combine(source, file.RelativePath);
                    var to = System.IO.Path.Combine(staging, file.RelativePath);
                    EnsureNoLinks(from);
                    await using (var input = new FileStream(from, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, true))
                    await using (var output = new FileStream(to, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true))
                    {
                        int read;
                        while ((read = await input.ReadAsync(buffer.AsMemory(), ct)) != 0)
                        {
                            await output.WriteAsync(buffer.AsMemory(0, read), ct);
                            copied += read;
                            reporting.Report("copying", copied, requiredBytes, copiedFiles, snapshot.Files.Count,
                                ScaleProgress(copied, requiredBytes, 0, 70));
                        }
                        await output.FlushAsync(ct);
                        output.Flush(flushToDisk: true);
                    }
                    copiedFiles++;
                    reporting.Report("copying", copied, requiredBytes, copiedFiles, snapshot.Files.Count,
                        ScaleProgress(copied, requiredBytes, 0, 70));
                }
            }
            finally { ArrayPool<byte>.Shared.Return(buffer); }

            long verified = 0;
            var verifiedFiles = 0;
            var verificationBytes = checked(requiredBytes * 2);
            reporting.Report("verifying", 0, verificationBytes, 0, snapshot.Files.Count, 70);
            void VerifiedBytes(int count)
            {
                verified += count;
                reporting.Report("verifying", verified, verificationBytes, verifiedFiles, snapshot.Files.Count,
                    ScaleProgress(verified, verificationBytes, 70, 25));
            }
            foreach (var file in snapshot.Files)
            {
                var from = System.IO.Path.Combine(source, file.RelativePath);
                var to = System.IO.Path.Combine(staging, file.RelativePath);
                EnsureNoLinks(from);
                file.Hash = await HashAsync(from, ct, VerifiedBytes);
                var copiedHash = await HashAsync(to, ct, VerifiedBytes);
                if (!CryptographicOperations.FixedTimeEquals(file.Hash, copiedHash))
                    throw new IOException("Library copy verification failed.");
                verifiedFiles++;
                reporting.Report("verifying", verified, verificationBytes, verifiedFiles, snapshot.Files.Count,
                    ScaleProgress(verified, verificationBytes, 70, 25));
            }
            ct.ThrowIfCancellationRequested();
            reporting.Report("finishing", 0, requiredBytes, 0, snapshot.Files.Count, 95);
            // Recheck the destination immediately before publication. Only an
            // empty directory is removed; existing user files are never replaced.
            EnsureNoLinks(target);
            if (Directory.Exists(target)) Directory.Delete(target, recursive: false);
            Directory.Move(staging, target);
            published = true;
            candidate.HoldRoot();
            // Once published, finish the small atomic selection write even if
            // the browser disconnects. A failure still leaves the source active.
            await SaveSelectionAsync(target, CancellationToken.None);
            sourceLock = instanceLock;
            instanceLock = candidate.TakeLock(this);
            Root = target;
            committed = true;

            // Remove only files verified in the snapshot, with the original
            // process lock still held. Unexpected new/changed files are kept.
            long cleanedBytes = 0;
            var cleanedFiles = 0;
            void CleanedBytes(int count)
            {
                cleanedBytes += count;
                reporting.Report("finishing", cleanedBytes, requiredBytes, cleanedFiles, snapshot.Files.Count,
                    ScaleProgress(cleanedBytes, requiredBytes, 95, 4));
            }
            void CleanedFile()
            {
                cleanedFiles++;
                reporting.Report("finishing", cleanedBytes, requiredBytes, cleanedFiles, snapshot.Files.Count,
                    ScaleProgress(cleanedBytes, requiredBytes, 95, 4));
            }
            var retained = !await RemoveCopiedFilesAsync(source, snapshot, CleanedBytes, CleanedFile);
            foreach (var directory in snapshot.Directories.OrderByDescending(item => item.Length))
            {
                TryRemoveEmpty(System.IO.Path.Combine(source, directory));
            }
            sourceDirectory?.Dispose();
            TryRemoveEmpty(source);
            reporting.Report("completed", requiredBytes, requiredBytes, snapshot.Files.Count, snapshot.Files.Count, 100);
            return new(retained || Directory.Exists(source));
        }
        catch
        {
            if (!committed)
            {
                // These paths were created exclusively by this operation.
                if (published)
                {
                    candidate.ReleaseDirectory();
                    await RemoveCopiedFilesAsync(target, snapshot);
                    foreach (var directory in snapshot.Directories.OrderByDescending(item => item.Length))
                        TryRemoveEmpty(System.IO.Path.Combine(target, directory));
                    TryRemoveEmpty(target);
                }
                else TryRemoveOwnedTree(staging);
            }
            throw;
        }
        finally { sourceLock?.Dispose(); }
    }

    private string ValidateTarget(string path)
    {
        var target = NormalizePath(path);
        if (System.IO.Path.GetDirectoryName(target) is null || Same(target, Root)
            || Within(target, Root) || Within(Root, target)
            || Within(selectionPath, target) || Within(selectionPath + ".lock", target))
            throw new StorageException(400, "invalid_storage_path");
        EnsureNoLinks(target);
        return target;
    }

    private async Task SaveSelectionAsync(string root, CancellationToken ct)
    {
        EnsureNoLinks(selectionPath);
        var temporary = selectionPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, true))
            {
                await JsonSerializer.SerializeAsync(stream, new Selection(root), Json, ct);
                await stream.FlushAsync(ct);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, selectionPath, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static string NormalizePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !System.IO.Path.IsPathFullyQualified(path))
            throw new StorageException(400, "invalid_storage_path");
        try
        {
            var full = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(path));
            if (!OperatingSystem.IsWindows()) return full;
            // Win32 silently aliases trailing dots/spaces and ADS syntax. Do
            // not let those spellings bypass overlap and no-clobber checks.
            if (full.StartsWith(@"\\?\", StringComparison.Ordinal) || full.StartsWith(@"\\.\", StringComparison.Ordinal)
                || full.Split(['\\', '/'], StringSplitOptions.RemoveEmptyEntries).Any(segment =>
                    segment.EndsWith('.') || segment.EndsWith(' ')
                    || (segment.Contains(':') && !(segment.Length == 2 && char.IsAsciiLetter(segment[0]) && segment[1] == ':'))))
                throw new StorageException(400, "invalid_storage_path");
            EnsureNoLinks(full);
            // Expand existing 8.3 aliases too. Missing suffixes are appended to
            // the physical existing parent so nested aliases compare correctly.
            var ancestor = full;
            while (!Directory.Exists(ancestor))
                ancestor = System.IO.Path.GetDirectoryName(ancestor)
                    ?? throw new StorageException(400, "invalid_storage_path");
            using var handle = CreateFile(ancestor, 0, FileShare.Read | FileShare.Write | FileShare.Delete,
                IntPtr.Zero, FileMode.Open, 0x02000000, IntPtr.Zero);
            if (handle.IsInvalid) throw new StorageException(503, "storage_unavailable");
            var buffer = new StringBuilder(32768);
            var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) throw new StorageException(503, "storage_unavailable");
            var canonical = buffer.ToString();
            if (canonical.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) canonical = @"\\" + canonical[8..];
            else if (canonical.StartsWith(@"\\?\", StringComparison.Ordinal)) canonical = canonical[4..];
            var relative = System.IO.Path.GetRelativePath(ancestor, full);
            return System.IO.Path.TrimEndingDirectorySeparator(relative == "." ? canonical : System.IO.Path.Combine(canonical, relative));
        }
        catch (ArgumentException) { throw new StorageException(400, "invalid_storage_path"); }
        catch (NotSupportedException) { throw new StorageException(400, "invalid_storage_path"); }
    }

    private static bool Same(string a, string b) => string.Equals(a, b, PathComparison);
    private static bool Within(string path, string directory) => Same(path, directory)
        || path.StartsWith(System.IO.Path.TrimEndingDirectorySeparator(directory) + System.IO.Path.DirectorySeparatorChar, PathComparison);

    private static void EnsureNoLinks(string path)
    {
        for (var current = path; current is not null; current = System.IO.Path.GetDirectoryName(current))
        {
            if ((File.Exists(current) || Directory.Exists(current))
                && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new StorageException(400, "invalid_storage_path");
        }
    }

    private static bool IsLibrary(string root) => File.Exists(System.IO.Path.Combine(root, "library.json"))
        && File.Exists(System.IO.Path.Combine(root, "db", "catalog.sqlite"));

    private static FileStream Lock(string path)
    {
        EnsureNoLinks(path);
        try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new StorageException(409, "library_in_use"); }
    }

    private static SafeFileHandle? HoldDirectory(string path)
    {
        if (!OperatingSystem.IsWindows()) return null;
        var handle = CreateFile(path, 0, FileShare.Read | FileShare.Write, IntPtr.Zero,
            FileMode.Open, 0x02000000, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        throw new StorageException(503, "storage_unavailable");
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string fileName, uint access, FileShare share,
        IntPtr securityAttributes, FileMode mode, uint flags, IntPtr template);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);

    private static LibrarySnapshot Snapshot(string root)
    {
        EnsureNoLinks(root);
        var result = new LibrarySnapshot();
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.TryPop(out var directory))
        {
            foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
            {
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new StorageException(400, "invalid_storage_path");
                var relative = System.IO.Path.GetRelativePath(root, entry.FullName);
                if (entry is DirectoryInfo)
                {
                    result.Directories.Add(relative);
                    pending.Push(entry.FullName);
                }
                else result.Files.Add(new(relative, ((FileInfo)entry).Length));
            }
        }
        return result;
    }

    private static async Task<byte[]> HashAsync(string path, CancellationToken ct, Action<int>? bytesRead = null)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, true);
        if (bytesRead is null) return await SHA256.HashDataAsync(stream, ct);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(1024 * 1024);
        try
        {
            int read;
            while ((read = await stream.ReadAsync(buffer.AsMemory(), ct)) != 0)
            {
                hash.AppendData(buffer, 0, read);
                bytesRead(read);
            }
            return hash.GetHashAndReset();
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    private static async Task<bool> RemoveCopiedFilesAsync(string root, LibrarySnapshot snapshot,
        Action<int>? bytesRead = null, Action? fileFinished = null)
    {
        var removedAll = true;
        foreach (var file in snapshot.Files)
        {
            var path = System.IO.Path.Combine(root, file.RelativePath);
            try
            {
                EnsureNoLinks(path);
                if (!File.Exists(path)) continue;
                var currentHash = await HashAsync(path, CancellationToken.None, bytesRead);
                if (file.Hash is null || !CryptographicOperations.FixedTimeEquals(file.Hash, currentHash))
                { removedAll = false; continue; }
                File.Delete(path);
            }
            catch (IOException) { removedAll = false; }
            catch (UnauthorizedAccessException) { removedAll = false; }
            catch (StorageException) { removedAll = false; }
            finally { fileFinished?.Invoke(); }
        }
        return removedAll;
    }

    private static void TryRemoveEmpty(string path)
    {
        try { EnsureNoLinks(path); Directory.Delete(path, recursive: false); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (StorageException) { }
    }

    private static void TryRemoveOwnedTree(string root)
    {
        try
        {
            if (!Directory.Exists(root)) return;
            var snapshot = Snapshot(root);
            foreach (var file in snapshot.Files) File.Delete(System.IO.Path.Combine(root, file.RelativePath));
            foreach (var directory in snapshot.Directories.OrderByDescending(item => item.Length))
                Directory.Delete(System.IO.Path.Combine(root, directory), recursive: false);
            Directory.Delete(root, recursive: false);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (StorageException) { }
    }

    public void Dispose() { instanceLock.Dispose(); selectionLock.Dispose(); }

    private static int ScaleProgress(long completed, long total, int start, int span) =>
        start + (total == 0 ? span : (int)(Math.Clamp((double)completed / total, 0, 1) * span));

    private sealed class MoveProgressReporter(IProgress<StorageMoveProgress>? observer)
    {
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private long lastUpdate = -100;
        private string? lastPhase;
        private int lastPercent;

        public void Report(string phase, long completed, long total, int filesCompleted, int totalFiles, int percent)
        {
            if (observer is null) return;
            percent = Math.Clamp(Math.Max(percent, lastPercent), 0, 100);
            if (phase == lastPhase && percent == lastPercent && clock.ElapsedMilliseconds - lastUpdate < 100) return;
            lastPhase = phase;
            lastPercent = percent;
            lastUpdate = clock.ElapsedMilliseconds;
            // Telemetry or a disconnected progress consumer must not break a committed move.
            try { observer.Report(new(phase, completed, total, filesCompleted, totalFiles, percent)); }
            catch (Exception) { observer = null; }
        }
    }

    public sealed class Candidate : IDisposable
    {
        private readonly LibraryStorage owner;
        private FileStream? stream;
        private SafeFileHandle? directory;
        public string Root { get; }
        internal Candidate(LibraryStorage owner, string root, FileStream stream)
        { this.owner = owner; Root = root; this.stream = stream; }
        internal void HoldRoot() => directory = HoldDirectory(Root);
        internal void ReleaseDirectory() { directory?.Dispose(); directory = null; }
        internal void CheckOwner(LibraryStorage storage)
        {
            if (owner != storage || stream is null) throw new InvalidOperationException("Candidate is closed or belongs to another storage.");
        }
        internal FileStream TakeLock(LibraryStorage storage)
        {
            CheckOwner(storage);
            var result = stream!;
            stream = null;
            return result;
        }
        public void Dispose() { ReleaseDirectory(); stream?.Dispose(); stream = null; }
    }

    private sealed record Selection(string LibraryRoot);
    private sealed class LibrarySnapshot
    {
        public List<string> Directories { get; } = [];
        public List<SnapshotFile> Files { get; } = [];
    }
    private sealed class SnapshotFile(string relativePath, long length)
    {
        public string RelativePath { get; } = relativePath;
        public long Length { get; } = length;
        public byte[]? Hash { get; set; }
    }
}
