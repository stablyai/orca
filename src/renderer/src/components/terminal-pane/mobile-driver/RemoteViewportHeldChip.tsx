import { useEffect, useId, useState, type ReactElement } from 'react'
import { Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { FitHoldMode } from '@/lib/pane-manager/mobile-fit-overrides'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'

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
  const t = useTranslate()
  const labelId = useId()
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      // Sits below the pane's title strip and top banners so it never covers their corner controls.
      className="absolute right-2 top-[calc(var(--orca-pane-title-height)+var(--orca-pane-top-banner-height,0px)+0.5rem)] z-50 flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-card-foreground shadow-xs"
    >
      <Monitor className="size-3 text-muted-foreground" aria-hidden="true" />
      <span id={labelId} className="px-1">
        {t(
          'auto.components.terminal.pane.RemoteViewportHeldChip.sizedElsewhere',
          'Sized for another window'
        )}
      </span>
      <Button type="button" variant="default" size="xs" onClick={onFitHere}>
        {t('auto.components.terminal.pane.RemoteViewportHeldChip.fitHere', 'Fit here')}
      </Button>
    </div>
  )
}

/** Re-measures on pane resize so the chip appears once a hidden pane is shown and clears once grids match. */
export function HeldPaneRemoteViewportChip({
  pane,
  ownerGrid,
  onFitHere
}: {
  pane: Pick<ManagedPane, 'container' | 'fitAddon'>
  ownerGrid: Grid
  onFitHere: (paneGrid: Grid) => void
}): ReactElement | null {
  const [paneGrid, setPaneGrid] = useState(() => proposePaneGrid(pane))
  useEffect(() => {
    const remeasure = (): void => {
      const next = proposePaneGrid(pane)
      setPaneGrid((prev) => (prev?.cols === next?.cols && prev?.rows === next?.rows ? prev : next))
    }
    remeasure()
    const observer = new ResizeObserver(remeasure)
    observer.observe(pane.container)
    return () => observer.disconnect()
  }, [pane])
  if (!paneGrid || !shouldShowRemoteViewportHeldChip('remote-desktop-fit', ownerGrid, paneGrid)) {
    return null
  }
  return <RemoteViewportHeldChip onFitHere={() => onFitHere(paneGrid)} />
}

function proposePaneGrid(pane: Pick<ManagedPane, 'fitAddon'>): Grid | null {
  try {
    const proposed = pane.fitAddon.proposeDimensions()
    return proposed && proposed.cols > 0 && proposed.rows > 0
      ? { cols: proposed.cols, rows: proposed.rows }
      : null
  } catch {
    return null
  }
}
