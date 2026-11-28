import type { KeyboardEvent } from 'react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import {
  shortcutProducesText,
  textInputOwnsComposition,
  type TextShortcutInput
} from '../../../../../../shared/keybindings/text-input-shortcut-policy'
import type { KeybindingOverrides } from '../../../../../../shared/keybindings/types'
import type { NativeChatContextMenuActions } from '../actions/use-native-chat-context-menu'

export type NativeChatSplitDirection = 'right' | 'down'
export type NativeChatPaneShortcut = NativeChatSplitDirection | 'equalize'

type NativeChatTerminalPaneShortcutActions = Pick<
  NativeChatContextMenuActions,
  'onSplitRight' | 'onSplitDown' | 'canEqualizePaneSizes' | 'onEqualizePaneSizes'
>
export type NativeChatPaneShortcutInput = TextShortcutInput & {
  target?: EventTarget | null
  nativeEvent?: TextShortcutInput
}
type NativeChatPaneShortcutEvent = NativeChatPaneShortcutInput &
  Pick<KeyboardEvent, 'repeat' | 'preventDefault' | 'stopPropagation'>

export function matchNativeChatPaneShortcut(
  input: NativeChatPaneShortcutInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): NativeChatPaneShortcut | null {
  const compositionInput = input.nativeEvent ?? input
  if (
    textInputOwnsComposition(compositionInput) ||
    (shortcutProducesText(compositionInput, platform) && isEditableTarget(input.target ?? null))
  ) {
    return null
  }
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
