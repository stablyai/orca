import { useCallback, useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

/** How long the inline "Stop agent?" confirmation stays armed before reverting. */
const CONFIRM_TIMEOUT_MS = 3_000

/** Idle and done agents confirm inline; anything still running routes through
 *  the board's modal, mirroring Cmd+W in the main window (idle panes close
 *  outright, running ones prompt). */
export function stopNeedsDialog(card: DashboardCard): boolean {
  return card.dotState !== 'idle' && card.dotState !== 'done'
}

type AgentKanbanCardStopControlProps = {
  card: DashboardCard
  /** Armed state lives on the card so moving the pointer anywhere off the card
   *  — not merely off this small control — cancels a pending confirmation. */
  confirming: boolean
  onArm: () => void
  onDisarm: () => void
  /** Fires once the stop is committed — the board decides whether that means
   *  stopping now or opening the confirmation dialog. */
  onStop: (card: DashboardCard) => void
}

/**
 * Stop affordance for one card, overlaid on the top-right corner where the
 * state dot sits (the dot fades out on hover so they never collide). It is a
 * SIBLING of the card's button — nesting a button inside one is invalid HTML —
 * so clicking it can never also open the terminal.
 */
export function AgentKanbanCardStopControl({
  card,
  confirming,
  onArm,
  onDisarm,
  onStop
}: AgentKanbanCardStopControlProps): React.JSX.Element {
  // Why: an armed confirmation the user walked away from must not stay armed
  // for the next visit to this card.
  useEffect(() => {
    if (!confirming) {
      return
    }
    const timer = setTimeout(onDisarm, CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [confirming, onDisarm])

  const handleStopClick = useCallback(() => {
    if (confirming || stopNeedsDialog(card)) {
      onDisarm()
      onStop(card)
      return
    }
    onArm()
  }, [card, confirming, onArm, onDisarm, onStop])

  // Matches the card's p-2.5 padding so the control lands exactly on the dot.
  const anchor = 'absolute right-2.5 top-2.5 z-10 flex items-center'

  if (confirming) {
    return (
      <span className={anchor}>
        <button
          type="button"
          autoFocus
          onClick={handleStopClick}
          onBlur={onDisarm}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onDisarm()
            }
          }}
          className={cn(
            'inline-flex items-center rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5',
            'text-[10px] font-medium leading-none text-destructive',
            'transition-colors hover:bg-destructive/20',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive'
          )}
        >
          {translate('dashboardPopout.card.stop.confirm', 'Stop agent?')}
        </button>
      </span>
    )
  }

  return (
    <span className={anchor}>
      <button
        type="button"
        onClick={handleStopClick}
        aria-label={translate('dashboardPopout.card.stop.action', 'Stop agent')}
        title={translate(
          'dashboardPopout.card.stop.tooltip',
          'Stop agent — kills the process and closes its terminal'
        )}
        className={cn(
          'inline-flex items-center justify-center rounded-sm text-muted-foreground/70 hover:text-destructive',
          'transition-opacity duration-150',
          'can-hover:opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        )}
      >
        <X className="size-3.5" />
      </button>
    </span>
  )
}
