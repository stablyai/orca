import { keybindingMatchesInput } from './keybindings'
import type { WindowShortcutInput } from './window-shortcut-policy'

export const RECENT_TAB_SWITCHER_SCOPE_TOGGLE_KEYBINDING = 'Ctrl+A'

// Why: Control stays held for the whole switcher gesture, so the scope toggle shares it rather than taking a new chord.
// Shift must be up: on Linux and Windows, Ctrl+Shift+A selects all terminal text.
export function isRecentTabSwitcherScopeToggle(
  input: WindowShortcutInput,
  platform: NodeJS.Platform
): boolean {
  return keybindingMatchesInput(RECENT_TAB_SWITCHER_SCOPE_TOGGLE_KEYBINDING, input, platform)
}
