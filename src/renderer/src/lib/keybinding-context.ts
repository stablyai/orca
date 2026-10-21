import type { KeybindingContext } from '../../../shared/keybindings'

/** Marker the Monaco file editor sets while an editor-first keymap (the Emacs preset) is attached. */
export const EDITOR_KEYMAP_ATTRIBUTE = 'data-orca-editor-keymap'

/**
 * Resolves which surface owns a key event: xterm's helper textarea is the terminal, an editor
 * running an editor-first keymap is the editor, everything else is the app shell.
 */
export function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  // Why: the key handlers that ask also run under node-environment tests, where no DOM globals exist.
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
