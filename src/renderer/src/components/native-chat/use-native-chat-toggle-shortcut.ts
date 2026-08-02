import { useEffect } from 'react'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { canToggleNativeChat } from './native-chat-availability'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { isMacPlatform, matchesNativeChatToggleShortcut } from './native-chat-shortcut'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from './native-chat-leaf-routing'

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

/** Toggles the active worktree's focused agent-terminal tab between the terminal
 *  and native chat views via the keyboard. Gated to the active worktree so only
 *  one listener acts at a time, and to agent terminals so the chord is inert on
 *  plain shells / non-terminal surfaces. */
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
      // Carry the agent identity (not just "an agent exists") so the chord stays
      // inert on unsupported agents (e.g. Gemini), matching the menu/header gate.
      // Pane keys are `${entityId}:${leafId}` — the backing terminal tab id, not
      // the unified tab id.
      const terminalLayout = state.terminalLayoutsByTabId[tab.entityId]
      const tabWideFallbackSafe = isNativeChatTabWideFallbackSafe(terminalLayout)
      const detectedAgent = resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: tab.entityId,
        terminalLayout,
        agentStatusByPaneKey: state.agentStatusByPaneKey
      })
      const titleFallbackAgent = tabWideFallbackSafe
        ? (resolveCommittedTitleAgentType(tab.label ?? '') ??
          (terminalTab ? resolveCommittedTitleAgentType(terminalTab.title) : null))
        : null
      if (
        !canToggleNativeChat({
          experimentalNativeChatEnabled: state.settings?.experimentalNativeChat === true,
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
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [worktreeId, isWorktreeActive])
}
