import type { TreeNode } from './file-explorer-types'

export type FileExplorerRowProjection = {
  getVisibleCount: () => number
  getVisibleSlice: (startIndex: number, endIndex: number) => TreeNode[]
  getRowAtIndex: (index: number) => TreeNode | null
  getRowByPath: (path: string) => TreeNode | null
  getIndexByPath: (path: string) => number | null
  hasPath: (path: string) => boolean
  getOrderedPaths: () => string[]
  getRowsByPaths: (paths: Set<string>) => TreeNode[]
  countVisiblePaths: (paths: Set<string>) => number
  getInsertIndexAfterSubtree: (parentPath: string, worktreePath: string | null) => number
  getParentIndex: (index: number) => number | null
  getFirstChildIndex: (index: number) => number | null
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
  rowsByPath: ReadonlyMap<string, TreeNode>
): FileExplorerRowProjection {
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
    countVisiblePaths: (paths) => countVisiblePaths(rowsByPath, paths),
    getInsertIndexAfterSubtree: (parentPath, worktreePath) =>
      getInsertIndexAfterSubtree(visibleFlatRows, getIndexByPathMap, parentPath, worktreePath),
    getParentIndex: (index) => getParentIndex(visibleFlatRows, index),
    getFirstChildIndex: (index) => getFirstChildIndex(visibleFlatRows, index)
  }
}

function getParentIndex(visibleFlatRows: readonly TreeNode[], index: number): number | null {
  const current = visibleFlatRows[index]
  if (!current) {
    return null
  }
  if (current.depth <= 0) {
    return null
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const node = visibleFlatRows[i]
    if (node && node.depth < current.depth) {
      return i
    }
  }
  return null
}

function getFirstChildIndex(visibleFlatRows: readonly TreeNode[], index: number): number | null {
  const current = visibleFlatRows[index]
  if (!current || !current.isDirectory) {
    return null
  }
  const next = visibleFlatRows[index + 1]
  if (next && next.depth === current.depth + 1) {
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

  const visibleIndexes: number[] = []
  const indexByPath = getIndexByPathMap()
  for (const path of paths) {
    const index = indexByPath.get(path)
    if (index !== undefined) {
      visibleIndexes.push(index)
    }
  }

  visibleIndexes.sort((a, b) => a - b)
  return visibleIndexes.map((index) => visibleFlatRows[index])
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

function getInsertIndexAfterSubtree(
  visibleFlatRows: readonly TreeNode[],
  getIndexByPathMap: () => ReadonlyMap<string, number>,
  parentPath: string,
  worktreePath: string | null
): number {
  if (parentPath === worktreePath) {
    return visibleFlatRows.length
  }

  const parentIndex = getIndexByPathMap().get(parentPath)
  if (parentIndex === undefined) {
    return 0
  }

  const parentDepth = visibleFlatRows[parentIndex].depth
  let insertIndex = parentIndex + 1
  while (insertIndex < visibleFlatRows.length && visibleFlatRows[insertIndex].depth > parentDepth) {
    insertIndex += 1
  }
  return insertIndex
}
