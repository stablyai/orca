import { useEffect } from 'react'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { resolveNativeChatTabAgentEvidence } from '../tab-bar/native-chat-tab-agent-evidence'
import { canToggleNativeChat } from './native-chat-availability'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { isMacPlatform, matchesNativeChatToggleShortcut } from './native-chat-shortcut'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { resolveKeyboardWorkspaceId } from '@/lib/floating-workspace-terminal-actions'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from './native-chat-leaf-routing'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export function resolveNativeChatToggleShortcutDetectedAgent({
  terminalTabId,
  terminalLayout,
  agentStatusByPaneKey
}: {
  terminalTabId: string
  terminalLayout?: TerminalLayoutSnapshot | null
  agentStatusByPaneKey: Record<string, { agentType?: AgentType }>
}): AgentType | null {
  const activeLeafId = resolveNativeChatActiveLayoutLeafId(terminalLayout)
  if (activeLeafId) {
    return agentStatusByPaneKey[`${terminalTabId}:${activeLeafId}`]?.agentType ?? null
  }
  if (!isNativeChatTabWideFallbackSafe(terminalLayout)) {
    return null
  }
  return (
    Object.entries(agentStatusByPaneKey).find(([paneKey]) =>
      paneKey.startsWith(`${terminalTabId}:`)
    )?.[1].agentType ?? null
  )
}

/** Toggle supported agent-terminal views only on the key event’s originating workspace surface. */
export function useNativeChatToggleShortcut(worktreeId: string, isWorktreeActive: boolean): void {
  useEffect(() => {
    if (!isWorktreeActive) {
      return
    }
    const isMac = isMacPlatform()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || !matchesNativeChatToggleShortcut(e, isMac)) {
        return
      }
      const state = useAppStore.getState()
      // Main and floating surfaces can coexist; only the key’s originating surface may act.
      if (resolveKeyboardWorkspaceId(e.target, state.activeWorktreeId) !== worktreeId) {
        return
      }
      const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
      const group = (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === activeGroupId)
      if (!group?.activeTabId) {
        return
      }
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === group.activeTabId
      )
      if (!tab || tab.contentType !== 'terminal') {
        return
      }
      const terminalTab = (state.tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === tab.entityId
      )
      // Resolve the actual supported agent from backing terminal-tab pane keys, matching the menu/header gate.
      const terminalLayout = state.terminalLayoutsByTabId[tab.entityId]
      const tabWideFallbackSafe = isNativeChatTabWideFallbackSafe(terminalLayout)
      const detectedAgent = resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: tab.entityId,
        terminalLayout,
        agentStatusByPaneKey: state.agentStatusByPaneKey
      })
      const titleFallbackAgent =
        tabWideFallbackSafe && terminalTab
          ? resolveNativeChatTabAgentEvidence(terminalTab, tab)
          : null
      if (
        !canToggleNativeChat({
          contentType: 'terminal',
          launchAgent: detectedAgent || !tabWideFallbackSafe ? null : terminalTab?.launchAgent,
          detectedAgent,
          resolvedAgent: detectedAgent ? null : titleFallbackAgent,
          nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
            getConnectionIdFromState(state, worktreeId)
          ),
          isChatViewMode: tab.viewMode === 'chat'
        })
      ) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      state.toggleTabViewMode(tab.id)
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => {
      removeAppKeyListener('keydown', onKeyDown)
    }
  }, [worktreeId, isWorktreeActive])
}
