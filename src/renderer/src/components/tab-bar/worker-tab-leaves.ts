import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { workerLeafIds } from '../../../../shared/orchestration/workers/worker-tab-stamp'

/** A terminal tab's leaves from this window's current layout; undefined when the layout is unknown.
 *  A stamped leaf id is history, not proof of what the tab holds now, so it never stands in. */
export function workerTabLeafIds(
  state: Pick<AppState, 'terminalLayoutsByTabId'>,
  tab: Pick<Tab, 'contentType' | 'entityId'>
): readonly string[] | undefined {
  if (tab.contentType !== 'terminal') {
    return undefined
  }
  const root = state.terminalLayoutsByTabId[tab.entityId]?.root
  return root ? collectLayoutLeafIdsInOrder(root) : undefined
}

/** A stamped terminal whose known layout no longer holds any of its worker's leaves: the user's tab now. */
export function isInertWorkerStamp(
  state: Pick<AppState, 'terminalLayoutsByTabId'>,
  tab: Pick<Tab, 'contentType' | 'entityId' | 'workerTab'>
): boolean {
  if (!tab.workerTab) {
    return false
  }
  const leafIds = workerTabLeafIds(state, tab)
  if (!leafIds) {
    return false
  }
  const owned = workerLeafIds(tab.workerTab)
  return !leafIds.some((leafId) => owned.has(leafId))
}
