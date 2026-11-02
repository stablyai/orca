import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { TreeNode } from './file-explorer-types'

type ChildListingIndex = {
  exactSymlinkPaths?: Set<string>
  normalizedChildren?: Map<string, TreeNode>
}

const childListings = new WeakMap<readonly TreeNode[], ChildListingIndex>()

function childListingIndex(children: readonly TreeNode[]): ChildListingIndex {
  let index = childListings.get(children)
  if (!index) {
    index = {}
    childListings.set(children, index)
  }
  return index
}

export function hasExactFileExplorerSymlink(children: readonly TreeNode[], path: string): boolean {
  const index = childListingIndex(children)
  if (!index.exactSymlinkPaths) {
    const paths = new Set<string>()
    for (const child of children) {
      if (child.isSymlink === true) {
        paths.add(child.path)
      }
    }
    index.exactSymlinkPaths = paths
  }
  return index.exactSymlinkPaths.has(path)
}

export function findNormalizedFileExplorerChild(
  children: readonly TreeNode[],
  path: string
): TreeNode | undefined {
  const index = childListingIndex(children)
  if (!index.normalizedChildren) {
    const rows = new Map<string, TreeNode>()
    for (const child of children) {
      rows.set(normalizeRuntimePathForComparison(child.path), child)
    }
    index.normalizedChildren = rows
  }
  return index.normalizedChildren.get(normalizeRuntimePathForComparison(path))
}
