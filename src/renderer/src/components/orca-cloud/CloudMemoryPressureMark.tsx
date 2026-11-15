import React from 'react'
import { MemoryStick } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { cloudMemoryPressure } from '@/lib/orca-cloud/cloud-memory-pressure'

/**
 * MEMGUARD: the sidebar row's mark for a cloud workspace short of memory, from the status read
 * (refreshed every minute while it runs). Quiet while memory is low; amber once Orca may stop the
 * largest process to keep the workspace responsive. Renders nothing otherwise.
 */
export function CloudMemoryPressureMark({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const pressure = useCloudWorkspace((state) =>
    cloudMemoryPressure(state.status[worktreeId]?.status)
  )
  if (!pressure) {
    return null
  }
  const label =
    pressure === 'critical'
      ? t(
          'orcaCloud.memoryPressure.critical',
          'Out of memory. Orca may stop the largest process to keep the workspace responsive.'
        )
      : t('orcaCloud.memoryPressure.high', 'Running low on memory')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          data-cloud-memory-pressure={pressure}
          className={cn(
            'inline-flex size-3.5 shrink-0 items-center justify-center',
            pressure === 'critical' ? 'text-status-warning-text' : 'text-muted-foreground'
          )}
        >
          <MemoryStick className="size-3" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
