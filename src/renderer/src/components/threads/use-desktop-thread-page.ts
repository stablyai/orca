import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useThreadMembership } from '../native-chat/structured-session-summary-store'
import { useThreadNavigation, resolveDesktopThreadPage, type ThreadPage } from './thread-navigation'

export function useDesktopThreadPage(): ThreadPage {
  const intent = useThreadNavigation((s) => s.selection)
  const [enabled, activeView, worktreeId, hostId, tabId] = useAppStore(
    useShallow((s) => {
      const worktreeId = s.activeWorktreeId
      const group = worktreeId
        ? s.groupsByWorktree[worktreeId]?.find(
            (g) => g.id === s.activeGroupIdByWorktree[worktreeId]
          )
        : null
      return [
        s.settings?.experimentalThreads === true,
        s.activeView,
        worktreeId,
        s.activeWorkspaceExecutionHostId,
        group?.activeTabId
      ] as const
    })
  )
  const hidden = useThreadMembership(worktreeId, enabled)
  return useMemo(
    () =>
      resolveDesktopThreadPage({ enabled, activeView, worktreeId, hostId, tabId, hidden, intent }),
    [enabled, activeView, worktreeId, hostId, tabId, hidden, intent]
  )
}
