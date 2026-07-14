import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'

type TerminalLiveLayoutInsertionFinalizerArgs = {
  manager: Pick<PaneManager, 'arrangeOrchestrationGrid' | 'setMaintainOrchestrationGrid'>
  restoredLayout: Pick<TerminalLayoutSnapshot, 'root' | 'layoutMode'>
  appliedInsertion: boolean
  restoreActivePane?: () => void
  persistLayoutSnapshot: () => void
}

export function finalizeTerminalLiveLayoutInsertions(
  args: TerminalLiveLayoutInsertionFinalizerArgs
): void {
  const shouldMaintainGrid = args.restoredLayout.layoutMode === 'orchestration-grid'
  const ownershipChanged = args.manager.setMaintainOrchestrationGrid(shouldMaintainGrid)
  const shouldCanonicalizeModeTransition =
    ownershipChanged && shouldMaintainGrid && args.restoredLayout.root !== null
  if (!args.appliedInsertion && !shouldCanonicalizeModeTransition) {
    args.restoreActivePane?.()
    return
  }
  if (shouldMaintainGrid && args.restoredLayout.root) {
    // Why: the final grid notification persists immediately, so authoritative
    // focus and canonical geometry must both land before that single commit.
    args.restoreActivePane?.()
    args.manager.arrangeOrchestrationGrid(collectLeafIdsInOrder(args.restoredLayout.root))
    return
  }
  args.persistLayoutSnapshot()
  args.restoreActivePane?.()
}
