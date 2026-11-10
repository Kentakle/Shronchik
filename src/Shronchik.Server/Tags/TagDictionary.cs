using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Shronchik.Server.Tags;

public sealed class TagDictionary
{
    private static readonly Regex StableId = new(@"\A[a-z0-9]+(?:-[a-z0-9]+)*\z", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
        AllowDuplicateProperties = false
    };
    private readonly Dictionary<string, Entry> byName = new(StringComparer.Ordinal);

    public int Version { get; }
    public IReadOnlyList<string> AllIds { get; }

    private TagDictionary(Source source)
    {
        if (source.Version != 2 || source.Groups.Length == 0 || source.Tags.Length == 0)
            throw new InvalidDataException("Unsupported or empty tag dictionary.");

        var groupIds = new HashSet<string>(StringComparer.Ordinal);
        var groupNames = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in source.Groups)
        {
            if (group is null || !IsId(group.Id) || !groupIds.Add(group.Id))
                throw new InvalidDataException("Invalid or duplicate tag group ID.");
            RegisterGroupName(groupNames, group.Ru, group.Id);
            RegisterGroupName(groupNames, group.En, group.Id);
        }

        var tagIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tag in source.Tags)
        {
            if (tag is null || !IsId(tag.Id) || !tagIds.Add(tag.Id) || !groupIds.Contains(tag.Group))
                throw new InvalidDataException("Invalid or duplicate tag ID or unknown group.");

            foreach (var name in Names(tag))
            {
                ValidateName(name);
                var normalized = Normalize(name);
                if (!byName.TryAdd(normalized, tag) && byName[normalized].Id != tag.Id)
                    throw new InvalidDataException($"Tag name or alias '{name}' identifies more than one tag.");
            }
        }

        Version = source.Version;
        AllIds = Array.AsReadOnly(source.Tags.Select(tag => tag.Id).ToArray());
    }

    public static TagDictionary Load(string path)
    {
        using var stream = File.OpenRead(path);
        try
        {
            var source = JsonSerializer.Deserialize<Source>(stream, Json)
                ?? throw new InvalidDataException("Empty tag dictionary.");
            return new TagDictionary(source);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("Invalid tag dictionary JSON.", ex);
        }
    }

    public string Canonicalize(string raw) => Find(raw)?.Id ?? raw.Trim();

    public bool TryCanonicalize(string raw, out string id)
    {
        var tag = Find(raw);
        id = tag?.Id ?? "";
        return tag is not null;
    }

    public string Label(string id, string language) => Find(id)?.Label ?? id.Trim();

    /// <summary>Names that may already identify this tag in a catalogue, including before IDs were introduced.</summary>
    public IEnumerable<string> ExpandAliases(string raw)
    {
        var tag = Find(raw);
        return tag is null ? [raw.Trim()] : Names(tag).Append(raw.Trim()).Distinct(StringComparer.Ordinal);
    }

    private Entry? Find(string raw) => byName.GetValueOrDefault(Normalize(raw));

    private static IEnumerable<string> Names(Entry tag) => new[] { tag.Id, tag.Label }.Concat(tag.Aliases);

    private static void RegisterGroupName(Dictionary<string, string> names, string name, string id)
    {
        ValidateName(name);
        var normalized = Normalize(name);
        if (!names.TryAdd(normalized, id) && names[normalized] != id)
            throw new InvalidDataException($"Tag group name '{name}' identifies more than one group.");
    }

    private static void ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 64 || name != name.Trim()
            || name.Any(char.IsControl) || name.Contains(','))
            throw new InvalidDataException("Invalid tag label or alias.");
    }

    private static bool IsId(string value) => value.Length <= 48 && StableId.IsMatch(value);

    private static string Normalize(string value) => value.Trim().Normalize(NormalizationForm.FormKC).ToUpperInvariant();

    private sealed record Source(int Version, Group[] Groups, Entry[] Tags);
    private sealed record Group(string Id, string Ru, string En);
    private sealed record Entry(string Id, string Label, string Group, string[] Aliases);
}
