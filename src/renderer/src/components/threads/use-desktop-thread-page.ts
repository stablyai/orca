import { effectiveWorkspaceView } from '@/lib/renderer-view'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useThreadMembership } from '../native-chat/structured-session-summary-store'
import { useThreadDraft, resolveDesktopThreadPage, type ThreadPage } from './thread-navigation'

export function useDesktopThreadPage(): ThreadPage {
  const draft = useThreadDraft((s) => s.draft)
  const [enabled, activeView, worktreeId, groups, groupId] = useAppStore(
    useShallow((s) => {
      const enabled = s.settings?.experimentalThreads === true
      const view = effectiveWorkspaceView(s)
      const relevant = enabled && view === 'terminal'
      const worktreeId = s.activeWorktreeId
      return [
        enabled,
        view,
        worktreeId,
        relevant && worktreeId ? s.groupsByWorktree[worktreeId] : undefined,
        relevant && worktreeId ? s.activeGroupIdByWorktree[worktreeId] : undefined
      ] as const
    })
  )
  const tabId = useMemo(() => groups?.find((g) => g.id === groupId)?.activeTabId, [groups, groupId])
  const hidden = useThreadMembership(worktreeId, enabled)
  return useMemo(
    () => resolveDesktopThreadPage({ enabled, activeView, worktreeId, tabId, hidden, draft }),
    [enabled, activeView, worktreeId, tabId, hidden, draft]
  )
}
