import { useState, type JSX } from 'react'
import { AlarmClock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { WorkspaceSnooze } from '../../../../shared/workspace-snooze'
import { formatWorkspaceSnoozeWakeAt } from './workspace-snooze-presets'

/** Only visible while "Show snoozed" is on, since snoozed rows are otherwise hidden. */
export function WorkspaceSnoozeBadge({ snooze }: { snooze: WorkspaceSnooze }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="shrink-0">
          <AlarmClock className="size-2.5" />
          {translate('auto.components.sidebar.workspaceSnooze.badge', 'snoozed')}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <SnoozeWakeTooltipText wakeAt={snooze.wakeAt} />
      </TooltipContent>
    </Tooltip>
  )
}

// Why a child: tooltip content mounts per hover, so "today" is judged at hover time.
function SnoozeWakeTooltipText({ wakeAt }: { wakeAt: number | undefined }): JSX.Element {
  const [now] = useState(() => new Date())
  return (
    <>
      {wakeAt === undefined
        ? translate(
            'auto.components.sidebar.workspaceSnooze.badgeTooltipNoTime',
            'Snoozed. Right-click to wake now.'
          )
        : translate(
            'auto.components.sidebar.workspaceSnooze.badgeTooltip',
            'Snoozed until {{time}}. Right-click to wake now.',
            { time: formatWorkspaceSnoozeWakeAt(wakeAt, now) }
          )}
    </>
  )
}
