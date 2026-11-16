// What Archive does (archive-snapshot-copy.ts), as a tooltip on every Archive control, so the delete
// dialog and the menus can't drift apart.
import type React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useArchiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import { archiveSnapshotDefinition } from './archive-snapshot-copy'

/** The tooltip sentence, with the control plane's retention once it has loaded. */
export function useArchiveSnapshotDefinition(): string {
  const t = useTranslate()
  const ttlDays = useArchiveTtlDays()
  return archiveSnapshotDefinition(t, { ttlDays })
}

export function ArchiveSnapshotTooltip({
  children,
  side = 'top'
}: {
  /** The Archive control: a Button or a DropdownMenuItem (Radix `asChild` needs a ref-forwarding element). */
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
}): React.JSX.Element {
  const definition = useArchiveSnapshotDefinition()
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={8}
        className="max-w-72"
        data-archive-snapshot-definition=""
      >
        {definition}
      </TooltipContent>
    </Tooltip>
  )
}
