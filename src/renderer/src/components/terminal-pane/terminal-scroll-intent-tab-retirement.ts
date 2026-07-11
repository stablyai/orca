import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { clearTerminalScrollIntentKey } from '../../lib/pane-manager/terminal-scroll-intent-key-store'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'

export function retireTerminalScrollIntentsForTabs(
  layoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot | undefined>> | null | undefined,
  tabIds: Iterable<string>
): void {
  // Why: cold-parked tabs have no PaneManager left to retire durable leaf ids
  // when the store later removes the tab or its owning worktree.
  const retiredLeafIds = new Set<string>()
  for (const tabId of tabIds) {
    const layout = layoutsByTabId?.[tabId]
    for (const leafId of collectLeafIdsInOrder(layout?.root)) {
      retiredLeafIds.add(leafId)
    }
    if (layout?.activeLeafId) {
      retiredLeafIds.add(layout.activeLeafId)
    }
    if (layout?.expandedLeafId) {
      retiredLeafIds.add(layout.expandedLeafId)
    }
    for (const leafRecord of [
      layout?.ptyIdsByLeafId,
      layout?.buffersByLeafId,
      layout?.scrollbackRefsByLeafId,
      layout?.titlesByLeafId
    ]) {
      for (const leafId of Object.keys(leafRecord ?? {})) {
        retiredLeafIds.add(leafId)
      }
    }
  }
  for (const leafId of retiredLeafIds) {
    clearTerminalScrollIntentKey(leafId)
  }
}
