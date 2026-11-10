namespace Shronchik.Server.Media;

public static class MediaInput
{
    public static (string Type, string Mime) Identify(ReadOnlySpan<byte> bytes, string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        if (bytes.StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) && ext == ".png") return ("photo", "image/png");
        if (bytes.StartsWith(new byte[] { 255, 216, 255 }) && ext is ".jpg" or ".jpeg") return ("photo", "image/jpeg");
        if ((bytes.StartsWith("GIF87a"u8) || bytes.StartsWith("GIF89a"u8)) && ext == ".gif") return ("gif", "image/gif");
        if (bytes.Length >= 12 && bytes[..4].SequenceEqual("RIFF"u8) && bytes.Slice(8, 4).SequenceEqual("WEBP"u8) && ext == ".webp") return ("photo", "image/webp");
        if (bytes.Length >= 12 && bytes.Slice(4, 4).SequenceEqual("ftyp"u8) && ext is ".mp4" or ".m4v" or ".mov") return ("video", ext == ".mov" ? "video/quicktime" : "video/mp4");
        if (bytes.StartsWith(new byte[] { 26, 69, 223, 163 }) && ext == ".webm") return ("video", "video/webm");
        throw new ArgumentException("Unsupported media signature.");
    }

    public static (long Offset, long Count, bool Partial)? Range(string? value, long length)
    {
        if (string.IsNullOrEmpty(value)) return (0, length, false);
        if (!value.StartsWith("bytes=", StringComparison.Ordinal) || value.Contains(',')) return null;
        var parts = value[6..].Split('-');
        if (parts.Length != 2 || length == 0) return null;
        if (parts[0].Length == 0)
        {
            if (!long.TryParse(parts[1], out var suffix) || suffix <= 0) return null;
            var count = Math.Min(suffix, length);
            return (length - count, count, true);
        }
        if (!long.TryParse(parts[0], out var start) || start < 0 || start >= length) return null;
        var end = length - 1;
        if (parts[1].Length > 0 && (!long.TryParse(parts[1], out end) || end < start)) return null;
        end = Math.Min(end, length - 1);
        return (start, end - start + 1, true);
    }
}

/// <summary>Replays a small RAM-only signature prefix before the unbuffered request stream.</summary>
public sealed class PrefixStream(byte[] prefix, Stream source) : Stream
{
    private int position;
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        if (position < prefix.Length)
        {
            var count = Math.Min(buffer.Length, prefix.Length - position);
            prefix.AsMemory(position, count).CopyTo(buffer);
            position += count;
            return count;
        }
        return await source.ReadAsync(buffer, ct);
    }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
