// The archive "snapshot" definition (archive-snapshot-copy.ts) as a tooltip on Archive controls. Every
// Archive control and every place the copy says "snapshot" reuses the one string, so it can't drift
// between the delete dialog, the menus, the hovercard and the archived view.
import type React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useArchiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import { archiveSnapshotDefinition } from './archive-snapshot-copy'

/** The definition for this workspace: its kept-until date once archived, else today + the TTL. */
export function useArchiveSnapshotDefinition(keptUntil?: number | null): string {
  const t = useTranslate()
  const ttlDays = useArchiveTtlDays()
  return archiveSnapshotDefinition(t, { keptUntil, ttlDays })
}

export function ArchiveSnapshotTooltip({
  children,
  keptUntil,
  side = 'top'
}: {
  /** The Archive control: a Button or a DropdownMenuItem (Radix `asChild` needs a ref-forwarding element). */
  children: React.ReactElement
  /** An archived workspace's own kept-until date. */
  keptUntil?: number | null
  side?: 'top' | 'right' | 'bottom' | 'left'
}): React.JSX.Element {
  const definition = useArchiveSnapshotDefinition(keptUntil)
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
