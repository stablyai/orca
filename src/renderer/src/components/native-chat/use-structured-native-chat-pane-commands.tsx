import { useCallback, useMemo, type KeyboardEventHandler, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isOrcaSessionId } from '../../../../shared/orca-session-address'
import { resolveStructuredSessionOrcaSessionId } from '../../runtime/structured-session-orca-session-id'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { NativeChatHandOff } from './use-native-chat-hand-off'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu,
  type NativeChatContextMenuTargetArgs
} from './use-native-chat-context-menu'
import {
  matchNativeChatSplitShortcut,
  nativeChatSplitShortcutLabels
} from './native-chat-split-shortcut'
import { runNativeChatSplitTarget } from './native-chat-layout-actions'

export function useStructuredNativeChatPaneCommands({
  pane,
  handOff,
  ownerWorktreeId,
  rootRef,
  composerRef,
  questionAnswerInputRef,
  ...menuTargets
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  handOff: NativeChatHandOff
  ownerWorktreeId: string | null
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  questionAnswerInputRef: RefObject<HTMLInputElement | null>
} & NativeChatContextMenuTargetArgs) {
  const { tabId, groupId, isVisible, sessionId, target } = pane
  const terminalPaneActions = pane.contextMenuActions
  const keybindings = useAppStore((state) => state.keybindings)
  const resolveOrcaSessionId = useMemo(
    () =>
      isOrcaSessionId(sessionId)
        ? () => resolveStructuredSessionOrcaSessionId(target, sessionId)
        : undefined,
    [sessionId, target]
  )
  const pasteClipboardIntoComposer = useNativeChatPasteBridge({
    rootRef,
    composerRef,
    questionAnswerInputRef
  })
  const contextMenu = useNativeChatContextMenu({
    ...menuTargets,
    // A chat in a terminal pane already hands off through that pane's own menu row.
    handOffDisabled: handOff.preparing || handOff.dialog !== null,
    onHandOff: terminalPaneActions === undefined && handOff.available ? handOff.open : undefined,
    rootRef,
    actions: {
      ...emptyNativeChatContextMenuActions,
      ...terminalPaneActions,
      onPaste: pasteClipboardIntoComposer
    },
    enabled: isVisible,
    resolveOrcaSessionId,
    composerRef,
    showTerminalPaneActions: terminalPaneActions !== undefined,
    splitShortcutLabels: nativeChatSplitShortcutLabels(getShortcutPlatform(), keybindings),
    chatPane:
      ownerWorktreeId && groupId && terminalPaneActions === undefined
        ? { tabId, worktreeId: ownerWorktreeId, groupId }
        : undefined
  })
  const onKeyDownCapture = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.repeat) {
        return
      }
      const split = matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
      if (!split) {
        return
      }
      let handled = false
      if (terminalPaneActions) {
        if (split.direction === 'right') {
          terminalPaneActions.onSplitRight()
        } else {
          terminalPaneActions.onSplitDown()
        }
        handled = true
      } else if (groupId) {
        handled = runNativeChatSplitTarget(
          { kind: 'workspace-tab', unifiedTabId: tabId, groupId },
          split.direction,
          split.opensTerminal
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

  return {
    ...contextMenu,
    onKeyDownCapture
  }
}
