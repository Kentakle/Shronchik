import { useState } from 'react';
import './TagPicker.css';
import { builtInTags, builtInTagGroups, canonicalTag, isBuiltInTag, tagLabel, tagMatchesQuery } from './tags';
import type { Language } from './types';

export function TagPicker({ value, onChange, language, disabled }: {
  value: string; onChange: (value: string) => void; language: Language; disabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const selected = [...new Set(value.split(',').filter(isBuiltInTag).map(canonicalTag))];
  const matchingTags = builtInTags.filter(tag => tagMatchesQuery(tag, query));
  function toggle(id: string) {
    onChange((selected.includes(id) ? selected.filter(tag => tag !== id) : [...selected, id]).join(','));
  }
  return <fieldset className="tag-picker" disabled={disabled}>
    <legend>{language === 'ru' ? 'Теги' : 'Tags'}</legend>
    <div className="tag-picker-selected">{selected.map(id => <button type="button" key={id} onClick={() => toggle(id)} aria-label={`${language === 'ru' ? 'Убрать' : 'Remove'} ${tagLabel(id)}`}>{tagLabel(id)} ×</button>)}</div>
    <div className="tag-picker-search"><input type="search" aria-label={language === 'ru' ? 'Найти тег' : 'Find a tag'} value={query} onChange={event => setQuery(event.target.value)} placeholder={language === 'ru' ? 'Поиск тегов' : 'Search tags'} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}/></div>
    <div className="tag-picker-options">{builtInTagGroups.map(group => {
      const tags = matchingTags.filter(tag => tag.group === group.id);
      return tags.length ? <section key={group.id}><h4>{group[language]}</h4><div>{tags.map(tag => <button type="button" key={tag.id} aria-pressed={selected.includes(tag.id)} onClick={() => toggle(tag.id)}>{tagLabel(tag)}</button>)}</div></section> : null;
    })}{!matchingTags.length && <p className="help-text">{language === 'ru' ? 'Теги не найдены' : 'No matching tags'}</p>}</div>
  </fieldset>;
}
