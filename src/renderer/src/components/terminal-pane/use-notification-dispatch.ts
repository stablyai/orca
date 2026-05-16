import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { playDesktopNotificationSound } from '@/lib/desktop-notification-sound'

type TerminalNotificationEvent = {
  source: 'terminal-bell' | 'agent-task-complete'
  terminalTitle?: string
  paneKey?: string
}

/**
 * Returns a stable dispatch function for terminal notifications.
 * Reads repo/worktree labels from the store at dispatch time rather
 * than via selectors — avoids the allWorktrees() anti-pattern which
 * creates a new array reference on every store update and triggers
 * excessive re-renders of TerminalPane.
 */
export function useNotificationDispatch(
  worktreeId: string
): (event: TerminalNotificationEvent) => void {
  return useCallback(
    (event: TerminalNotificationEvent) => {
      const state = useAppStore.getState()

      // Why: shutdownWorktreeTerminals clears ptyIdsByTabId synchronously
      // before killing PTYs asynchronously. Any notification arriving after
      // that point is stale — e.g. a staleTitleTimer that fires 3 s after
      // shutdown, or an agent tracker transition from accumulated closure
      // state. Checking for live PTYs at dispatch time catches ALL phantom
      // notification sources regardless of which timer or callback produced
      // them, rather than trying to cancel each one individually.
      const tabs = state.tabsByWorktree[worktreeId] ?? []
      const hasLivePtys = tabs.some((tab) => (state.ptyIdsByTabId[tab.id] ?? []).length > 0)
      if (!hasLivePtys) {
        return
      }

      // Why: prefer worktree.repoId over string-parsing the worktreeId. The
      // `${repoId}::${path}` format is an implementation detail of id
      // construction; coupling the notification dispatcher to it would silently
      // drop the repo label if that format ever changes. The worktree object
      // itself is the source of truth for its owning repo.
      const worktree = getWorktreeMapFromState(state).get(worktreeId)
      const repo = worktree ? getRepoMapFromState(state).get(worktree.repoId) : null
      const customSoundPath = state.settings?.notifications?.customSoundPath ?? null
      const agentStatus =
        event.source === 'agent-task-complete' && event.paneKey
          ? state.agentStatusByPaneKey[event.paneKey]
          : undefined
      const agentSnapshot = agentStatus
        ? {
            agentType: agentStatus.agentType,
            agentState: agentStatus.state,
            agentPrompt: agentStatus.prompt,
            agentToolName: agentStatus.toolName,
            agentToolInput: agentStatus.toolInput,
            agentLastAssistantMessage: agentStatus.lastAssistantMessage,
            agentInterrupted: agentStatus.interrupted
          }
        : {}

      void window.api.notifications
        .dispatch({
          source: event.source,
          worktreeId,
          repoLabel: repo?.displayName,
          worktreeLabel: worktree?.displayName || worktree?.branch || worktreeId,
          terminalTitle: event.terminalTitle,
          isActiveWorktree: state.activeWorktreeId === worktreeId,
          ...agentSnapshot
        })
        .then((result) => {
          if (result.delivered) {
            void playDesktopNotificationSound(customSoundPath)
          }
        })
        .catch((err) => {
          console.warn('Failed to dispatch notification:', err)
        })
    },
    [worktreeId]
  )
}
