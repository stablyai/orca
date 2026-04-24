import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'

/**
 * Returns a stable dispatch function for terminal notifications.
 * Reads repo/worktree labels from the store at dispatch time rather
 * than via selectors — avoids the allWorktrees() anti-pattern which
 * creates a new array reference on every store update and triggers
 * excessive re-renders of TerminalPane.
 */
export function useNotificationDispatch(
  worktreeId: string
): (event: { source: 'terminal-bell' }) => void {
  return useCallback(
    (event: { source: 'terminal-bell' }) => {
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

      void window.api.notifications.dispatch({
        source: event.source,
        worktreeId,
        repoLabel: repo?.displayName,
        worktreeLabel: worktree?.displayName || worktree?.branch || worktreeId,
        isActiveWorktree: state.activeWorktreeId === worktreeId
      })
    },
    [worktreeId]
  )
}
