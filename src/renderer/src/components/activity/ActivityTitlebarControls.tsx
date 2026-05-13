import { ArrowLeft, Bell } from 'lucide-react'

import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'

function useActivityUnreadCount(): number {
  return useAppStore((s) => {
    let count = 0
    const isUnreadState = (state: AgentStatusState): boolean =>
      state === 'done' || state === 'blocked' || state === 'waiting'
    // Why: Activity feed surfaces every historical done/blocked/waiting event from
    // stateHistory plus the live state, so the badge must mirror the same walk —
    // counting only on entry.state under-counts panes that started a new turn.
    const accumulate = (entry: AgentStatusEntry, ackAt: number): void => {
      for (const history of entry.stateHistory) {
        if (isUnreadState(history.state) && ackAt < history.startedAt) {
          count += 1
        }
      }
      if (isUnreadState(entry.state) && ackAt < entry.stateStartedAt) {
        count += 1
      }
    }
    for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
      accumulate(entry, s.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
    }
    for (const [paneKey, retained] of Object.entries(s.retainedAgentsByPaneKey)) {
      accumulate(retained.entry, s.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
    }
    return count
  })
}

export function ActivityTitlebarControls(): React.JSX.Element {
  const unreadCount = useActivityUnreadCount()
  const acknowledgeAgents = useAppStore((s) => s.acknowledgeAgents)
  const closeActivityPage = useAppStore((s) => s.closeActivityPage)

  const markAllRead = (): void => {
    const state = useAppStore.getState()
    // Why: ack every pane (live + retained) — Date.now() exceeds all historical
    // startedAt values, clearing the per-history-event unread flags too.
    acknowledgeAgents([
      ...Object.values(state.agentStatusByPaneKey).map((entry) => entry.paneKey),
      ...Object.values(state.retainedAgentsByPaneKey).map((retained) => retained.entry.paneKey)
    ])
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-center justify-between gap-3 border-l border-border px-3">
      <div
        className="flex min-w-0 items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* Why: Activity hides the worktree sidebar (full-page surface), so the
            sidebar's nav row isn't available as the back path. This Back button
            is the dedicated exit, mirroring Settings' onBack pattern. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={closeActivityPage}
              aria-label="Close activity"
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Close activity
          </TooltipContent>
        </Tooltip>
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
