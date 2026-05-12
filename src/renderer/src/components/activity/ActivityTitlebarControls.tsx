import { ArrowLeft, Bell } from 'lucide-react'

import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useActivityUnreadCount } from './useActivityUnreadCount'

export function ActivityTitlebarControls(): React.JSX.Element {
  const unreadCount = useActivityUnreadCount(true, 'agent-events')
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
