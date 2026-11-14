import type { KeyboardEvent } from 'react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type {
  KeybindingInput,
  KeybindingOverrides
} from '../../../../../../shared/keybindings/types'
import type { NativeChatContextMenuActions } from '../actions/use-native-chat-context-menu'

export type NativeChatSplitDirection = 'right' | 'down'
type NativeChatPaneShortcut = NativeChatSplitDirection | 'equalize'

type NativeChatTerminalPaneShortcutActions = Pick<
  NativeChatContextMenuActions,
  'onSplitRight' | 'onSplitDown' | 'canEqualizePaneSizes' | 'onEqualizePaneSizes'
>
type NativeChatPaneShortcutEvent = KeybindingInput &
  Pick<KeyboardEvent, 'repeat' | 'preventDefault' | 'stopPropagation'>

export function matchNativeChatPaneShortcut(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): NativeChatPaneShortcut | null {
  if (keybindingMatchesAction('terminal.splitRight', input, platform, keybindings)) {
    return 'right'
  }
  if (keybindingMatchesAction('terminal.splitDown', input, platform, keybindings)) {
    return 'down'
  }
  if (keybindingMatchesAction('terminal.equalizePaneSizes', input, platform, keybindings)) {
    return 'equalize'
  }
  return null
}

export function runNativeChatTerminalPaneShortcut(
  shortcut: NativeChatPaneShortcut,
  actions: NativeChatTerminalPaneShortcutActions
): boolean {
  if (shortcut === 'right') {
    actions.onSplitRight()
  } else if (shortcut === 'down') {
    actions.onSplitDown()
  } else if (actions.canEqualizePaneSizes) {
    actions.onEqualizePaneSizes()
  } else {
    // A lone or expanded pane can't equalize, so leave the key for the composer.
    return false
  }
  return true
}

export function handleNativeChatPaneShortcut(
  event: NativeChatPaneShortcutEvent,
  keybindings: KeybindingOverrides,
  actions?: NativeChatTerminalPaneShortcutActions
): boolean {
  const shortcut = event.repeat
    ? null
    : matchNativeChatPaneShortcut(event, getShortcutPlatform(), keybindings)
  if (!shortcut || !actions || !runNativeChatTerminalPaneShortcut(shortcut, actions)) {
    return false
  }
  event.preventDefault()
  event.stopPropagation()
  return true
}
