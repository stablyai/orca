/** One rail button (28px) plus its 10px gap; two groups with 20px between them use exactly one slot per button. */
export const APP_RAIL_SLOT_PX = 38

/** Whole slots that fit in the toolbar's content height (padding already excluded). */
export function appRailSlotCapacity(contentHeightPx: number): number {
  return Math.max(0, Math.floor(contentHeightPx / APP_RAIL_SLOT_PX))
}

export type AppRailPartition = {
  /** Destinations kept on the rail, from the top; the rest go into More in order. */
  shownDestinations: number
  more: boolean
  helpInMore: boolean
  settingsInMore: boolean
}

/**
 * Fit Workspaces, the destinations, Help and Settings into `capacity` slots. When they don't all fit, More takes a
 * slot and things fold into it from the bottom of the top group up: destinations first, then Help, then Settings.
 * Workspaces and More always stay (the floor); the rail never scrolls.
 */
export function partitionAppRail(destinationCount: number, capacity: number): AppRailPartition {
  if (1 + destinationCount + 2 <= capacity) {
    return {
      shownDestinations: destinationCount,
      more: false,
      helpInMore: false,
      settingsInMore: false
    }
  }
  let remaining = Math.max(0, capacity - 2)
  const settingsInMore = remaining < 1
  remaining = Math.max(0, remaining - 1)
  const helpInMore = remaining < 1
  remaining = Math.max(0, remaining - 1)
  return {
    shownDestinations: Math.min(destinationCount, remaining),
    more: true,
    helpInMore,
    settingsInMore
  }
}
