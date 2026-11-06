import { useCallback, useMemo, type KeyboardEventHandler, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
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
  matchNativeChatPaneShortcut,
  runNativeChatTerminalPaneShortcut
} from './native-chat-pane-shortcut'
import { runNativeChatSplitTarget } from './native-chat-layout-actions'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

export function useStructuredNativeChatPaneCommands({
  pane,
  handOff,
  ownerWorktreeId,
  rootRef,
  composerRef,
  questionAnswerInputRef,
  sessionContext,
  ...menuTargets
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  handOff: NativeChatHandOff
  sessionContext: { messages: readonly NativeChatMessage[]; epoch: string | null }
  ownerWorktreeId: string | null
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  questionAnswerInputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
} & NativeChatContextMenuTargetArgs) {
  const { tabId, groupId, isVisible, sessionId, target } = pane
  const terminalPaneActions = pane.contextMenuActions
  const keybindings = useAppStore((state) => state.keybindings)
  const focusSource = useCallback(() => composerRef.current?.focus(), [composerRef])
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
    splitShortcutLabels: {
      right: formatShortcutLabel('terminal.splitRight', keybindings),
      down: formatShortcutLabel('terminal.splitDown', keybindings)
    },
    chatSession:
      ownerWorktreeId && terminalPaneActions === undefined && isVisible
        ? {
            target,
            sessionId,
            worktreeId: ownerWorktreeId,
            agent: pane.agent,
            ...sessionContext,
            focusSource
          }
        : undefined,
    chatPane:
      ownerWorktreeId && groupId && terminalPaneActions === undefined
        ? { tabId, worktreeId: ownerWorktreeId, groupId, sessionId }
        : undefined
  })
  const onKeyDownCapture = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.repeat) {
        return
      }
      const shortcut = matchNativeChatPaneShortcut(event, getShortcutPlatform(), keybindings)
      if (!shortcut) {
        return
      }
      let handled = false
      if (terminalPaneActions) {
        handled = runNativeChatTerminalPaneShortcut(shortcut, terminalPaneActions)
      } else if (groupId && shortcut !== 'equalize') {
        // Tab groups have no equalize command; only terminal panes do.
        handled = runNativeChatSplitTarget(
          { kind: 'workspace-tab', unifiedTabId: tabId, groupId },
          shortcut
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
