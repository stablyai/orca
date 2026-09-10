import type { ActiveRightSidebarTab } from '../../../../shared/ui-chrome-types'

export const RIGHT_SIDEBAR_MIN_WIDTH = 220
/** Width the Task panel needs before the provider detail view stops squeezing:
 *  below this the title column collapses next to the fixed-width workspace CTA. */
export const RIGHT_SIDEBAR_TASK_TAB_MIN_WIDTH = 560

/** Per-tab floor applied at render time only, so a tab that needs room gets it
 *  without rewriting the width the user chose for every other tab. */
export function getRightSidebarTabFloorWidth(tab: ActiveRightSidebarTab): number {
  return tab === 'task' ? RIGHT_SIDEBAR_TASK_TAB_MIN_WIDTH : RIGHT_SIDEBAR_MIN_WIDTH
}
export const RIGHT_SIDEBAR_MIN_NON_SIDEBAR_AREA = 320
export const RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH = 2000

export function computeMaxRightSidebarPanelWidth(
  windowWidth: number | null | undefined,
  renderedExtraWidth: number
): number {
  if (typeof windowWidth !== 'number' || !Number.isFinite(windowWidth)) {
    return RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH
  }

  return Math.max(
    RIGHT_SIDEBAR_MIN_WIDTH,
    windowWidth - RIGHT_SIDEBAR_MIN_NON_SIDEBAR_AREA - renderedExtraWidth
  )
}

export function clampRightSidebarPanelWidth(
  width: number,
  windowWidth: number | null | undefined,
  renderedExtraWidth: number
): number {
  return Math.min(
    computeMaxRightSidebarPanelWidth(windowWidth, renderedExtraWidth),
    Math.max(RIGHT_SIDEBAR_MIN_WIDTH, width)
  )
}
