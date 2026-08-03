import type React from 'react'
import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function RemoteServerUpdateStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const entryMap = useAppStore((state) => state.remoteServerUpdates)
  const running = useAppStore((state) => state.remoteServerUpdatesRunning)
  const setDialogOpen = useAppStore((state) => state.setRemoteServerUpdateDialogOpen)
  const entries = [...entryMap.values()]
  const failed = entries.filter((entry) => entry.phase === 'failed').length
  const updated = entries.filter((entry) => entry.phase === 'updated').length
  const updateCohort = entries.filter((entry) =>
    ['queued', 'checking-update', 'downloading', 'restarting', 'updated', 'failed'].includes(
      entry.phase
    )
  )

  if (!running && failed === 0 && updated === 0) {
    return null
  }

  const segment = running
    ? {
        icon: <RefreshCw className="size-3 animate-spin text-muted-foreground" />,
        label: translate(
          'auto.components.status.bar.RemoteServerUpdateStatusSegment.updating',
          'Updating {{value0}}/{{value1}}',
          { value0: updated + failed, value1: updateCohort.length }
        ),
        tooltip: translate(
          'auto.components.status.bar.RemoteServerUpdateStatusSegment.updatingTooltip',
          'Remote Orca Server updates are in progress'
        )
      }
    : failed > 0
      ? {
          icon: <AlertCircle className="size-3 text-destructive" />,
          label:
            failed === 1
              ? translate(
                  'auto.components.status.bar.RemoteServerUpdateStatusSegment.failedOne',
                  '1 server update failed'
                )
              : translate(
                  'auto.components.status.bar.RemoteServerUpdateStatusSegment.failed',
                  '{{value0}} server updates failed',
                  { value0: failed }
                ),
          tooltip: translate(
            'auto.components.status.bar.RemoteServerUpdateStatusSegment.failedTooltip',
            'Open Remote Orca Server updates to review and retry'
          )
        }
      : {
          icon: <CheckCircle2 className="size-3 text-muted-foreground" />,
          label:
            updated === 1
              ? translate(
                  'auto.components.status.bar.RemoteServerUpdateStatusSegment.updatedOne',
                  '1 server updated'
                )
              : translate(
                  'auto.components.status.bar.RemoteServerUpdateStatusSegment.updated',
                  '{{value0}} servers updated',
                  { value0: updated }
                ),
          tooltip: translate(
            'auto.components.status.bar.RemoteServerUpdateStatusSegment.updatedTooltip',
            'Remote Orca Server updates completed'
          )
        }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={segment.tooltip}
        >
          {segment.icon}
          {!iconOnly ? <span className="text-[11px] tabular-nums">{segment.label}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {segment.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
