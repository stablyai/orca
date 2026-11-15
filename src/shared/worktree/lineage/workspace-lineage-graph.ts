import {
  getCyclicLineageChildKeys,
  isValidResolvedWorktreeLineageEdge
} from '../../resolved-worktree-lineage'
import { composeWorktreeHostIdentity } from '../host-qualified-identity'
import type { WorktreeLineage } from '../lineage-types'
import {
  resolveCrossStoreLineageParents,
  type CrossStoreLineageView
} from './cross-store-lineage-resolution'
import type { Worktree } from '../types'
import {
  resolveFolderLineageParents,
  type FolderLineageRecordOf,
  type FolderLineageRow
} from './folder-lineage-parents'

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

type LineagePolicyRow = FolderLineageRow & Pick<Worktree, 'instanceId'>

/** How a reader picks each child's one parent. Desktop and the phone share precedence and folder
 * rules; they differ only in the same-store worktree edge they trust and in old-peer loops. */
export type WorkspaceLineagePolicy<Row extends LineagePolicyRow> = {
  /** The row's same-store worktree parent, if its edge is valid to this reader. */
  sameStoreParentOf: (row: Row) => Row | undefined
  crossStoreLineage?: CrossStoreLineageView
  folderRecordOf?: FolderLineageRecordOf<Row>
  /** The phone keeps an older peer's same-store loops (rendered as a fallback) unless a parent in
   * another store joins the graph; desktop drops every loop. */
  keepSameStoreCycles?: boolean
}

/** One parent per child identity: a same-store worktree parent, else a same-store folder workspace
 * record, else a cross-store record. Pass every visible store's unfiltered rows: a filtered-out twin
 * must still make a parent ambiguous. */
export function resolveLineageParentsByPolicy<Row extends LineagePolicyRow>(
  rowsByHostIdentity: ReadonlyMap<string, Row>,
  policy: WorkspaceLineagePolicy<Row>
): Map<string, Row> {
  const crossStore = policy.crossStoreLineage
    ? resolveCrossStoreLineageParents(rowsByHostIdentity, policy.crossStoreLineage)
    : new Map<string, Row>()
  const parentByIdentity = new Map(crossStore)
  if (policy.folderRecordOf) {
    for (const [identity, folder] of resolveFolderLineageParents(
      rowsByHostIdentity,
      policy.folderRecordOf
    )) {
      parentByIdentity.set(identity, folder)
    }
  }
  for (const [identity, row] of rowsByHostIdentity) {
    const parent = policy.sameStoreParentOf(row)
    if (parent) {
      parentByIdentity.set(identity, parent)
    }
  }
  if (policy.keepSameStoreCycles && crossStore.size === 0) {
    return parentByIdentity
  }
  const identityOf = new Map([...rowsByHostIdentity].map(([identity, row]) => [row, identity]))
  const cyclic = getCyclicLineageChildKeys(
    new Map(
      [...parentByIdentity].flatMap(([identity, parent]) => {
        const parentIdentity = identityOf.get(parent)
        return parentIdentity === undefined ? [] : [[identity, parentIdentity] as const]
      })
    )
  )
  for (const identity of cyclic) {
    parentByIdentity.delete(identity)
  }
  return parentByIdentity
}

/** Desktop's parents: instance-checked same-store worktree edges, folder records and cross-store
 * records, loops dropped. Rows may include folder workspace rows (identity lineageInstanceIdOfRow). */
export function resolveWorkspaceLineageParents(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>,
  crossStoreLineage?: CrossStoreLineageView,
  folderRecordOf?: FolderLineageRecordOf
): Map<string, Worktree> {
  return resolveLineageParentsByPolicy(rowsByHostIdentity, {
    sameStoreParentOf: (row) => getSameStoreLineageParent(row, lineageById, rowsByHostIdentity),
    crossStoreLineage,
    folderRecordOf
  })
}
