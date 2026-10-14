import type { TreeNode } from './file-explorer-types'
import type { FileExplorerCompactRowLayout } from './file-explorer-compact-folders'

const NO_COMPACTED_ANCESTORS: readonly TreeNode[] = []

export type FileExplorerRowProjection = {
  getVisibleCount: () => number
  getVisibleSlice: (startIndex: number, endIndex: number) => TreeNode[]
  getRowAtIndex: (index: number) => TreeNode | null
  /** A folder folded into a compact row resolves to that row, here and in the other path lookups. */
  getRowByPath: (path: string) => TreeNode | null
  getIndexByPath: (path: string) => number | null
  hasPath: (path: string) => boolean
  getOrderedPaths: () => string[]
  getRowsByPaths: (paths: Set<string>) => TreeNode[]
  countVisiblePaths: (paths: Set<string>) => number
  getInsertIndexAfterSubtree: (parentPath: string, worktreePath: string | null) => number
  getParentIndex: (index: number) => number | null
  getFirstChildIndex: (index: number) => number | null
  /** Indentation of the row at `index`; differs from `node.depth` below compacted folders. */
  getRowDepth: (index: number) => number
  /** Folders folded into the row at `index` by compact folders, outermost first. */
  getCompactedAncestors: (index: number) => readonly TreeNode[]
}

export function createFileExplorerRowProjection(
  visibleFlatRows: TreeNode[]
): FileExplorerRowProjection {
  const rowsByPath = new Map<string, TreeNode>()

  for (const row of visibleFlatRows) {
    rowsByPath.set(row.path, row)
  }

  return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
}

export function createFileExplorerRowProjectionFromParts(
  visibleFlatRows: TreeNode[],
  rowsByPath: ReadonlyMap<string, TreeNode>,
  compactLayout?: FileExplorerCompactRowLayout
): FileExplorerRowProjection {
  const getRowDepth = (index: number): number =>
    compactLayout?.depths[index] ?? visibleFlatRows[index]?.depth ?? 0
  let indexByPath: Map<string, number> | null = null
  const getIndexByPathMap = (): Map<string, number> => {
    if (indexByPath !== null) {
      return indexByPath
    }

    // Why: normal refresh/render paths need path lookup, not path-to-index.
    // Defer the index until reveal, inline create, or multi-selection asks for it.
    const nextIndexByPath = new Map<string, number>()
    for (let index = 0; index < visibleFlatRows.length; index += 1) {
      nextIndexByPath.set(visibleFlatRows[index].path, index)
    }
    for (const [index, ancestors] of compactLayout?.compactedAncestorsByIndex ?? []) {
      for (const ancestor of ancestors) {
        nextIndexByPath.set(ancestor.path, index)
      }
    }
    indexByPath = nextIndexByPath
    return nextIndexByPath
  }

  const getRowAtIndex = (index: number): TreeNode | null => visibleFlatRows[index] ?? null
  const getRowByPath = (path: string): TreeNode | null => rowsByPath.get(path) ?? null
  const getIndexByPath = (path: string): number | null => getIndexByPathMap().get(path) ?? null

  return {
    getVisibleCount: () => visibleFlatRows.length,
    getVisibleSlice: (startIndex, endIndex) => visibleFlatRows.slice(startIndex, endIndex + 1),
    getRowAtIndex,
    getRowByPath,
    getIndexByPath,
    hasPath: (path) => rowsByPath.has(path),
    getOrderedPaths: () => visibleFlatRows.map((row) => row.path),
    getRowsByPaths: (paths) =>
      getRowsByPathsInProjectionOrder(visibleFlatRows, rowsByPath, getIndexByPathMap, paths),
    countVisiblePaths: (paths) =>
      compactLayout ? countVisibleRows(rowsByPath, paths) : countVisiblePaths(rowsByPath, paths),
    getInsertIndexAfterSubtree: (parentPath, worktreePath) =>
      getInsertIndexAfterSubtree(
        visibleFlatRows.length,
        getRowDepth,
        getIndexByPathMap,
        parentPath,
        worktreePath
      ),
    getParentIndex: (index) => getParentIndex(visibleFlatRows, getRowDepth, index),
    getFirstChildIndex: (index) => getFirstChildIndex(visibleFlatRows, getRowDepth, index),
    getRowDepth,
    getCompactedAncestors: (index) =>
      compactLayout?.compactedAncestorsByIndex.get(index) ?? NO_COMPACTED_ANCESTORS
  }
}

function getParentIndex(
  visibleFlatRows: readonly TreeNode[],
  getRowDepth: (index: number) => number,
  index: number
): number | null {
  if (!visibleFlatRows[index]) {
    return null
  }
  const depth = getRowDepth(index)
  if (depth <= 0) {
    return null
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (getRowDepth(i) < depth) {
      return i
    }
  }
  return null
}

function getFirstChildIndex(
  visibleFlatRows: readonly TreeNode[],
  getRowDepth: (index: number) => number,
  index: number
): number | null {
  const current = visibleFlatRows[index]
  if (!current || !current.isDirectory) {
    return null
  }
  if (visibleFlatRows[index + 1] && getRowDepth(index + 1) === getRowDepth(index) + 1) {
    return index + 1
  }
  return null
}

function getRowsByPathsInProjectionOrder(
  visibleFlatRows: readonly TreeNode[],
  rowsByPath: ReadonlyMap<string, TreeNode>,
  getIndexByPathMap: () => ReadonlyMap<string, number>,
  paths: Set<string>
): TreeNode[] {
  if (paths.size === 0) {
    return []
  }
  if (paths.size === 1) {
    const path = paths.values().next().value
    const row = path ? rowsByPath.get(path) : null
    return row ? [row] : []
  }

  // Why a set: a compact row's own path and a folder folded into it share one index.
  const visibleIndexes = new Set<number>()
  const indexByPath = getIndexByPathMap()
  for (const path of paths) {
    const index = indexByPath.get(path)
    if (index !== undefined) {
      visibleIndexes.add(index)
    }
  }

  return [...visibleIndexes].sort((a, b) => a - b).map((index) => visibleFlatRows[index])
}

function countVisiblePaths(rowsByPath: ReadonlyMap<string, TreeNode>, paths: Set<string>): number {
  if (paths.size <= 1) {
    return paths.size
  }

  let count = 0
  for (const path of paths) {
    if (rowsByPath.has(path)) {
      count += 1
    }
  }
  return count
}

function countVisibleRows(rowsByPath: ReadonlyMap<string, TreeNode>, paths: Set<string>): number {
  if (paths.size <= 1) {
    return paths.size
  }

  const rows = new Set<TreeNode>()
  for (const path of paths) {
    const row = rowsByPath.get(path)
    if (row) {
      rows.add(row)
    }
  }
  return rows.size
}

function getInsertIndexAfterSubtree(
  rowCount: number,
  getRowDepth: (index: number) => number,
  getIndexByPathMap: () => ReadonlyMap<string, number>,
  parentPath: string,
  worktreePath: string | null
): number {
  if (parentPath === worktreePath) {
    return rowCount
  }

  const parentIndex = getIndexByPathMap().get(parentPath)
  if (parentIndex === undefined) {
    return 0
  }

  const parentDepth = getRowDepth(parentIndex)
  let insertIndex = parentIndex + 1
  while (insertIndex < rowCount && getRowDepth(insertIndex) > parentDepth) {
    insertIndex += 1
  }
  return insertIndex
}
