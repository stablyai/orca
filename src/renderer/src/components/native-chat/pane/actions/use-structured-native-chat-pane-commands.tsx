import { useCallback, useMemo } from 'react'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import { resolveStructuredSessionOrcaSessionId } from '../../../../runtime/native-chat/orchestration/structured-session-orca-session-id'
import type { NativeChatStructuredViewProps } from '../../native-chat-view-types'
import type { NativeChatHandOff } from './use-native-chat-hand-off'
import {
  runNativeChatTerminalPaneShortcut,
  type NativeChatPaneShortcut
} from '../routing/native-chat-pane-shortcut'
import type { NativeChatSurfaceMenu } from '../../use-native-chat-surface'
import { runNativeChatSplitTarget } from '../routing/native-chat-layout-actions'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'

/** A structured chat's own menu rows and split target, for its chat surface. */
export function useStructuredNativeChatPaneCommands({
  pane,
  handOff,
  ownerWorktreeId,
  composerRef,
  sessionContext,
  rewind
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  handOff: NativeChatHandOff
  sessionContext: { messages: readonly NativeChatMessage[]; epoch: string | null }
  ownerWorktreeId: string | null
  composerRef: React.RefObject<NativeChatComposerHandle | null>
  rewind?: NativeChatSurfaceMenu['rewind']
}): { menu: NativeChatSurfaceMenu; onSplit: (shortcut: NativeChatPaneShortcut) => boolean } {
  const { tabId, groupId, isVisible, sessionId, target } = pane
  const terminalPaneActions = pane.contextMenuActions
  const focusSource = useCallback(() => composerRef.current?.focus(), [composerRef])
  const resolveOrcaSessionId = useMemo(
    () =>
      isOrcaSessionId(sessionId)
        ? () => resolveStructuredSessionOrcaSessionId(target, sessionId)
        : undefined,
    [sessionId, target]
  )
  const onSplit = useCallback(
    (shortcut: NativeChatPaneShortcut) => {
      if (terminalPaneActions) {
        return runNativeChatTerminalPaneShortcut(shortcut, terminalPaneActions)
      }
      // Tab groups have no equalize command; only terminal panes do.
      return groupId && shortcut !== 'equalize'
        ? runNativeChatSplitTarget(
            { kind: 'workspace-tab', unifiedTabId: tabId, groupId },
            shortcut
          )
        : false
    },
    [groupId, tabId, terminalPaneActions]
  )
  const menu: NativeChatSurfaceMenu = {
    rewind,
    // A chat in a terminal pane already hands off through that pane's own menu row.
    handOffDisabled: handOff.preparing || handOff.dialog !== null,
    onHandOff: terminalPaneActions === undefined && handOff.available ? handOff.open : undefined,
    actions: terminalPaneActions,
    resolveOrcaSessionId,
    showTerminalPaneActions: terminalPaneActions !== undefined,
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
  }
  return { menu, onSplit }
}
