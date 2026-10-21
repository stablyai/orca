import type { TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'

export type FileExplorerCompactRowLayout = {
  /** Indentation in `TreeNode.depth` units: a folded row sits at its outermost folder's depth. */
  depths: readonly number[]
  /** Folders folded into a row, outermost first. Only folded rows have an entry. */
  compactedAncestorsByIndex: ReadonlyMap<number, readonly TreeNode[]>
}

export type FileExplorerCompactedRows = {
  rows: TreeNode[]
  /** Also maps every folded folder to the row that now shows it. */
  rowsByPath: Map<string, TreeNode>
  layout: FileExplorerCompactRowLayout
}

/**
 * Folds each visible folder whose only visible child is a folder into that child's row, like VS
 * Code's `explorer.compactFolders`. The row keeps the deepest folder's node, so clicks, actions and
 * drops target that folder.
 *
 * Why the flattened rows rather than `dirCache`: a folder only folds while it is expanded with its
 * listing loaded, so the result never claims more than the uncompacted tree would show, and the
 * name-filter projection gets the same folding for free.
 */
export function compactFileExplorerRows(
  visibleRows: readonly TreeNode[],
  keepsOwnRow: (row: TreeNode) => boolean
): FileExplorerCompactedRows {
  const subtreeEnds = getSubtreeEnds(visibleRows)
  const rows: TreeNode[] = []
  const rowsByPath = new Map<string, TreeNode>()
  const depths: number[] = []
  const compactedAncestorsByIndex = new Map<number, readonly TreeNode[]>()
  // Rows that can still parent a later row: the deepest folded depth, and where it is drawn.
  const openRows: { depth: number; drawnDepth: number }[] = []

  for (let headIndex = 0; headIndex < visibleRows.length; headIndex += 1) {
    const head = visibleRows[headIndex]
    let tailIndex = headIndex
    while (foldsIntoOnlyChild(visibleRows, subtreeEnds, tailIndex, keepsOwnRow)) {
      tailIndex += 1
    }
    const tail = visibleRows[tailIndex]
    let parent = openRows.at(-1)
    while (parent && parent.depth >= head.depth) {
      openRows.pop()
      parent = openRows.at(-1)
    }
    const drawnDepth = parent ? parent.drawnDepth + 1 : head.depth

    if (tailIndex > headIndex) {
      const ancestors = visibleRows.slice(headIndex, tailIndex)
      compactedAncestorsByIndex.set(rows.length, ancestors)
      for (const ancestor of ancestors) {
        rowsByPath.set(ancestor.path, tail)
      }
    }
    rows.push(tail)
    rowsByPath.set(tail.path, tail)
    depths.push(drawnDepth)
    openRows.push({ depth: tail.depth, drawnDepth })
    headIndex = tailIndex
  }

  return { rows, rowsByPath, layout: { depths, compactedAncestorsByIndex } }
}

function foldsIntoOnlyChild(
  rows: readonly TreeNode[],
  subtreeEnds: readonly number[],
  index: number,
  keepsOwnRow: (row: TreeNode) => boolean
): boolean {
  const row = rows[index]
  const child = rows[index + 1]
  return (
    row.isDirectory &&
    child !== undefined &&
    child.isDirectory &&
    child.depth === row.depth + 1 &&
    // The child's subtree ending where this row's does means the child has no visible sibling.
    subtreeEnds[index + 1] === subtreeEnds[index] &&
    !keepsOwnRow(row)
  )
}

/** Index just past each row's visible subtree. */
function getSubtreeEnds(rows: readonly TreeNode[]): number[] {
  const ends: number[] = Array.from({ length: rows.length }, () => rows.length)
  const open: number[] = []
  for (let index = 0; index < rows.length; index += 1) {
    let last = open.at(-1)
    while (last !== undefined && rows[last].depth >= rows[index].depth) {
      ends[last] = index
      open.pop()
      last = open.at(-1)
    }
    open.push(index)
  }
  return ends
}

/** Projects already-flattened visible rows with single-folder chains folded into one row each. */
export function createCompactFileExplorerRowProjection(
  visibleRows: readonly TreeNode[],
  keepsOwnRow: (row: TreeNode) => boolean
): FileExplorerRowProjection {
  const { rows, rowsByPath, layout } = compactFileExplorerRows(visibleRows, keepsOwnRow)
  return createFileExplorerRowProjectionFromParts(rows, rowsByPath, layout)
}
