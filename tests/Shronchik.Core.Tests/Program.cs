using System.Security.Cryptography;
using System.Text.Json;
using Shronchik.Core.Crypto;

var workspace = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
var directory = Path.Combine(workspace, ".cache", "test-crypto", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
var key = RandomNumberGenerator.GetBytes(32);
var cipher = new VaultCipher();
var passed = 0;
try
{
    var original = RandomNumberGenerator.GetBytes(VaultCipher.ChunkSize * 2 + 173);
    var objectId = Guid.NewGuid();
    var path = Path.Combine(directory, "test.srm");
    using (var input = new MemoryStream(original, writable: false))
    {
        var info = await cipher.EncryptAsync(input, path, key, objectId);
        Check(info.Length == original.Length, "reported length");
        Check(info.Sha256 == Convert.ToHexString(SHA256.HashData(original)).ToLowerInvariant(), "streaming SHA-256");
    }
    Check(await cipher.GetLengthAsync(path, key, objectId) == original.Length, "authenticated length");
    foreach (var (offset, count) in new (long, long)[]
    {
        (0, original.Length), (0, 1), (VaultCipher.ChunkSize - 13, 51),
        (VaultCipher.ChunkSize, VaultCipher.ChunkSize + 173), (original.Length - 1, 1),
        (original.Length, 0)
    })
    {
        using var output = new MemoryStream();
        await cipher.CopyRangeAsync(path, output, key, objectId, offset, count);
        Check(output.ToArray().AsSpan().SequenceEqual(original.AsSpan((int)offset, (int)count)), $"range {offset}+{count}");
    }
    var bytes = await File.ReadAllBytesAsync(path);
    Check(!bytes.AsSpan(0, Math.Min(bytes.Length, 1024)).SequenceEqual(original.AsSpan(0, Math.Min(original.Length, 1024))), "encrypted bytes differ");
    await Throws<CryptographicException>(() => cipher.GetLengthAsync(path, key, Guid.NewGuid()), "object substitution rejected");
    var otherKey = RandomNumberGenerator.GetBytes(32);
    await Throws<CryptographicException>(() => cipher.GetLengthAsync(path, otherKey, objectId), "wrong master key rejected");
    CryptographicOperations.ZeroMemory(otherKey);

    var tamperedHeader = Path.Combine(directory, "header.srm");
    var modified = bytes.ToArray();
    modified[32] ^= 1;
    await File.WriteAllBytesAsync(tamperedHeader, modified);
    await Throws<CryptographicException>(() => cipher.GetLengthAsync(tamperedHeader, key, objectId), "header tampering rejected");

    var tamperedData = Path.Combine(directory, "data.srm");
    modified = bytes.ToArray();
    modified[VaultCipher.HeaderSize + 27] ^= 1;
    await File.WriteAllBytesAsync(tamperedData, modified);
    using (var output = new MemoryStream())
    {
        await Throws<CryptographicException>(() => cipher.CopyRangeAsync(tamperedData, output, key, objectId, 0, 100), "ciphertext tampering rejected");
        Check(output.Length == 0, "no unauthenticated plaintext emitted");
    }
    var truncated = Path.Combine(directory, "truncated.srm");
    await File.WriteAllBytesAsync(truncated, bytes[..^1]);
    await Throws<CryptographicException>(() => cipher.GetLengthAsync(truncated, key, objectId), "truncation rejected");
    var appended = Path.Combine(directory, "appended.srm");
    await File.WriteAllBytesAsync(appended, bytes.Concat(new byte[] { 0 }).ToArray());
    await Throws<CryptographicException>(() => cipher.GetLengthAsync(appended, key, objectId), "trailing bytes rejected");

    using (var output = new MemoryStream())
        await Throws<ArgumentOutOfRangeException>(() => cipher.CopyRangeAsync(path, output, key, objectId, original.Length - 1, 2), "out-of-bounds range rejected");

    var emptyPath = Path.Combine(directory, "empty.srm");
    var emptyId = Guid.NewGuid();
    using (var input = new MemoryStream())
        await cipher.EncryptAsync(input, emptyPath, key, emptyId);
    Check(await cipher.GetLengthAsync(emptyPath, key, emptyId) == 0, "empty file authenticated");

    var exactPath = Path.Combine(directory, "exact.srm");
    var exactId = Guid.NewGuid();
    using (var input = new MemoryStream(original, 0, VaultCipher.ChunkSize, writable: false))
        await cipher.EncryptAsync(input, exactPath, key, exactId);
    using (var output = new MemoryStream())
    {
        await cipher.CopyRangeAsync(exactPath, output, key, exactId, 0, VaultCipher.ChunkSize);
        Check(output.ToArray().AsSpan().SequenceEqual(original.AsSpan(0, VaultCipher.ChunkSize)), "last full block roundtrip");
    }

    var interruptedPath = Path.Combine(directory, "interrupted.srm");
    using (var input = new FaultingSource(original, VaultCipher.ChunkSize + 5))
        await Throws<IOException>(() => cipher.EncryptAsync(input, interruptedPath, key, Guid.NewGuid()), "failed source aborts encryption");
    Check(!File.Exists(interruptedPath), "failed encryption removes partial container");

    using (var cancellation = new CancellationTokenSource())
    using (var output = new CancelAfterWriteStream(cancellation))
    {
        await Throws<OperationCanceledException>(() => cipher.CopyRangeAsync(path, output, key, objectId, 0, original.Length, cancellation.Token), "range cancellation observed between blocks");
        Check(output.Length == VaultCipher.ChunkSize, "cancelled range emits no later blocks");
    }

    var swappedPath = Path.Combine(directory, "swapped.srm");
    modified = bytes.ToArray();
    var recordSize = VaultCipher.ChunkSize + 16;
    bytes.AsSpan(VaultCipher.HeaderSize + recordSize, recordSize).CopyTo(modified.AsSpan(VaultCipher.HeaderSize));
    bytes.AsSpan(VaultCipher.HeaderSize, recordSize).CopyTo(modified.AsSpan(VaultCipher.HeaderSize + recordSize));
    await File.WriteAllBytesAsync(swappedPath, modified);
    using (var output = new MemoryStream())
        await Throws<CryptographicException>(() => cipher.CopyRangeAsync(swappedPath, output, key, objectId, 0, 1), "swapped blocks rejected");

    const string context = "946cdf325c014d898fdc4d6779bde3fd:Admin";
    var wrapped = await PasswordKeyWrap.WrapAsync("правильный длинный пароль", key, context);
    var serialized = JsonSerializer.Serialize(wrapped);
    var restored = JsonSerializer.Deserialize<WrappedKey>(serialized)!;
    var unwrapped = await PasswordKeyWrap.UnwrapAsync("правильный длинный пароль", restored, context);
    Check(unwrapped is not null && CryptographicOperations.FixedTimeEquals(key, unwrapped), "Argon2id key-wrap JSON roundtrip");
    CryptographicOperations.ZeroMemory(unwrapped!);
    Check(await PasswordKeyWrap.UnwrapAsync("incorrect", restored, context) is null, "wrong password rejected");
    Check(await PasswordKeyWrap.UnwrapAsync("правильный длинный пароль", restored, "946cdf325c014d898fdc4d6779bde3fd:User") is null, "account wrapper substitution rejected");
    await Throws<CryptographicException>(() => PasswordKeyWrap.UnwrapAsync("password", restored with { MemoryKiB = int.MaxValue }, context), "untrusted KDF allocation bounded");
    Console.WriteLine($"PASS: {passed} crypto checks.");
}
finally
{
    CryptographicOperations.ZeroMemory(key);
}

void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    passed++;
    Console.WriteLine("PASS: " + name);
}

async Task Throws<T>(Func<Task> action, string name) where T : Exception
{
    try { await action(); }
    catch (T) { passed++; Console.WriteLine("PASS: " + name); return; }
    throw new Exception("FAIL: " + name);
}

sealed class FaultingSource(byte[] source, long failAfter) : Stream
{
    private long position;
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => position; set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count)
    {
        if (position >= failAfter) throw new IOException("Injected source failure.");
        var take = (int)Math.Min(count, Math.Min(failAfter - position, source.Length - position));
        source.AsSpan((int)position, take).CopyTo(buffer.AsSpan(offset));
        position += take;
        return take;
    }
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (position >= failAfter) throw new IOException("Injected source failure.");
        var take = (int)Math.Min(buffer.Length, Math.Min(failAfter - position, source.Length - position));
        source.AsSpan((int)position, take).CopyTo(buffer.Span);
        position += take;
        return ValueTask.FromResult(take);
    }
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

sealed class CancelAfterWriteStream(CancellationTokenSource cancellation) : MemoryStream
{
    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        await base.WriteAsync(buffer, cancellationToken);
        cancellation.Cancel();
    }
}
