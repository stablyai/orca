import { isPathEqualOrDescendant } from './file-explorer-paths'
import type { TreeNode } from './file-explorer-types'

// Why: skip descendants of other selected directories — deleting a parent
// already removes the child, and issuing both requests races on the
// now-missing path and produces spurious errors.
export function selectDeletionRoots(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter(
    (n) =>
      !nodes.some(
        (other) => other !== n && other.isDirectory && isPathEqualOrDescendant(n.path, other.path)
      )
  )
}

type RunBatchDeletionParams = {
  roots: TreeNode[]
  needsConfirmation: boolean
  confirmBatch: () => Promise<boolean>
  deleteNode: (node: TreeNode) => Promise<boolean>
}

// Why: confirm the whole batch once up front — per-node confirmation inside
// the delete path would prompt once per selected item. Returns the deleted
// roots, or null when the user cancels the batch.
export async function runBatchDeletion({
  roots,
  needsConfirmation,
  confirmBatch,
  deleteNode
}: RunBatchDeletionParams): Promise<TreeNode[] | null> {
  if (needsConfirmation && !(await confirmBatch())) {
    return null
  }
  // Why: process sequentially in the caller's tree order so each delete
  // fully settles before the next begins — this avoids concurrent writes
  // to the same parent directory and makes failure toasts deterministic.
  const deleted: TreeNode[] = []
  for (const node of roots) {
    if (await deleteNode(node)) {
      deleted.push(node)
    }
  }
  return deleted
}
