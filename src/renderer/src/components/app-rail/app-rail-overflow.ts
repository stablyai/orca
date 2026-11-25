/** One rail button (28px) plus its 10px gap; two groups with 20px between them use exactly one slot per button. */
export const APP_RAIL_SLOT_PX = 38

/** Whole slots that fit in the toolbar's content height (padding already excluded). */
export function appRailSlotCapacity(contentHeightPx: number): number {
  return Math.max(0, Math.floor(contentHeightPx / APP_RAIL_SLOT_PX))
}

export type AppRailPartition = {
  /** Destinations kept on the rail, from the top; the rest go into More in order. */
  shownDestinations: number
  /** The "…" slot is More (folded items plus Customize) rather than Customize alone. */
  more: boolean
}

/**
 * Fit Workspaces, the destinations, the "…" slot and the account button into `capacity` slots. The "…" slot is
 * Customize when everything fits; otherwise it becomes More (which also holds Customize) and destinations fold into it
 * from the bottom of the top group up. Workspaces, "…" and the account button always stay (the floor); the account
 * button never folds, and the rail never scrolls.
 */
export function partitionAppRail(destinationCount: number, capacity: number): AppRailPartition {
  if (1 + destinationCount + 1 + 1 <= capacity) {
    return { shownDestinations: destinationCount, more: false }
  }
  const shownDestinations = Math.min(destinationCount, Math.max(0, capacity - 3))
  // Nothing folded (no destinations to fold) keeps the slot as Customize.
  return { shownDestinations, more: shownDestinations < destinationCount }
}
