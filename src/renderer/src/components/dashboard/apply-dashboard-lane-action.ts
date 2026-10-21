import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { AppState } from '@/store/types'
import {
  applyDashboardLaneAction,
  type DashboardLaneAction
} from '../../../../shared/dashboard-lanes'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

type LaneLivenessState = Pick<AppState, 'tabsByWorktree'>

/** A placement stays while its tab still exists anywhere — including sleeping
 *  workspaces, whose cards leave the board but come back on wake. */
export function createLivePaneKeyPredicate(state: LaneLivenessState): (paneKey: string) => boolean {
  const liveTabIds = new Set<string>()
  for (const tabs of Object.values(state.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      liveTabIds.add(tab.id)
    }
  }
  return (paneKey) => {
    const tabId = parsePaneKey(paneKey)?.tabId
    return tabId !== undefined && liveTabIds.has(tabId)
  }
}

function newLaneId(): string {
  return `lane-${createBrowserUuid()}`
}

/** Applies a lane edit or card move from either board host to settings. */
export function applyDashboardLaneActionToStore(action: DashboardLaneAction): void {
  const state = useAppStore.getState()
  const patch = applyDashboardLaneAction(state.settings ?? {}, action, {
    newLaneId,
    isLivePaneKey: createLivePaneKeyPredicate(state)
  })
  if (patch) {
    void state.updateSettings(patch)
  }
}
