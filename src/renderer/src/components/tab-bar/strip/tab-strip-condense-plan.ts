import {
  ACTIVE_TAB_CONDENSED_MAX_PX,
  ACTIVE_TAB_MIN_TITLED_WIDTH_PX,
  ACTIVE_TAB_MIN_WIDTH_PX,
  TAB_ICON_ONLY_WIDTH_PX,
  TAB_MIN_WIDTH_WITH_TITLE_PX,
  TAB_OVERFLOW_CHIP_WIDTH_PX
} from './tab-strip-width-budget'

export type TabStripCondensedPlan = {
  mode: 'condensed'
  activeId: string
  activeWidth: number
  /** Visible tabs drawn as 32px icons; includes the active tab when it is too narrow for a title. */
  iconIds: readonly string[]
  /** Tabs behind the "+N" chip, in strip order. */
  hiddenIds: readonly string[]
  /** Only the chip is left; it shows the active tab's icon and the tab count. */
  chipOnly: boolean
  /** First visible index of the sliding window, fed back so switching slides the minimum. */
  windowStart: number
}

export type TabStripPlan = { mode: 'titled' } | TabStripCondensedPlan

export const TITLED_TAB_STRIP_PLAN: TabStripPlan = { mode: 'titled' }

/**
 * Fold order as space runs out: titled tabs shrink to 80px, then inactive tabs become icons while
 * the active keeps its title, then tabs outside a window around the active go behind "+N", and
 * finally only the chip is left. `width` is the room for tabs, excluding "+" and scroll arrows.
 */
export function planTabStrip({
  width,
  ids,
  activeId,
  previousWindowStart
}: {
  width: number
  ids: readonly string[]
  activeId: string | null
  previousWindowStart: number | null
}): TabStripPlan {
  const n = ids.length
  const w = Math.max(0, Math.floor(width))
  if (n === 0 || Math.floor(w / n) >= TAB_MIN_WIDTH_WITH_TITLE_PX) {
    return TITLED_TAB_STRIP_PLAN
  }
  const foundIndex = activeId === null ? -1 : ids.indexOf(activeId)
  const activeIndex = foundIndex === -1 ? 0 : foundIndex
  const active = ids[activeIndex]!
  const others = ids.filter((_, index) => index !== activeIndex)

  // Single tab: nothing to hide, so no chip; its title truncates.
  if (n === 1) {
    const activeWidth = Math.max(TAB_ICON_ONLY_WIDTH_PX, w)
    return condensed(
      active,
      activeWidth,
      activeWidth < ACTIVE_TAB_MIN_TITLED_WIDTH_PX ? ids : [],
      [],
      false,
      0
    )
  }

  const activeWidthWithAllIcons = w - (n - 1) * TAB_ICON_ONLY_WIDTH_PX
  if (activeWidthWithAllIcons >= ACTIVE_TAB_MIN_WIDTH_PX) {
    return condensed(
      active,
      Math.min(ACTIVE_TAB_CONDENSED_MAX_PX, activeWidthWithAllIcons),
      others,
      [],
      false,
      0
    )
  }

  const room = w - TAB_OVERFLOW_CHIP_WIDTH_PX
  let activeWidth = Math.min(ACTIVE_TAB_MIN_WIDTH_PX, room)
  const chipOnly = activeWidth < TAB_ICON_ONLY_WIDTH_PX
  const activeTitled = activeWidth >= ACTIVE_TAB_MIN_TITLED_WIDTH_PX
  if (!activeTitled) {
    activeWidth = TAB_ICON_ONLY_WIDTH_PX
  }
  const k = chipOnly
    ? -1
    : Math.min(n - 1, Math.floor((room - activeWidth) / TAB_ICON_ONLY_WIDTH_PX))
  // Never "+1": a chip as wide as the one hidden icon helps nobody, so show that icon instead.
  if (n - 1 - k === 1 && activeWidthWithAllIcons >= TAB_ICON_ONLY_WIDTH_PX) {
    return condensed(
      active,
      activeWidthWithAllIcons,
      activeWidthWithAllIcons < ACTIVE_TAB_MIN_TITLED_WIDTH_PX ? ids : others,
      [],
      false,
      0
    )
  }
  if (chipOnly) {
    return condensed(active, 0, [], ids, true, activeIndex)
  }
  if (activeTitled) {
    activeWidth = Math.min(ACTIVE_TAB_CONDENSED_MAX_PX, room - k * TAB_ICON_ONLY_WIDTH_PX)
  }

  // Slide the previous window the minimum distance that brings the active tab into it.
  let start = previousWindowStart ?? activeIndex - Math.floor(k / 2)
  start = Math.max(activeIndex - k, Math.min(activeIndex, start))
  start = Math.max(0, Math.min(n - 1 - k, start))
  const iconIds: string[] = []
  const hiddenIds: string[] = []
  ids.forEach((id, index) => {
    if (index < start || index > start + k) {
      hiddenIds.push(id)
    } else if (index !== activeIndex || !activeTitled) {
      iconIds.push(id)
    }
  })
  return condensed(active, activeWidth, iconIds, hiddenIds, false, start)
}

function condensed(
  activeId: string,
  activeWidth: number,
  iconIds: readonly string[],
  hiddenIds: readonly string[],
  chipOnly: boolean,
  windowStart: number
): TabStripCondensedPlan {
  return { mode: 'condensed', activeId, activeWidth, iconIds, hiddenIds, chipOnly, windowStart }
}

/** Plans that render the same tabs the same way; width alone changes only a CSS variable. */
export function sameTabStripMembership(a: TabStripPlan, b: TabStripPlan): boolean {
  if (a.mode === 'titled' || b.mode === 'titled') {
    return a.mode === b.mode
  }
  return (
    a.activeId === b.activeId &&
    a.chipOnly === b.chipOnly &&
    a.windowStart === b.windowStart &&
    sameIds(a.iconIds, b.iconIds) &&
    sameIds(a.hiddenIds, b.hiddenIds)
  )
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}
