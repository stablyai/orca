import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

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

export function consumeNativeChatSplitShortcut(
  event: KeybindingInput & {
    repeat: boolean
    preventDefault: () => void
    stopPropagation: () => void
  },
  keybindings: KeybindingOverrides,
  actions: { onSplitRight: () => void; onSplitDown: () => void } | undefined
): boolean {
  if (event.repeat || !actions) {
    return false
  }
  const direction = matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
  if (!direction) {
    return false
  }
  event.preventDefault()
  event.stopPropagation()
  if (direction === 'right') {
    actions.onSplitRight()
  } else {
    actions.onSplitDown()
  }
  return true
}
