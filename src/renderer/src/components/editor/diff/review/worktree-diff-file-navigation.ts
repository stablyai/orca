import type { SourceControlVisibleRow } from '../../../../../../shared/source-control/listing/source-control-visible-row'

export type WorktreeDiffNavigationDirection = 'next' | 'previous'

type AdjacentRowArgs = {
  /** Rows the Source Control panel displays, in order. */
  rows: readonly SourceControlVisibleRow[]
  currentKey: string
  /** Row order from the last render that still listed `currentKey`. */
  previousKeys: readonly string[] | null
  direction: WorktreeDiffNavigationDirection
}

/** Conflict rows open their own review surface, outside this sweep. */
export function isWorktreeDiffNavigationRow(row: SourceControlVisibleRow): boolean {
  return !row.entry.conflictKind
}

// No cross-file wrap: the ends of the list hand back to the caller's same-file wrap.
export function getAdjacentWorktreeDiffRow({
  rows,
  currentKey,
  previousKeys,
  direction
}: AdjacentRowArgs): SourceControlVisibleRow | null {
  const step = direction === 'next' ? 1 : -1
  const index = rows.findIndex((row) => row.key === currentKey)
  if (index !== -1) {
    return rows[index + step] ?? null
  }
  // The row left the list (staged, reverted, filtered out): continue from where it last sat.
  const lastIndex = previousKeys?.indexOf(currentKey) ?? -1
  if (!previousKeys || lastIndex === -1) {
    return null
  }
  const shownKeys = new Set(rows.map((row) => row.key))
  const currentPath = pathOfKey(currentKey)
  for (let i = lastIndex + step; i >= 0 && i < previousKeys.length; i += step) {
    const key = previousKeys[i]
    // The same file's other staging side is not a hop.
    if (shownKeys.has(key) && pathOfKey(key) !== currentPath) {
      return rows.find((row) => row.key === key) ?? null
    }
  }
  return null
}

// Row keys are `<area>::<path>`.
function pathOfKey(key: string): string {
  return key.slice(key.indexOf('::') + 2)
}
