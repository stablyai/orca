import { useEffect } from 'react'
import { useAppStore } from '../../store'
import { resolveTabAgentFromTitle } from '@/lib/use-tab-agent'
import { canToggleNativeChat } from './native-chat-availability'
import { isMacPlatform, matchesNativeChatToggleShortcut } from './native-chat-shortcut'

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
      const hasDetectedAgent = Object.keys(state.agentStatusByPaneKey).some((paneKey) =>
        paneKey.startsWith(`${tab.id}:`)
      )
      if (
        !canToggleNativeChat({
          experimentalNativeChatEnabled: state.settings?.experimentalNativeChat === true,
          contentType: 'terminal',
          launchAgent: terminalTab?.launchAgent,
          hasDetectedAgent,
          hasResolvedAgent:
            resolveTabAgentFromTitle(tab.label ?? '') !== null ||
            (terminalTab ? resolveTabAgentFromTitle(terminalTab.title) !== null : false),
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
