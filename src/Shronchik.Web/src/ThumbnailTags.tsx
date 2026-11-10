import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tagLabel } from './tags';
import './thumbnail-tags.css';

export function ThumbnailTags({ tags }: { tags: readonly string[] }) {
  const row = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const labels = useMemo(() => [...new Set(tags.map(tagLabel))].filter(Boolean), [tags]);
  const [visible, setVisible] = useState<Set<number>>(() => new Set());

  useLayoutEffect(() => {
    const viewport = row.current;
    const chips = track.current;
    if (!viewport || !chips) return;

    const fit = () => {
      const available = Number.parseFloat(getComputedStyle(viewport).width);
      const gap = Number.parseFloat(getComputedStyle(chips).columnGap) || 0;
      const next = new Set<number>();
      let used = 0;
      Array.from(chips.children).forEach((chip, index) => {
        const width = Number.parseFloat(getComputedStyle(chip).width) + (next.size ? gap : 0);
        if (used + width <= available) {
          next.add(index);
          used += width;
        }
      });
      setVisible(previous => previous.size === next.size && [...next].every(index => previous.has(index)) ? previous : next);
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    observer.observe(chips);
    return () => observer.disconnect();
  }, [labels]);

  if (!labels.length) return null;
  return <span className="thumbnail-tags" ref={row}>
    <span className="thumbnail-tags-track" ref={track}>
      {labels.map((label, index) => <span className="thumbnail-tag" key={label}
        data-overflow={visible.has(index) ? undefined : ''}>#{label}</span>)}
    </span>
  </span>;
}
