using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace Shronchik.Core.Crypto;

public sealed record WrappedKey(string Salt, string Nonce, string Ciphertext, string Tag,
    int MemoryKiB = 65536, int Iterations = 3, int Parallelism = 2, int Version = 1);

/// <summary>Independent Argon2id-derived password wrappers around a random master key.</summary>
public static class PasswordKeyWrap
{
    private const int KeySize = 32;
    private const int TagSize = 16;
    private static readonly byte[] Domain = "Shronchik/password-wrap/v1"u8.ToArray();

    public static Task<WrappedKey> WrapAsync(string password, byte[] masterKey,
        CancellationToken ct = default) => WrapAsync(password, masterKey, string.Empty, ct);

    /// <param name="context">Expected library ID and role, supplied by the caller, not read from the wrapper.</param>
    public static async Task<WrappedKey> WrapAsync(string password, byte[] masterKey,
        string context, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(masterKey);
        if (masterKey.Length != KeySize) throw new ArgumentException("A 256-bit master key is required.", nameof(masterKey));
        ValidatePassword(password);
        ValidateContext(context);
        var salt = RandomNumberGenerator.GetBytes(16);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var encrypted = new byte[KeySize];
        var tag = new byte[TagSize];
        var parameters = new WrappedKey(Convert.ToBase64String(salt), Convert.ToBase64String(nonce), "", "");
        var key = await DeriveAsync(password, salt, parameters, ct);
        try
        {
            using var aes = new AesGcm(key, TagSize);
            aes.Encrypt(nonce, masterKey, encrypted, tag, MakeAad(parameters, context));
            return parameters with { Ciphertext = Convert.ToBase64String(encrypted), Tag = Convert.ToBase64String(tag) };
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    public static Task<byte[]?> UnwrapAsync(string password, WrappedKey wrapped,
        CancellationToken ct = default) => UnwrapAsync(password, wrapped, string.Empty, ct);

    /// <param name="context">Must match the independently expected library ID and role used at wrapping.</param>
    public static async Task<byte[]?> UnwrapAsync(string password, WrappedKey wrapped,
        string context, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(wrapped);
        ValidatePassword(password);
        ValidateContext(context);
        // Bound untrusted KDF settings before any allocation or expensive computation.
        if (wrapped.Version != 1 || wrapped.MemoryKiB is < 65536 or > 262144
            || wrapped.Iterations is < 3 or > 10 || wrapped.Parallelism is < 1 or > 4)
            throw new CryptographicException("Unsupported password wrapper parameters.");
        var salt = Decode(wrapped.Salt, 16);
        var nonce = Decode(wrapped.Nonce, 12);
        var ciphertext = Decode(wrapped.Ciphertext, KeySize);
        var tag = Decode(wrapped.Tag, TagSize);
        var key = await DeriveAsync(password, salt, wrapped, ct);
        var masterKey = new byte[KeySize];
        try
        {
            using var aes = new AesGcm(key, TagSize);
            aes.Decrypt(nonce, ciphertext, tag, masterKey, MakeAad(wrapped, context));
            return masterKey;
        }
        catch (AuthenticationTagMismatchException)
        {
            CryptographicOperations.ZeroMemory(masterKey);
            return null;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(masterKey);
            throw;
        }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    private static async Task<byte[]> DeriveAsync(string password, byte[] salt,
        WrappedKey parameters, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var bytes = Encoding.UTF8.GetBytes(password);
        try
        {
            using var argon = new Argon2id(bytes)
            {
                Salt = salt,
                MemorySize = parameters.MemoryKiB,
                Iterations = parameters.Iterations,
                DegreeOfParallelism = parameters.Parallelism
            };
            // This library has no cancellable KDF. Await completion before clearing its
            // inputs, then discard its output if cancellation arrived in the meantime.
            var key = await argon.GetBytesAsync(KeySize);
            if (ct.IsCancellationRequested)
            {
                CryptographicOperations.ZeroMemory(key);
                ct.ThrowIfCancellationRequested();
            }
            return key;
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static byte[] MakeAad(WrappedKey wrapped, string context)
    {
        var contextBytes = Encoding.UTF8.GetBytes(context);
        var aad = new byte[Domain.Length + 20 + contextBytes.Length];
        Domain.CopyTo(aad, 0);
        BinaryPrimitives.WriteInt32LittleEndian(aad.AsSpan(Domain.Length), wrapped.Version);
        BinaryPrimitives.WriteInt32LittleEndian(aad.AsSpan(Domain.Length + 4), wrapped.MemoryKiB);
        BinaryPrimitives.WriteInt32LittleEndian(aad.AsSpan(Domain.Length + 8), wrapped.Iterations);
        BinaryPrimitives.WriteInt32LittleEndian(aad.AsSpan(Domain.Length + 12), wrapped.Parallelism);
        BinaryPrimitives.WriteInt32LittleEndian(aad.AsSpan(Domain.Length + 16), contextBytes.Length);
        contextBytes.CopyTo(aad, Domain.Length + 20);
        return aad;
    }

    private static byte[] Decode(string value, int length)
    {
        if (value is null || value.Length > 128)
            throw new CryptographicException("Invalid password wrapper encoding.");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(value); }
        catch (FormatException ex) { throw new CryptographicException("Invalid password wrapper encoding.", ex); }
        if (bytes.Length != length) throw new CryptographicException("Invalid password wrapper field length.");
        return bytes;
    }

    private static void ValidatePassword(string password)
    {
        ArgumentNullException.ThrowIfNull(password);
        if (password.Length == 0 || password.Length > 1024 || Encoding.UTF8.GetByteCount(password) > 1024)
            throw new ArgumentException("Password must contain 1–1024 UTF-8 bytes.", nameof(password));
    }

    private static void ValidateContext(string context)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (Encoding.UTF8.GetByteCount(context) > 256)
            throw new ArgumentException("Wrapper context is too long.", nameof(context));
    }
}
