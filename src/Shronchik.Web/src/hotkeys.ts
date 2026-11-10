import { keyboardShortcut } from './settingsDefinitions';

export function isTypingTarget(target: EventTarget | null, allowInPlayer = false) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('input, textarea, select')) return true;
  const dialog = target.closest('dialog, [role="dialog"]');
  return Boolean(dialog && (!allowInPlayer || !dialog.classList.contains('player-overlay')));
}

export function matchesHotkey(event: KeyboardEvent, binding: string) {
  return Boolean(binding) && keyboardShortcut(event) === binding;
}
