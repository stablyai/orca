import type { UISlice } from '@/store/slices/ui/ui-slice-contract'

// Why one numeric selector: the rail re-reads it on every store write, and a primitive bit set replaces the separate
// Workspaces-active and list-body selectors without allocating, so Activity adds no selector to the rail.
const WORKSPACES_ACTIVE = 1
const ACTIVITY_ACTIVE = 2
const LIST_SHOWS_ACTIVITY = 4

export function selectRailListState(state: Pick<UISlice, 'activeView' | 'sidebarBody'>): number {
  const showsActivity = state.sidebarBody === 'agents'
  let bits = showsActivity ? LIST_SHOWS_ACTIVITY : 0
  if (state.activeView === 'terminal') {
    bits |= showsActivity ? ACTIVITY_ACTIVE : WORKSPACES_ACTIVE
  }
  return bits
}

export type RailListState = {
  workspacesActive: boolean
  activityActive: boolean
  listShowsWorkspaces: boolean
}

export function decodeRailListState(bits: number): RailListState {
  return {
    workspacesActive: (bits & WORKSPACES_ACTIVE) !== 0,
    activityActive: (bits & ACTIVITY_ACTIVE) !== 0,
    listShowsWorkspaces: (bits & LIST_SHOWS_ACTIVITY) === 0
  }
}
