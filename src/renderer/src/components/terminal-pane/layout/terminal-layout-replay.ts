import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { getLeftmostLeafId } from './terminal-layout-leaf-traversal'
import { normalizeTerminalLayoutSnapshot } from './terminal-layout-normalization'
import { resolveRootlessTerminalLayoutLeafId } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'

export function replayTerminalLayout(
  manager: PaneManager,
  snapshot: TerminalLayoutSnapshot | null | undefined,
  focusInitialPane: boolean
): Map<string, number> {
  const paneByLeafId = new Map<string, number>()

  const normalized = normalizeTerminalLayoutSnapshot(snapshot)
  snapshot = normalized.snapshot
  const initialLeafId = snapshot.root
    ? getLeftmostLeafId(snapshot.root)
    : (resolveRootlessTerminalLayoutLeafId(snapshot) ?? undefined)
  const initialPane = manager.createInitialPane({ focus: focusInitialPane, leafId: initialLeafId })
  if (!snapshot?.root) {
    paneByLeafId.set(initialPane.leafId, initialPane.id)
    return paneByLeafId
  }

  const restoreNode = (node: TerminalPaneLayoutNode, paneId: number): void => {
    if (node.type === 'leaf') {
      paneByLeafId.set(node.leafId, paneId)
      return
    }

    const createdPane = manager.splitPane(paneId, node.direction as TerminalPaneSplitDirection, {
      ratio: node.ratio,
      leafId: getLeftmostLeafId(node.second)
    })
    if (!createdPane) {
      restoreNode(node.first, paneId)
      return
    }

    restoreNode(node.first, paneId)
    restoreNode(node.second, createdPane.id)
  }

  restoreNode(snapshot.root, initialPane.id)
  return paneByLeafId
}
