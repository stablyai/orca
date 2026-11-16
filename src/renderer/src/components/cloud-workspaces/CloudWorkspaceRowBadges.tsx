// The small marks after a cloud workspace's title in Open cloud workspace…: started by a routine,
// and its W-number (shown on hover or focus; its space is held so nothing shifts).
import type React from 'react'
import { CalendarClock } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  formatWorkspaceNumber,
  type CloudWorkspace
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

export function CloudWorkspaceRowBadges({
  workspace: w,
  revealNumber
}: {
  workspace: CloudWorkspace
  revealNumber: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const revealOpen = revealNumber
  return (
    <>
      {w.fromRoutine === true && (
        <Tooltip>
          <TooltipTrigger asChild>
            <CalendarClock
              role="img"
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={t('auto.components.cloudWorkspaces.routineRun', 'Routine run')}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            {t(
              'auto.components.cloudWorkspaces.routineRunTooltip',
              "Started by a routine. It's deleted when the run ends."
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {/* Its W-number shows on hover or focus only; the space is held so nothing shifts. */}
      {w.number ? (
        <span
          className={cn(
            'shrink-0 font-mono text-2xs tabular-nums text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 motion-safe:transition-opacity',
            revealOpen && 'opacity-100'
          )}
        >
          {formatWorkspaceNumber(w.number)}
        </span>
      ) : null}
    </>
  )
}
