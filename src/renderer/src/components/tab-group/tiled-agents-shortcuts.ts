import {
  keybindingMatchesAction,
  matchKeybindingDigitIndex,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

export type TiledAgentsShortcut = { type: 'focusPane'; index: number } | { type: 'toggleMaximize' }

/** Zero-based `index`: pane N in the UI is `index + 1` (see matchKeybindingDigitIndex). */
export function matchTiledAgentsShortcut(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): TiledAgentsShortcut | null {
  const index = matchKeybindingDigitIndex('tiling.focusPaneByIndex', input, platform, keybindings)
  if (index !== null) {
    return { type: 'focusPane', index }
  }
  if (keybindingMatchesAction('tiling.toggleMaximizePane', input, platform, keybindings)) {
    return { type: 'toggleMaximize' }
  }
  return null
}
