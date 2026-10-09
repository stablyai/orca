import React from 'react'
import { Clock } from 'lucide-react'
import { useAppStore } from '@/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  selectHasScheduledMessageProblem,
  selectPendingScheduledCount
} from '@/store/slices/scheduled-messages'

type WorktreeCardScheduledMessagesBadgeProps = {
  worktreeId: string
  className?: string
}

export function WorktreeCardScheduledMessagesBadge({
  worktreeId,
  className
}: WorktreeCardScheduledMessagesBadgeProps): React.JSX.Element | null {
  const pendingCount = useAppStore((s) => selectPendingScheduledCount(s, worktreeId))
  const hasProblem = useAppStore((s) => selectHasScheduledMessageProblem(s, worktreeId))

  if (pendingCount === 0 && !hasProblem) {
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-0.5 text-[10px] leading-none',
            hasProblem ? 'text-annotation-highlight' : 'text-muted-foreground',
            className
          )}
          data-worktree-card-scheduled-messages=""
        >
          <Clock className="size-3" aria-hidden="true" />
          {pendingCount > 0 ? pendingCount : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {hasProblem
          ? translate(
              'auto.components.sidebar.scheduledMessagesBadgeProblem',
              'A scheduled message needs attention. Open Automations to send or reschedule it.'
            )
          : translate(
              'auto.components.sidebar.scheduledMessagesBadgePending',
              'Scheduled messages are queued for this workspace’s agent.'
            )}
      </TooltipContent>
    </Tooltip>
  )
}
