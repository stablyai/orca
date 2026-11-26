import type { UISlice } from '@/store/slices/ui/ui-slice-contract'

// Why one numeric selector: the rail re-reads it on every store write, and a primitive bit set replaces the separate
// Workspaces-active and list-body selectors without allocating, so Activity adds no selector to the rail.
const WORKSPACES_ACTIVE = 1
const ACTIVITY_ACTIVE = 2
const LIST_SHOWS_ACTIVITY = 4
const LIST_ROWS_MOUNTED = 8

export function selectRailListState(
  state: Pick<UISlice, 'activeView' | 'sidebarBody' | 'sidebarOpen'>
): number {
  const showsActivity = state.sidebarBody === 'agents'
  let bits = showsActivity ? LIST_SHOWS_ACTIVITY : 0
  if (state.activeView === 'terminal') {
    bits |= showsActivity ? ACTIVITY_ACTIVE : WORKSPACES_ACTIVE
  }
  // The user's own collapse (not a rail page hiding the list) unmounts the list's rows.
  if (state.sidebarOpen) {
    bits |= LIST_ROWS_MOUNTED
  }
  return bits
}

export type RailListState = {
  workspacesActive: boolean
  activityActive: boolean
  listShowsWorkspaces: boolean
  /** The list's rows are mounted: exactly when the rail-off sidebar would mount its Activity badge. */
  listRowsMounted: boolean
}

export function decodeRailListState(bits: number): RailListState {
  return {
    workspacesActive: (bits & WORKSPACES_ACTIVE) !== 0,
    activityActive: (bits & ACTIVITY_ACTIVE) !== 0,
    listShowsWorkspaces: (bits & LIST_SHOWS_ACTIVITY) === 0,
    listRowsMounted: (bits & LIST_ROWS_MOUNTED) !== 0
  }
}
