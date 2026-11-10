using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Shronchik.Core.Crypto;

public sealed record EncryptedFileInfo(long Length, string Sha256);

/// <summary>
/// SRM1 v1: a 128-byte authenticated header followed by independently authenticated
/// 1 MiB ciphertext blocks, each followed by a 16-byte GCM tag. No plaintext files
/// or unverified plaintext blocks are exposed by this class.
/// </summary>
public sealed class VaultCipher
{
    public const int ChunkSize = 1024 * 1024;
    public const int HeaderSize = 128;
    private const int TagSize = 16;
    private const int HeaderTagOffset = 108;
    private const int Version = 1;

    public async Task<EncryptedFileInfo> EncryptAsync(Stream source, string targetPath,
        byte[] masterKey, Guid objectId, CancellationToken ct = default)
    {
        ValidateKey(masterKey);
        ArgumentNullException.ThrowIfNull(source);
        if (!source.CanRead) throw new ArgumentException("Source must be readable.", nameof(source));
        var fileKey = RandomNumberGenerator.GetBytes(32);
        var header = new byte[HeaderSize];
        var plain = ArrayPool<byte>.Shared.Rent(ChunkSize);
        var cipher = ArrayPool<byte>.Shared.Rent(ChunkSize);
        var created = false;
        try
        {
            "SRM1"u8.CopyTo(header);
            BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(4), Version);
            objectId.TryWriteBytes(header.AsSpan(8, 16));
            BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(24), ChunkSize);
            RandomNumberGenerator.Fill(header.AsSpan(28, 4));
            RandomNumberGenerator.Fill(header.AsSpan(48, 12));
            using (var wrapping = new AesGcm(masterKey, TagSize))
                wrapping.Encrypt(header.AsSpan(48, 12), fileKey, header.AsSpan(60, 32),
                    header.AsSpan(92, TagSize), header.AsSpan(0, 32));

            await using var output = new FileStream(targetPath, FileMode.CreateNew,
                FileAccess.ReadWrite, FileShare.None, 64 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            created = true;
            // An interrupted write has no usable header and is never a valid object.
            await output.WriteAsync(new byte[HeaderSize], ct);
            using var aes = new AesGcm(fileKey, TagSize);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long length = 0;
            long index = 0;
            var tag = new byte[TagSize];
            var nonce = new byte[12];
            while (true)
            {
                var read = 0;
                while (read < ChunkSize)
                {
                    var received = await source.ReadAsync(plain.AsMemory(read, ChunkSize - read), ct);
                    if (received == 0) break;
                    read += received;
                }
                if (read == 0) break;
                ct.ThrowIfCancellationRequested();
                MakeNonce(header, (ulong)index, nonce);
                var aad = MakeBlockAad(header, index, read);
                aes.Encrypt(nonce, plain.AsSpan(0, read), cipher.AsSpan(0, read), tag, aad);
                hash.AppendData(plain.AsSpan(0, read));
                await output.WriteAsync(cipher.AsMemory(0, read), ct);
                await output.WriteAsync(tag, ct);
                CryptographicOperations.ZeroMemory(plain.AsSpan(0, read));
                length = checked(length + read);
                index = checked(index + 1);
            }

            BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(32), length);
            BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(40), index);
            MakeNonce(header, ulong.MaxValue, nonce);
            aes.Encrypt(nonce, ReadOnlySpan<byte>.Empty, Span<byte>.Empty,
                header.AsSpan(HeaderTagOffset, TagSize), MakeHeaderAad(header));
            output.Position = 0;
            await output.WriteAsync(header, ct);
            await output.FlushAsync(ct);
            output.Flush(flushToDisk: true);
            return new(length, Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
        }
        catch
        {
            // Only a file this invocation created may be removed.
            if (created)
            {
                try { File.Delete(targetPath); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(fileKey);
            CryptographicOperations.ZeroMemory(plain);
            CryptographicOperations.ZeroMemory(cipher);
            ArrayPool<byte>.Shared.Return(plain);
            ArrayPool<byte>.Shared.Return(cipher);
        }
    }

    public async Task<long> GetLengthAsync(string path, byte[] masterKey, Guid objectId,
        CancellationToken ct = default)
    {
        ValidateKey(masterKey);
        await using var input = OpenRead(path);
        using var header = await ReadHeaderAsync(input, masterKey, objectId, ct);
        return header.Length;
    }

    public async Task CopyRangeAsync(string path, Stream destination, byte[] masterKey,
        Guid objectId, long offset, long count, CancellationToken ct = default)
    {
        ValidateKey(masterKey);
        ArgumentNullException.ThrowIfNull(destination);
        if (!destination.CanWrite)
            throw new ArgumentException("Destination must be writable.", nameof(destination));
        await using var input = OpenRead(path);
        using var header = await ReadHeaderAsync(input, masterKey, objectId, ct);
        if (offset < 0 || count < 0 || offset > header.Length || count > header.Length - offset)
            throw new ArgumentOutOfRangeException(nameof(offset), "Range lies outside the object.");
        if (count == 0) return;

        var plain = ArrayPool<byte>.Shared.Rent(ChunkSize);
        var cipher = ArrayPool<byte>.Shared.Rent(ChunkSize);
        try
        {
            using var aes = new AesGcm(header.Key, TagSize);
            var nonce = new byte[12];
            var tag = new byte[TagSize];
            var index = offset / ChunkSize;
            var withinBlock = (int)(offset % ChunkSize);
            var remaining = count;
            while (remaining > 0)
            {
                ct.ThrowIfCancellationRequested();
                var blockLength = (int)Math.Min(ChunkSize, header.Length - checked(index * ChunkSize));
                input.Position = checked(HeaderSize + index * (ChunkSize + (long)TagSize));
                await ReadExactlyAsync(input, cipher.AsMemory(0, blockLength), ct);
                await ReadExactlyAsync(input, tag, ct);
                MakeNonce(header.Bytes, (ulong)index, nonce);
                aes.Decrypt(nonce, cipher.AsSpan(0, blockLength), tag,
                    plain.AsSpan(0, blockLength), MakeBlockAad(header.Bytes, index, blockLength));
                // Only authenticated bytes enter the caller's stream.
                ct.ThrowIfCancellationRequested();
                var take = (int)Math.Min(remaining, blockLength - withinBlock);
                await destination.WriteAsync(plain.AsMemory(withinBlock, take), ct);
                CryptographicOperations.ZeroMemory(plain.AsSpan(0, blockLength));
                remaining -= take;
                withinBlock = 0;
                index++;
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
            CryptographicOperations.ZeroMemory(cipher);
            ArrayPool<byte>.Shared.Return(plain);
            ArrayPool<byte>.Shared.Return(cipher);
        }
    }

    private static FileStream OpenRead(string path) => new(path, FileMode.Open, FileAccess.Read,
        FileShare.Read, 64 * 1024, FileOptions.Asynchronous | FileOptions.RandomAccess);

    private static async Task<Header> ReadHeaderAsync(FileStream input, byte[] masterKey,
        Guid objectId, CancellationToken ct)
    {
        var bytes = new byte[HeaderSize];
        await ReadExactlyAsync(input, bytes, ct);
        if (!bytes.AsSpan(0, 4).SequenceEqual("SRM1"u8)
            || BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(4)) != Version
            || new Guid(bytes.AsSpan(8, 16)) != objectId
            || BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(24)) != ChunkSize
            || !bytes.AsSpan(124, 4).SequenceEqual(new byte[4]))
            throw Corrupt();

        var key = new byte[32];
        try
        {
            using (var wrapping = new AesGcm(masterKey, TagSize))
                wrapping.Decrypt(bytes.AsSpan(48, 12), bytes.AsSpan(60, 32),
                    bytes.AsSpan(92, TagSize), key, bytes.AsSpan(0, 32));
            var nonce = new byte[12];
            MakeNonce(bytes, ulong.MaxValue, nonce);
            using (var aes = new AesGcm(key, TagSize))
                aes.Decrypt(nonce, ReadOnlySpan<byte>.Empty, bytes.AsSpan(HeaderTagOffset, TagSize),
                    Span<byte>.Empty, MakeHeaderAad(bytes));

            var length = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(32));
            var count = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(40));
            if (length < 0 || count < 0) throw Corrupt();
            var expectedCount = length / ChunkSize + (length % ChunkSize == 0 ? 0 : 1);
            if (count != expectedCount || input.Length != checked(HeaderSize + length + count * TagSize))
                throw Corrupt();
            return new Header(bytes, key, length);
        }
        catch (OverflowException)
        {
            CryptographicOperations.ZeroMemory(key);
            throw Corrupt();
        }
        catch
        {
            CryptographicOperations.ZeroMemory(key);
            throw;
        }
    }

    private static byte[] MakeHeaderAad(byte[] header)
    {
        var aad = new byte[112];
        header.AsSpan(0, HeaderTagOffset).CopyTo(aad);
        header.AsSpan(124, 4).CopyTo(aad.AsSpan(HeaderTagOffset));
        return aad;
    }

    private static byte[] MakeBlockAad(byte[] header, long index, int length)
    {
        var aad = new byte[44];
        header.AsSpan(0, 32).CopyTo(aad);
        BinaryPrimitives.WriteInt64LittleEndian(aad.AsSpan(32), index);
        BinaryPrimitives.WriteInt32LittleEndian(aad.AsSpan(40), length);
        return aad;
    }

    private static void MakeNonce(byte[] header, ulong index, byte[] destination)
    {
        header.AsSpan(28, 4).CopyTo(destination);
        BinaryPrimitives.WriteUInt64BigEndian(destination.AsSpan(4), index);
    }

    private static async Task ReadExactlyAsync(Stream source, Memory<byte> buffer, CancellationToken ct)
    {
        try { await source.ReadExactlyAsync(buffer, ct); }
        catch (EndOfStreamException ex) { throw new CryptographicException("Truncated encrypted object.", ex); }
    }

    private static void ValidateKey(byte[] key)
    {
        ArgumentNullException.ThrowIfNull(key);
        if (key.Length != 32) throw new ArgumentException("A 256-bit master key is required.", nameof(key));
    }

    private static CryptographicException Corrupt() => new("Invalid encrypted object header or length.");

    private sealed class Header(byte[] bytes, byte[] key, long length) : IDisposable
    {
        public byte[] Bytes { get; } = bytes;
        public byte[] Key { get; } = key;
        public long Length { get; } = length;
        public void Dispose() => CryptographicOperations.ZeroMemory(Key);
    }
}
