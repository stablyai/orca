import { Bell } from 'lucide-react'

import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

function useActivityUnreadCount(): number {
  return useAppStore((s) => {
    let count = 0
    for (const worktrees of Object.values(s.worktreesByRepo)) {
      for (const worktree of worktrees) {
        if (worktree.createdAt && worktree.isUnread) {
          count += 1
        }
      }
    }
    for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
      if (entry.state !== 'done' && entry.state !== 'blocked' && entry.state !== 'waiting') {
        continue
      }
      if ((s.acknowledgedAgentsByPaneKey[paneKey] ?? 0) < entry.stateStartedAt) {
        count += 1
      }
    }
    for (const [paneKey, retained] of Object.entries(s.retainedAgentsByPaneKey)) {
      if (retained.entry.state !== 'done') {
        continue
      }
      if ((s.acknowledgedAgentsByPaneKey[paneKey] ?? 0) < retained.entry.stateStartedAt) {
        count += 1
      }
    }
    return count
  })
}

export function ActivityTitlebarControls(): React.JSX.Element {
  const unreadCount = useActivityUnreadCount()
  const acknowledgeAgents = useAppStore((s) => s.acknowledgeAgents)
  const clearWorktreeUnread = useAppStore((s) => s.clearWorktreeUnread)

  const markAllRead = (): void => {
    const state = useAppStore.getState()
    acknowledgeAgents([
      ...Object.values(state.agentStatusByPaneKey)
        .filter(
          (entry) =>
            entry.state === 'done' || entry.state === 'blocked' || entry.state === 'waiting'
        )
        .map((entry) => entry.paneKey),
      ...Object.values(state.retainedAgentsByPaneKey).map((retained) => retained.entry.paneKey)
    ])
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const worktree of worktrees) {
        if (worktree.createdAt && worktree.isUnread) {
          clearWorktreeUnread(worktree.id)
        }
      }
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-center justify-between gap-3 border-l border-border px-3">
      <div className="flex min-w-0 items-center gap-2">
        <Bell className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">Activity</span>
        <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">
          {unreadCount} unread
        </Badge>
      </div>
      <div
        className="flex shrink-0 items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Button type="button" variant="ghost" size="xs" onClick={markAllRead}>
          Mark all read
        </Button>
      </div>
    </div>
  )
}
