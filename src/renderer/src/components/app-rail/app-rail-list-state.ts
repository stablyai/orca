import type { UISlice } from '@/store/slices/ui/ui-slice-contract'
import type { AppState } from '@/store/types'
import { selectActivityInboxEnabled } from '@/lib/bots-enabled'

// Why one numeric selector: the rail re-reads it on every store write, and a primitive bit set replaces the separate
// Workspaces-active and list-body selectors without allocating, so Activity adds no selector to the rail.
const WORKSPACES_ACTIVE = 1
const ACTIVITY_ACTIVE = 2
const LIST_SHOWS_ACTIVITY = 4
const ACTIVITY_INBOX = 8

export function selectRailListState(
  state: Pick<UISlice, 'activeView' | 'sidebarBody'> &
    Pick<AppState, 'settings' | 'orcaProfileAuthStatus'>
): number {
  const showsActivity = state.sidebarBody === 'agents'
  // Activity is a rail item only with bots on; without, the list's Activity is today's, opened from its bell.
  const inbox = selectActivityInboxEnabled(state)
  let bits = (showsActivity ? LIST_SHOWS_ACTIVITY : 0) | (inbox ? ACTIVITY_INBOX : 0)
  if (state.activeView === 'terminal') {
    bits |= showsActivity ? (inbox ? ACTIVITY_ACTIVE : 0) : WORKSPACES_ACTIVE
  }
  return bits
}

export type RailListState = {
  workspacesActive: boolean
  activityActive: boolean
  listShowsWorkspaces: boolean
  /** The rail shows Activity (app rail and bots on). */
  activityInbox: boolean
}

export function decodeRailListState(bits: number): RailListState {
  return {
    workspacesActive: (bits & WORKSPACES_ACTIVE) !== 0,
    activityActive: (bits & ACTIVITY_ACTIVE) !== 0,
    listShowsWorkspaces: (bits & LIST_SHOWS_ACTIVITY) === 0,
    activityInbox: (bits & ACTIVITY_INBOX) !== 0
  }
}
