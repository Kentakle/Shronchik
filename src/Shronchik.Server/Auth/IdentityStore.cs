using System.Security.Cryptography;
using System.Text.Json;
using Shronchik.Core.Crypto;

namespace Shronchik.Server.Auth;

public sealed record Account(WrappedKey Key, bool WeakPassword)
{
    public bool Enabled { get; init; } = true;
    public bool CanUpload { get; init; }
    public bool MustChangePassword { get; init; }
    public bool PendingDeletion { get; init; }
}
public sealed record LibraryIdentity(int Version, Guid LibraryId, Dictionary<string, Account> Accounts);

public sealed class IdentityStore
{
    public const string AdminId = "Admin";
    public const string LegacyUserId = "User";
    private const int ManifestVersion = 2;
    private readonly string path;
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private volatile LibraryIdentity identity = null!;
    public LibraryIdentity Identity => identity;
    public Guid LibraryId => Identity.LibraryId;

    public IdentityStore(string root) => path = Path.Combine(root, "library.json");

    // A storage transition has drained every request and copied the manifest unchanged.
    public IdentityStore AtRoot(string root) => new(root) { identity = Identity };

    public async Task LoadAsync(CancellationToken ct = default)
    {
        if (File.Exists(path))
        {
            identity = JsonSerializer.Deserialize<LibraryIdentity>(await File.ReadAllTextAsync(path, ct), Json)
                ?? throw new InvalidDataException("Invalid library manifest.");
            if (Identity.Version is not (1 or ManifestVersion) || Identity.LibraryId == Guid.Empty
                || Identity.Accounts is null || !Identity.Accounts.TryGetValue(AdminId, out var admin)
                || admin is not { Enabled: true, Key: not null, PendingDeletion: false }
                || (Identity.Version == 1 && (Identity.Accounts.Count != 2 || !Identity.Accounts.ContainsKey(LegacyUserId)))
                || Identity.Accounts.Any(item => NormalizeAccountId(item.Key) != item.Key || item.Value?.Key is null
                    || (item.Value.PendingDeletion && item.Value.Enabled)))
                throw new InvalidDataException("Unsupported library manifest.");
            return;
        }
        // Never silently create fresh keys over an existing vault or database.
        var root = Path.GetDirectoryName(path)!;
        if (Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root).Any())
            throw new InvalidDataException("Library manifest missing in nonempty library.");
        Directory.CreateDirectory(root);
        var key = RandomNumberGenerator.GetBytes(32);
        try
        {
            var id = Guid.NewGuid();
            var accounts = new Dictionary<string, Account>();
            accounts[AdminId] = new(await PasswordKeyWrap.WrapAsync("1111", key, $"{id:N}:{AdminId}", ct), true);
            identity = new(ManifestVersion, id, accounts);
            await SaveAsync(ct);
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    public static string? NormalizeAccountId(string? username)
    {
        var name = username?.Trim();
        if (name is not { Length: > 0 and <= 32 } || !char.IsAsciiLetterOrDigit(name[0])
            || name.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('_' or '-' or '.')))
            return null;
        return name.ToLowerInvariant() switch
        {
            "admin" => AdminId,
            "user" => LegacyUserId,
            var normalized => normalized
        };
    }

    public static string RoleFor(string accountId) => accountId == AdminId ? "Admin" : "User";
    public Account? Find(string? accountId) => accountId is not null && Identity.Accounts.TryGetValue(accountId, out var account)
        ? account : null;
    public bool CanUpload(string? accountId) => Find(accountId) is { Enabled: true, PendingDeletion: false } account
        && (accountId == AdminId || account.CanUpload);

    public async Task<byte[]?> UnlockAsync(string? accountId, string? password, CancellationToken ct = default)
    {
        if (password is not { Length: > 0 and <= 1024 }) return null;
        if (Find(accountId) is not { Enabled: true, PendingDeletion: false } account)
        {
            // Do equivalent KDF work for absent/disabled usernames. A fast
            // return otherwise reveals which names exist through login timing.
            // This AAD cannot match any real account, even for Admin's password.
            var rejected = await PasswordKeyWrap.UnwrapAsync(password, Identity.Accounts[AdminId].Key,
                $"{LibraryId:N}:invalid-account", ct);
            if (rejected is not null) CryptographicOperations.ZeroMemory(rejected);
            return null;
        }
        return await PasswordKeyWrap.UnwrapAsync(password, account.Key, $"{LibraryId:N}:{accountId}", ct);
    }

    public async Task<Account?> CreateUserAsync(string accountId, string password, byte[] masterKey, CancellationToken ct,
        bool canUpload = false)
    {
        if (NormalizeAccountId(accountId) != accountId || accountId == AdminId)
            throw new ArgumentException("Invalid account ID.");
        ValidateManagedPassword(password);
        await gate.WaitAsync(ct);
        try
        {
            if (Find(accountId) is not null) return null;
            var wrapped = await PasswordKeyWrap.WrapAsync(password, masterKey, $"{LibraryId:N}:{accountId}", ct);
            var account = new Account(wrapped, false) { MustChangePassword = true, CanUpload = canUpload };
            await SaveAccountAsync(accountId, account, ct);
            return account;
        }
        finally { gate.Release(); }
    }

    public Task<Account> SetEnabledAsync(string accountId, bool enabled, CancellationToken ct) =>
        SetStateAsync(accountId, enabled, null, ct);

    public async Task<Account> SetStateAsync(string accountId, bool? enabled, bool? canUpload, CancellationToken ct)
    {
        if (accountId == AdminId) throw new ArgumentException("Admin permissions cannot be changed.");
        if (enabled is null && canUpload is null) throw new ArgumentException("No account changes supplied.");
        await gate.WaitAsync(ct);
        try
        {
            var current = Find(accountId) ?? throw new KeyNotFoundException("Account does not exist.");
            if (current.PendingDeletion) throw new ArgumentException("Account deletion must finish first.");
            var account = current with { Enabled = enabled ?? current.Enabled, CanUpload = canUpload ?? current.CanUpload };
            if (account == current) return current;
            await SaveAccountAsync(accountId, account, ct);
            return account;
        }
        finally { gate.Release(); }
    }

    public async Task<Account> ChangePasswordAsync(string accountId, string password, byte[] masterKey,
        bool temporary, bool allowLegacyLength, CancellationToken ct)
    {
        if (allowLegacyLength)
        {
            if (password is not { Length: >= 4 and <= 256 })
                throw new ArgumentException("Invalid password.");
        }
        else ValidateManagedPassword(password);
        if (accountId == AdminId && temporary)
            throw new ArgumentException("Invalid password.");
        await gate.WaitAsync(ct);
        try
        {
            var current = Find(accountId) ?? throw new KeyNotFoundException("Account does not exist.");
            if (current.PendingDeletion) throw new ArgumentException("Account deletion must finish first.");
            var wrapped = await PasswordKeyWrap.WrapAsync(password, masterKey, $"{LibraryId:N}:{accountId}", ct);
            var account = current with { Key = wrapped, WeakPassword = password.Length < 12, MustChangePassword = temporary };
            await SaveAccountAsync(accountId, account, ct);
            return account;
        }
        finally { gate.Release(); }
    }

    private static void ValidateManagedPassword(string password)
    {
        if (password is not { Length: >= 12 and <= 256 }) throw new ArgumentException("Invalid password.");
    }

    public async Task BeginDeletionAsync(string accountId, CancellationToken ct)
    {
        if (accountId == AdminId) throw new ArgumentException("Admin cannot be deleted.");
        await gate.WaitAsync(ct);
        try
        {
            var current = Find(accountId);
            if (current is null || current.PendingDeletion) return;
            await SaveAccountAsync(accountId, current with { Enabled = false, PendingDeletion = true }, ct);
        }
        finally { gate.Release(); }
    }

    public async Task CompleteDeletionAsync(string accountId, CancellationToken ct)
    {
        if (accountId == AdminId) throw new ArgumentException("Admin cannot be deleted.");
        await gate.WaitAsync(ct);
        try
        {
            var current = Find(accountId);
            if (current is null) return;
            if (!current.PendingDeletion) throw new InvalidOperationException("Account deletion was not started.");
            var accounts = new Dictionary<string, Account>(Identity.Accounts);
            accounts.Remove(accountId);
            var updated = Identity with { Version = ManifestVersion, Accounts = accounts };
            await SaveAsync(ct, updated);
            identity = updated;
        }
        finally { gate.Release(); }
    }

    private async Task SaveAccountAsync(string accountId, Account account, CancellationToken ct)
    {
        var accounts = new Dictionary<string, Account>(Identity.Accounts) { [accountId] = account };
        var updated = Identity with { Version = ManifestVersion, Accounts = accounts };
        await SaveAsync(ct, updated);
        identity = updated;
    }

    private async Task SaveAsync(CancellationToken ct, LibraryIdentity? updated = null)
    {
        var temp = path + ".partial";
        await using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            await JsonSerializer.SerializeAsync(stream, updated ?? Identity, Json, ct);
            await stream.FlushAsync(ct);
            stream.Flush(true);
        }
        File.Move(temp, path, true);
    }
}
