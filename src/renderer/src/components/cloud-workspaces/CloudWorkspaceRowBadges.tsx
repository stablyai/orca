// The small marks after a cloud workspace's title on Home: private, started by a routine, and its
// W-number (shown on hover or focus; its space is held so nothing shifts).
import React from 'react'
import { CalendarClock, Lock } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import {
  formatWorkspaceNumber,
  type CloudWorkspace
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

export function CloudWorkspaceRowBadges({
  workspace: w,
  selfId,
  ownerName,
  revealNumber
}: {
  workspace: CloudWorkspace
  selfId: string | null
  ownerName: string
  revealNumber: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const revealOpen = revealNumber
  return (
    <>
      {w.visibility === 'private' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Lock
              role="img"
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={t('auto.components.cloudWorkspaces.private', 'Private')}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            {w.ownerUserId === selfId
              ? t(
                  'auto.components.cloudWorkspaces.privateTooltipYou',
                  'Private — only you can see it'
                )
              : t(
                  'auto.components.cloudWorkspaces.privateTooltip',
                  'Private — only {{name}} can open it',
                  {
                    name: ownerName
                  }
                )}
          </TooltipContent>
        </Tooltip>
      )}
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
