import type { KeybindingContext } from '../../../shared/keybindings'

/** Marker the Monaco file editor sets while an editor-first keymap (the Emacs preset) is attached. */
export const EDITOR_KEYMAP_ATTRIBUTE = 'data-orca-editor-keymap'

export function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  // Callers also run in node-environment tests without DOM globals.
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return 'app'
  }
  if (target.classList.contains('xterm-helper-textarea')) {
    return 'terminal'
  }
  if (target.closest(`[${EDITOR_KEYMAP_ATTRIBUTE}]`) !== null) {
    return 'editor'
  }
  return 'app'
}
