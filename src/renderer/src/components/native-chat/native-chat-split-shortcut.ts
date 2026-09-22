import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

export type NativeChatSplitDirection = 'right' | 'down'

export function matchNativeChatSplitShortcut(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): NativeChatSplitDirection | null {
  if (keybindingMatchesAction('terminal.splitRight', input, platform, keybindings)) {
    return 'right'
  }
  if (keybindingMatchesAction('terminal.splitDown', input, platform, keybindings)) {
    return 'down'
  }
  return null
}
