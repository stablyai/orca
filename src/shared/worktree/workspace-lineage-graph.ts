import {
  getCyclicLineageChildKeys,
  isValidResolvedWorktreeLineageEdge
} from '../resolved-worktree-lineage'
import { composeWorktreeHostIdentity, getWorktreeHostIdentity } from './host-qualified-identity'
import type { WorktreeLineage } from './lineage-types'
import {
  resolveCrossStoreLineageParents,
  type CrossStoreLineageView
} from './cross-store-lineage-resolution'
import type { Worktree } from './types'

export type WorktreeWithInlineLineage = Worktree & { lineage?: WorktreeLineage | null }

export function getProjectedWorktreeLineage(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>
): WorktreeLineage | null | undefined {
  if (Object.hasOwn(lineageById, worktree.id)) {
    return lineageById[worktree.id]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolved rows may carry an inline lineage the Worktree type omits; it is only read.
  return (worktree as WorktreeWithInlineLineage).lineage
}

/** Nest on the worktree’s own host; legacy rows without host IDs nest only under equally unqualified parents. */
export function getSameStoreLineageParent(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>
): Worktree | undefined {
  const projected = getProjectedWorktreeLineage(worktree, lineageById)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolved rows may carry an inline lineage the Worktree type omits; it is only read, never trusted over a matching projection.
  const inline = (worktree as WorktreeWithInlineLineage).lineage
  const lineage = projected?.worktreeInstanceId === worktree.instanceId ? projected : inline
  if (!lineage) {
    return undefined
  }
  const parent = rowsByHostIdentity.get(
    composeWorktreeHostIdentity(worktree.hostId, lineage.parentWorktreeId)
  )
  return parent && isValidResolvedWorktreeLineageEdge(worktree, parent, lineage)
    ? parent
    : undefined
}

/** Every parent the viewer can see, by child host identity: same-store edges from saved lineage merged
 * with cross-store records (a valid same-store edge wins), cycles dropped. Rows may include folder
 * workspace rows; their identity is lineageInstanceIdOfRow. Pass every visible store's unfiltered rows:
 * a filtered-out twin must still make a parent ambiguous. */
export function resolveWorkspaceLineageParents(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>,
  crossStoreLineage?: CrossStoreLineageView
): Map<string, Worktree> {
  const parentByIdentity = crossStoreLineage
    ? resolveCrossStoreLineageParents(rowsByHostIdentity, crossStoreLineage)
    : new Map<string, Worktree>()
  for (const [identity, row] of rowsByHostIdentity) {
    const parent = getSameStoreLineageParent(row, lineageById, rowsByHostIdentity)
    if (parent) {
      parentByIdentity.set(identity, parent)
    }
  }
  const cyclic = getCyclicLineageChildKeys(
    new Map(
      [...parentByIdentity].map(([identity, parent]) => [identity, getWorktreeHostIdentity(parent)])
    )
  )
  for (const identity of cyclic) {
    parentByIdentity.delete(identity)
  }
  return parentByIdentity
}
