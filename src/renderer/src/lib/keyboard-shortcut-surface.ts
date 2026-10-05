import type { KeybindingContext } from '../../../shared/keybindings'
import { isEditableTarget } from './editable-target'

export function resolveKeyboardShortcutSurface(
  target: EventTarget | null
): KeybindingContext | 'blocked' {
  if (!(target instanceof HTMLElement)) {
    return 'app'
  }
  // xterm's helper textarea retains terminal shortcut policy.
  if (target.classList.contains('xterm-helper-textarea')) {
    return 'terminal'
  }
  if (!isEditableTarget(target)) {
    return 'app'
  }
  if (
    target instanceof HTMLInputElement &&
    (target.type === 'text' || target.type === 'search') &&
    target.getAttribute('data-keyboard-surface') === 'search-field'
  ) {
    return 'search-field'
  }
  return 'blocked'
}
