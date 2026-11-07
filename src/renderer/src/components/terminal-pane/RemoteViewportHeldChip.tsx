import type { ReactElement } from 'react'
import { Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { FitHoldMode } from '@/lib/pane-manager/mobile-fit-overrides'

type Grid = { cols: number; rows: number }

/** Only a visibly different grid needs explaining; an equal owner grid looks native here. */
export function shouldShowRemoteViewportHeldChip(
  fitMode: FitHoldMode | null,
  ownerGrid: Grid | null,
  paneGrid: Grid | null
): boolean {
  return Boolean(
    fitMode === 'remote-desktop-fit' &&
    ownerGrid &&
    paneGrid &&
    paneGrid.cols > 0 &&
    paneGrid.rows > 0 &&
    (ownerGrid.cols !== paneGrid.cols || ownerGrid.rows !== paneGrid.rows)
  )
}

// Another desktop or web client owns this PTY's size; typing here also reclaims it.
export function RemoteViewportHeldChip({ onFitHere }: { onFitHere: () => void }): ReactElement {
  const label = translate(
    'auto.components.terminal.pane.RemoteViewportHeldChip.sizedElsewhere',
    'Sized for another window'
  )
  return (
    <div
      role="group"
      aria-label={label}
      className="absolute right-2 top-2 z-50 flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-card-foreground shadow-xs"
    >
      <Monitor className="size-3 text-muted-foreground" aria-hidden="true" />
      <span className="px-1">{label}</span>
      <Button type="button" variant="default" size="xs" onClick={onFitHere}>
        {translate('auto.components.terminal.pane.RemoteViewportHeldChip.fitHere', 'Fit here')}
      </Button>
    </div>
  )
}
