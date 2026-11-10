import dictionary from '../../../shared/tags.json';

export type BuiltInTagGroup = Readonly<{ id: string; ru: string; en: string }>;
export type BuiltInTag = Readonly<{
  id: string;
  label: string;
  group: string;
  aliases: readonly string[];
}>;

export const builtInTagGroups: readonly BuiltInTagGroup[] = dictionary.groups;
export const builtInTags: readonly BuiltInTag[] = dictionary.tags;

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toUpperCase();
}

function names(tag: BuiltInTag): readonly string[] {
  return [tag.id, tag.label, ...tag.aliases];
}

const byName = new Map<string, BuiltInTag>();
for (const tag of builtInTags) {
  for (const name of names(tag)) byName.set(normalize(name), tag);
}

export function canonicalTag(raw: string): string {
  return byName.get(normalize(raw))?.id ?? raw.trim();
}

export function isBuiltInTag(raw: string): boolean {
  return byName.has(normalize(raw));
}

export function tagLabel(tag: string | BuiltInTag): string {
  if (typeof tag !== 'string') return tag.label;
  return byName.get(normalize(tag))?.label ?? tag.trim();
}

export function tagMatchesQuery(tag: string | BuiltInTag, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  const value = normalize(typeof tag === 'string' ? tag : tag.id);
  const known = typeof tag === 'string' ? byName.get(value) : tag;
  return known ? names(known).some((name) => normalize(name).includes(needle)) : value.includes(needle);
}
