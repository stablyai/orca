import { ArrowLeft, Bell } from 'lucide-react'

import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'

// Why: keep the unread accumulator local; "Mark all read" moved to the
// thread-list overflow menu in ActivityPrototypePage so it lives next to
// the cards it acts on.

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
    for (const unsupported of Object.values(s.migrationUnsupportedByPtyId)) {
      const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
      if (entry) {
        accumulate(entry, s.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0)
      }
    }
    return count
  })
}

export function ActivityTitlebarControls(): React.JSX.Element {
  const unreadCount = useActivityUnreadCount()
  const closeActivityPage = useAppStore((s) => s.closeActivityPage)

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-3 border-l border-border px-3">
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
              aria-label="Close agents"
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Close agents
          </TooltipContent>
        </Tooltip>
        <Bell className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">agents</span>
        <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">
          {unreadCount} unread
        </Badge>
      </div>
    </div>
  )
}
