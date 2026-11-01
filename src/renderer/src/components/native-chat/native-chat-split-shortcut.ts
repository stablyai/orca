import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
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

export function dispatchNativeChatSplitShortcut(
  event: ReactKeyboardEvent,
  keybindings: Parameters<typeof matchNativeChatSplitShortcut>[2],
  contextMenuActions: { onSplitRight: () => void; onSplitDown: () => void } | undefined
): boolean {
  const splitDirection = event.repeat
    ? null
    : matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
  if (splitDirection && contextMenuActions) {
    event.preventDefault()
    event.stopPropagation()
    if (splitDirection === 'right') {
      contextMenuActions.onSplitRight()
    } else {
      contextMenuActions.onSplitDown()
    }
    return true
  }
  return false
}
