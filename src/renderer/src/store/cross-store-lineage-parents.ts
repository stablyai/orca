import {
  buildCrossStoreLineageView,
  lineageStoreKeyOfRow,
  OWN_LINEAGE_STORE_KEY,
  type CrossStoreLineageView
} from '../../../shared/worktree/cross-store-lineage-resolution'
import {
  resolveSidebarLineageParentIdentities,
  type SidebarLineageParentIdentities
} from '../../../shared/sidebar-list/worktree-lineage-projection'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { getIndexedAllWorktrees } from './worktree-repo-index'
import { selectWorktreesByRepo } from './workspace-record-selectors'
import type { AppState } from './types'
import type { Worktree } from '../../../shared/worktree/types'

type CrossStoreLineageInputs = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'worktreeLineageById'
  | 'crossStoreLineageByStoreKey'
  | 'ownLineageInstallationId'
  | 'runtimeStatusByEnvironmentId'
  | 'removedRuntimeEnvironmentIds'
>

function buildView(state: CrossStoreLineageInputs): CrossStoreLineageView {
  const { [OWN_LINEAGE_STORE_KEY]: own, ...paired } = state.crossStoreLineageByStoreKey
  return buildCrossStoreLineageView({
    own: { installationId: state.ownLineageInstallationId, crossStoreLineageByChildKey: own },
    statusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    removedEnvironmentIds: state.removedRuntimeEnvironmentIds,
    crossStoreLineageByEnvironmentId: new Map(Object.entries(paired))
  })
}

/** Status probes replace the status map often; only the stores' identities change resolution. */
function storeIdentityKey(view: CrossStoreLineageView): string {
  return JSON.stringify([...view].map(([key, store]) => [key, store.installationId ?? null]))
}

/** A store's identity as the viewer verified it: its own lineage list, or a paired server's descriptor. */
export function selectLineageStoreInstallationId(
  state: CrossStoreLineageInputs,
  storeKey: string
): string | undefined {
  return buildView(state).get(storeKey)?.installationId
}

let cached: {
  rowsByRepo: AppState['worktreesByRepo']
  worktreeLineageById: AppState['worktreeLineageById']
  crossStoreLineageByStoreKey: AppState['crossStoreLineageByStoreKey']
  identityKey: string
  parents: SidebarLineageParentIdentities
  crossStoreParents: SidebarLineageParentIdentities
} | null = null

/** Sidebar parents over every visible store, or undefined while no store holds a cross-store record
 * (the sidebar then resolves same-store parents exactly as before). */
export function selectSidebarLineageParentIdentities(
  state: CrossStoreLineageInputs
): SidebarLineageParentIdentities | undefined {
  return resolveLineageParents(state)?.parents
}

/** Only the resolved edges whose parent is in another store than its child; undefined with no records. */
export function selectCrossStoreLineageParentIdentities(
  state: CrossStoreLineageInputs
): SidebarLineageParentIdentities | undefined {
  return resolveLineageParents(state)?.crossStoreParents
}

function resolveLineageParents(
  state: CrossStoreLineageInputs
):
  | { parents: SidebarLineageParentIdentities; crossStoreParents: SidebarLineageParentIdentities }
  | undefined {
  // Partial store snapshots (tests, early boot) may lack the slice.
  if (
    !Object.values(state.crossStoreLineageByStoreKey ?? {}).some(
      (records) => Object.keys(records).length > 0
    )
  ) {
    return undefined
  }
  const view = buildView(state)
  const identityKey = storeIdentityKey(view)
  const worktreesByRepo = selectWorktreesByRepo(state)
  if (
    cached?.rowsByRepo === worktreesByRepo &&
    cached.worktreeLineageById === state.worktreeLineageById &&
    cached.crossStoreLineageByStoreKey === state.crossStoreLineageByStoreKey &&
    cached.identityKey === identityKey
  ) {
    return cached
  }
  const rows = new Map<string, Worktree>(
    getIndexedAllWorktrees(worktreesByRepo).map((row) => [getWorktreeHostIdentity(row), row])
  )
  const parents = resolveSidebarLineageParentIdentities(state.worktreeLineageById, rows, view)
  const crossStoreParents = new Map(
    [...parents].filter(([child, parent]) => {
      const childRow = rows.get(child)
      const parentRow = rows.get(parent)
      // Why: a hostless row names no store, so it never proves a cross-store edge.
      const childStore = childRow && lineageStoreKeyOfRow(childRow)
      const parentStore = parentRow && lineageStoreKeyOfRow(parentRow)
      return childStore !== undefined && parentStore !== undefined && childStore !== parentStore
    })
  )
  cached = {
    rowsByRepo: worktreesByRepo,
    worktreeLineageById: state.worktreeLineageById,
    crossStoreLineageByStoreKey: state.crossStoreLineageByStoreKey,
    identityKey,
    parents,
    crossStoreParents
  }
  return cached
}
