import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { TreeNode } from './file-explorer-types'

// Delete selected ancestors only; separate descendant requests would race missing paths and report spurious errors.
export function selectDeletionRoots(nodes: TreeNode[]): TreeNode[] {
  const directories = nodes
    .filter((node) => node.isDirectory)
    .map((node) => ({
      node,
      matches: createNormalizedPathInsideOrEqualMatcher(node.path)
    }))
  if (directories.length === 0) {
    return [...nodes]
  }
  return nodes.filter((node) => {
    const candidate = normalizeRuntimePathForComparison(node.path)
    return !directories.some((other) => other.node !== node && other.matches(candidate))
  })
}

type RunBatchDeletionParams = {
  roots: TreeNode[]
  needsConfirmation: boolean
  confirmBatch: () => Promise<boolean>
  deleteNode: (node: TreeNode) => Promise<boolean>
}

// Confirm once for the whole selection; return deleted roots or null on cancellation.
export async function runBatchDeletion({
  roots,
  needsConfirmation,
  confirmBatch,
  deleteNode
}: RunBatchDeletionParams): Promise<TreeNode[] | null> {
  if (needsConfirmation && !(await confirmBatch())) {
    return null
  }
  // Delete sequentially in tree order to avoid concurrent parent-directory writes and nondeterministic failure toasts.
  const deleted: TreeNode[] = []
  for (const node of roots) {
    if (await deleteNode(node)) {
      deleted.push(node)
    }
  }
  return deleted
}
