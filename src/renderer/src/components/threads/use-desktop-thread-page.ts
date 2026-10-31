import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useThreadMembership } from '../native-chat/structured-session-summary-store'
import { useThreadNavigation, resolveDesktopThreadPage, type ThreadPage } from './thread-navigation'

export function useDesktopThreadPage(): ThreadPage {
  const intent = useThreadNavigation((s) => s.selection)
  const [enabled, activeView, worktreeId, hostId, groups, groupId] = useAppStore(
    useShallow((s) => {
      const enabled = s.settings?.experimentalThreads === true
      const relevant = enabled && s.activeView === 'terminal' && intent?.kind !== 'new'
      const worktreeId = s.activeWorktreeId
      return [
        enabled,
        s.activeView,
        worktreeId,
        s.activeWorkspaceExecutionHostId,
        relevant && worktreeId ? s.groupsByWorktree[worktreeId] : undefined,
        relevant && worktreeId ? s.activeGroupIdByWorktree[worktreeId] : undefined
      ] as const
    })
  )
  const tabId = useMemo(() => groups?.find((g) => g.id === groupId)?.activeTabId, [groups, groupId])
  const hidden = useThreadMembership(worktreeId, enabled)
  return useMemo(
    () =>
      resolveDesktopThreadPage({ enabled, activeView, worktreeId, hostId, tabId, hidden, intent }),
    [enabled, activeView, worktreeId, hostId, tabId, hidden, intent]
  )
}
