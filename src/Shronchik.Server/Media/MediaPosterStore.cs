using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using Shronchik.Core.Crypto;

namespace Shronchik.Server.Media;

internal sealed class MediaPosterStore(string libraryRoot, VaultCipher cipher)
{
    public const int MaxBytes = 4 * 1024 * 1024;
    private const int MaxEdge = 4096;
    private static ReadOnlySpan<byte> PngSignature => [137, 80, 78, 71, 13, 10, 26, 10];
    // The lock spans both vault opens in ReadAsync and the final replacement.
    private readonly SemaphoreSlim fileGate = new(1, 1);

    private string PathFor(Guid mediaId) => Path.Combine(libraryRoot, "vault", "posters", mediaId.ToString("N") + ".srm");

    public string? Version(Guid mediaId)
    {
        var file = new FileInfo(PathFor(mediaId));
        return file.Exists ? FormatVersion(file.LastWriteTimeUtc) : null;
    }

    public async Task<string> WriteAsync(Guid mediaId, byte[] bytes, byte[] key, CancellationToken ct,
        bool overwrite = true)
    {
        var final = PathFor(mediaId);
        var directory = Path.GetDirectoryName(final)!;
        Directory.CreateDirectory(directory);
        var staging = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".partial");
        try
        {
            using var source = new MemoryStream(bytes, writable: false);
            await cipher.EncryptAsync(source, staging, key, ObjectId(mediaId), ct);
            await fileGate.WaitAsync(ct);
            try
            {
                ct.ThrowIfCancellationRequested();
                if (!overwrite && File.Exists(final)) throw new PosterAlreadyExistsException();
                var previous = File.GetLastWriteTimeUtc(final);
                // Set the timestamp before publishing so even rapid replacements get a new version.
                var now = DateTime.UtcNow;
                File.SetLastWriteTimeUtc(staging, now > previous ? now : previous.AddSeconds(2));
                File.Move(staging, final, overwrite);
                return FormatVersion(File.GetLastWriteTimeUtc(final));
            }
            finally { fileGate.Release(); }
        }
        finally
        {
            if (File.Exists(staging)) File.Delete(staging);
        }
    }

    public async Task<byte[]?> ReadAsync(Guid mediaId, byte[] key, CancellationToken ct)
    {
        await fileGate.WaitAsync(ct);
        try
        {
            var path = PathFor(mediaId);
            if (!File.Exists(path)) return null;
            var objectId = ObjectId(mediaId);
            var length = await cipher.GetLengthAsync(path, key, objectId, ct);
            if (length is <= 0 or > MaxBytes) throw new InvalidDataException("Invalid poster length.");
            var bytes = new byte[(int)length];
            try
            {
                using var buffer = new MemoryStream(bytes, writable: true);
                await cipher.CopyRangeAsync(path, buffer, key, objectId, 0, length, ct);
                return bytes;
            }
            catch
            {
                CryptographicOperations.ZeroMemory(bytes);
                throw;
            }
        }
        finally { fileGate.Release(); }
    }

    public static string? MimeType(ReadOnlySpan<byte> bytes)
    {
        if (bytes.StartsWith(PngSignature)) return "image/png";
        if (bytes.Length >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) return "image/jpeg";
        return null;
    }

    public static bool IsSupportedImage(ReadOnlySpan<byte> bytes, string? contentType)
    {
        var mime = MimeType(bytes);
        if (mime is null || !string.Equals(mime, contentType, StringComparison.OrdinalIgnoreCase)) return false;
        return mime == "image/png" ? PngDimensionsAreSafe(bytes) : JpegDimensionsAreSafe(bytes);
    }

    private static bool PngDimensionsAreSafe(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 45 && bytes.Slice(8, 8).SequenceEqual("\0\0\0\rIHDR"u8)
        && bytes.Slice(bytes.Length - 8, 4).SequenceEqual("IEND"u8)
        && IsSafeSize(BinaryPrimitives.ReadUInt32BigEndian(bytes[16..20]),
            BinaryPrimitives.ReadUInt32BigEndian(bytes[20..24]));

    private static bool JpegDimensionsAreSafe(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 10 || bytes[^2] != 0xff || bytes[^1] != 0xd9) return false;
        var offset = 2;
        while (offset < bytes.Length && bytes[offset++] == 0xff)
        {
            while (offset < bytes.Length && bytes[offset] == 0xff) offset++;
            if (bytes.Length - offset < 3) return false;
            var marker = bytes[offset++];
            if (marker is 0xda or 0xd9) return false;
            var segmentLength = BinaryPrimitives.ReadUInt16BigEndian(bytes[offset..]);
            if (segmentLength < 2 || segmentLength > bytes.Length - offset) return false;
            // SOF markers contain height and width before compressed scan data.
            if (marker is 0xc0 or 0xc1 or 0xc2 or 0xc3 or 0xc5 or 0xc6 or 0xc7
                or 0xc9 or 0xca or 0xcb or 0xcd or 0xce or 0xcf)
                return segmentLength >= 8 && IsSafeSize(
                    BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 5)..]),
                    BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 3)..]));
            offset += segmentLength;
        }
        return false;
    }

    private static bool IsSafeSize(uint width, uint height) => width is > 0 and <= MaxEdge && height is > 0 and <= MaxEdge;

    private static Guid ObjectId(Guid mediaId)
    {
        ReadOnlySpan<byte> label = "Shronchik/poster/v1"u8;
        Span<byte> input = stackalloc byte[label.Length + 16];
        label.CopyTo(input);
        mediaId.TryWriteBytes(input[label.Length..]);
        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(input, digest);
        return new Guid(digest[..16]);
    }

    private static string FormatVersion(DateTime time) => time.Ticks.ToString(CultureInfo.InvariantCulture);
}

internal sealed class PosterAlreadyExistsException : Exception { }
