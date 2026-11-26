import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { LineageRowProjection } from './lineage-row-projection'
import type { RenderRow } from './render-row'

/** The families whose box paints the active workspace's highlight: the family it sits in, and
 *  the family it heads while its children are hidden.
 *
 *  One painter for both, so the card's own surface never fades in where the box was: the box
 *  paints the same wash the card's surface paints, but without the 200 ms transition, and the
 *  one frame where the two painters swap is the flicker. */
export function activeFamilyRootsFor(args: {
  rows: readonly RenderRow[]
  projection: LineageRowProjection
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}): ReadonlySet<number> {
  const { rows, projection, activeWorktreeId, activeWorkspaceExecutionHostId } = args
  const roots = new Set<number>()
  if (!activeWorktreeId) {
    return roots
  }
  const addRoots = (occurrences: readonly number[]): void => {
    for (const index of occurrences) {
      const root = projection.frames[index].root
      // The box paints a family with rows below its root. A root whose children are hidden has
      // no rows below it, so it loses the box and its own surface fades in where the box was:
      // it keeps the box as long as it has children.
      if (projection.frames[root].end > root || (index === root && hasChildren(rows[index]))) {
        roots.add(root)
      }
    }
  }
  if (activeWorkspaceExecutionHostId) {
    addRoots(
      projection.occurrencesByIdentity.get(
        composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, activeWorktreeId)
      ) ?? []
    )
  } else {
    for (const [identity, occurrences] of projection.occurrencesByIdentity) {
      if (getWorktreeIdFromHostIdentity(identity) === activeWorktreeId) {
        addRoots(occurrences)
      }
    }
  }
  return roots
}

/** A row with children of its own, hidden or shown. */
function hasChildren(row: RenderRow | undefined): boolean {
  if (row?.type === 'item') {
    return row.lineageChildCount > 0
  }
  if (row?.type === 'folder-workspace') {
    return (row.lineageChildCount ?? 0) > 0
  }
  return false
}
