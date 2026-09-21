import { useCallback, type KeyboardEventHandler, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu,
  type NativeChatContextMenuActions
} from './use-native-chat-context-menu'
import { matchNativeChatSplitShortcut } from './native-chat-split-shortcut'
import { runNativeChatSplitTarget } from './native-chat-layout-actions'

export function useStructuredNativeChatPaneCommands({
  tabId,
  groupId,
  isVisible,
  rootRef,
  composerRef,
  terminalPaneActions
}: {
  tabId: string
  groupId?: string
  isVisible: boolean
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  terminalPaneActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}) {
  const keybindings = useAppStore((state) => state.keybindings)
  const pasteClipboardIntoComposer = useNativeChatPasteBridge({ rootRef, composerRef })
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    actions: {
      ...emptyNativeChatContextMenuActions,
      ...terminalPaneActions,
      onPaste: pasteClipboardIntoComposer
    },
    enabled: isVisible,
    showTerminalPaneActions: terminalPaneActions !== undefined,
    splitShortcutLabels: {
      right: formatShortcutLabel('terminal.splitRight', keybindings),
      down: formatShortcutLabel('terminal.splitDown', keybindings)
    },
    workspaceLayout:
      groupId && terminalPaneActions === undefined
        ? {
            unifiedTabId: tabId,
            groupId,
            shortcutLabels: {
              right: formatShortcutLabel('terminal.splitRight', keybindings),
              down: formatShortcutLabel('terminal.splitDown', keybindings)
            }
          }
        : undefined
  })
  const onKeyDownCapture = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.repeat) {
        return
      }
      const direction = matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
      if (!direction) {
        return
      }
      let handled = false
      if (terminalPaneActions) {
        if (direction === 'right') {
          terminalPaneActions.onSplitRight()
        } else {
          terminalPaneActions.onSplitDown()
        }
        handled = true
      } else if (groupId) {
        handled = runNativeChatSplitTarget(
          { kind: 'workspace-tab', unifiedTabId: tabId, groupId },
          direction
        )
      }
      if (!handled) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [groupId, keybindings, tabId, terminalPaneActions]
  )

  return { ...contextMenu, onKeyDownCapture }
}
