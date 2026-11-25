import {
  buildCrossStoreLineageView,
  OWN_LINEAGE_STORE_KEY,
  type CrossStoreLineageView
} from '../../../../../../shared/worktree/lineage/cross-store-lineage-resolution'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getSidebarLineageParentsByIdentity,
  resolveSidebarLineageParentIdentities,
  type SidebarLineageParentIdentities
} from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { workspaceKeyOfRow } from '../../../../../../shared/worktree/lineage/lineage-row-identity'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  pickFolderLineageRecord,
  readInlineFolderLineage
} from '../../../../../../shared/worktree/lineage/folder-lineage-parents'
import { getIndexedAllWorktrees } from '../listing/worktree-catalog-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../../workspaces/catalog/workspace-record-fields'
import type { AppState } from '../../../types'
import type { RuntimeStatuses } from '../../runtime-status/views/runtime-status-owner'

type CrossStoreLineageInputs = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'worktreeLineageById'
  | 'crossStoreLineageByStoreKey'
  | 'ownLineageInstallationId'
  | 'removedRuntimeEnvironmentIds'
> &
  Partial<Pick<AppState, 'workspaceLineageByChildKey' | 'folderWorkspaces'>>

function buildView(
  state: CrossStoreLineageInputs,
  statuses: RuntimeStatuses
): CrossStoreLineageView {
  const { [OWN_LINEAGE_STORE_KEY]: own, ...paired } = state.crossStoreLineageByStoreKey
  return buildCrossStoreLineageView({
    own: { installationId: state.ownLineageInstallationId, crossStoreLineageByChildKey: own },
    statusByEnvironmentId: statuses,
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
  statuses: RuntimeStatuses,
  storeKey: string
): string | undefined {
  return buildView(state, statuses).get(storeKey)?.installationId
}

let cached: {
  inputs: readonly unknown[]
  identityKey: string
  parents: SidebarLineageParentIdentities
} | null = null

/** Every resolution input, compared by identity to skip recomputation. */
function resolutionInputs(
  state: CrossStoreLineageInputs,
  statuses: RuntimeStatuses
): readonly unknown[] {
  return [
    selectWorktreesByRepo(state),
    state.worktreeLineageById,
    state.crossStoreLineageByStoreKey,
    state.ownLineageInstallationId,
    statuses,
    state.removedRuntimeEnvironmentIds,
    state.workspaceLineageByChildKey,
    selectFolderWorkspaces(state)
  ]
}

let lastCall: {
  inputs: readonly unknown[]
  result: SidebarLineageParentIdentities | undefined
} | null = null

/** Sidebar parents over every visible store, folder workspaces included, or undefined while no store
 * holds a cross-store record or a folder workspace parent (the sidebar then resolves same-store
 * parents exactly as before). */
export function selectSidebarLineageParentIdentities(
  state: CrossStoreLineageInputs,
  statuses: RuntimeStatuses
): SidebarLineageParentIdentities | undefined {
  // Every subscriber runs this on unrelated writes; unchanged inputs skip the record scans.
  const inputs = resolutionInputs(state, statuses)
  const previous = lastCall
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) {
    return previous.result
  }
  const result = resolveSidebarParents(state, statuses)
  lastCall = { inputs, result }
  return result
}

function hasCrossStoreRecords(state: CrossStoreLineageInputs): boolean {
  // Partial store snapshots (tests, early boot) may lack the slice.
  return Object.values(state.crossStoreLineageByStoreKey ?? {}).some(
    (records) => Object.keys(records).length > 0
  )
}

function hasFolderParentRecords(state: CrossStoreLineageInputs): boolean {
  if ((selectFolderWorkspaces(state)?.length ?? 0) === 0) {
    return false
  }
  return (
    Object.values(state.workspaceLineageByChildKey ?? {}).some((record) =>
      record.parentWorkspaceKey.startsWith('folder:')
    ) ||
    // A paired server reports each row's own folder parent, which the merged records can miss.
    getIndexedAllWorktrees(selectWorktreesByRepo(state)).some((row) =>
      Boolean(readInlineFolderLineage(row))
    )
  )
}

function resolveSidebarParents(
  state: CrossStoreLineageInputs,
  statuses: RuntimeStatuses
): SidebarLineageParentIdentities | undefined {
  const crossStore = hasCrossStoreRecords(state)
  const folderParents = hasFolderParentRecords(state)
  if (!crossStore && !folderParents) {
    return undefined
  }
  const view = crossStore ? buildView(state, statuses) : undefined
  const identityKey = view ? storeIdentityKey(view) : ''
  // Status probes churn the status map; only store identities change resolution.
  const inputs = [
    selectWorktreesByRepo(state),
    state.worktreeLineageById,
    state.crossStoreLineageByStoreKey,
    state.workspaceLineageByChildKey,
    selectFolderWorkspaces(state)
  ]
  if (
    cached?.identityKey === identityKey &&
    inputs.every((input, index) => input === cached?.inputs[index])
  ) {
    return cached.parents
  }
  const rows = new Map<string, Worktree>()
  for (const row of [
    ...getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    // Folder rows parent through their own records and through other stores' records.
    ...(selectFolderWorkspaces(state) ?? []).map((folder) => getFolderWorkspaceWorktree(folder))
  ]) {
    rows.set(getWorktreeHostIdentity(row), row)
  }
  const workspaceLineage = state.workspaceLineageByChildKey ?? {}
  const parents = resolveSidebarLineageParentIdentities(
    state.worktreeLineageById,
    rows,
    view,
    folderParents
      ? (row) => pickFolderLineageRecord(workspaceLineage[workspaceKeyOfRow(row)], row)
      : undefined
  )
  cached = { inputs, identityKey, parents }
  return parents
}

type FolderChildrenInputs = CrossStoreLineageInputs & Pick<AppState, 'folderWorkspaces'>

const NO_SIDEBAR_CHILDREN: ReadonlyMap<string, readonly Worktree[]> = new Map()

let lastSidebarChildren: {
  inputs: readonly unknown[]
  result: ReadonlyMap<string, readonly Worktree[]>
} | null = null

/** Every row's children under the parent the sidebar draws it beneath, by parent host identity, as
 * the folder panels and Bots section read them. Keyed on the resolved parents, so a status update
 * that keeps every store identity keeps this identity. */
export function selectSidebarChildrenByParentIdentity(
  state: FolderChildrenInputs,
  statuses: RuntimeStatuses
): ReadonlyMap<string, readonly Worktree[]> {
  const parentIdentities = selectSidebarLineageParentIdentities(state, statuses)
  const inputs = [
    parentIdentities,
    selectWorktreesByRepo(state),
    selectFolderWorkspaces(state),
    state.worktreeLineageById
  ]
  const previous = lastSidebarChildren
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) {
    return previous.result
  }
  const rows = new Map<string, Worktree>()
  for (const row of [
    ...getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    ...(selectFolderWorkspaces(state) ?? []).map((folder) => getFolderWorkspaceWorktree(folder))
  ]) {
    rows.set(getWorktreeHostIdentity(row), row)
  }
  const result = new Map<string, Worktree[]>()
  for (const [identity, parent] of getSidebarLineageParentsByIdentity(
    state.worktreeLineageById,
    rows,
    parentIdentities
  )) {
    const child = rows.get(identity)!
    const siblings = result.get(getWorktreeHostIdentity(parent))
    if (siblings) {
      siblings.push(child)
    } else {
      result.set(getWorktreeHostIdentity(parent), [child])
    }
  }
  const shared = shareUnchangedChildren(previous?.result, result)
  lastSidebarChildren = { inputs, result: shared }
  return shared
}

/** Worktree writes (activity bumps, unread flags) rebuild the rows; keep each unchanged child list,
 * and the whole map when none changed, so subscribers skip their re-render. */
function shareUnchangedChildren(
  previous: ReadonlyMap<string, readonly Worktree[]> | undefined,
  next: Map<string, readonly Worktree[]>
): ReadonlyMap<string, readonly Worktree[]> {
  if (next.size === 0) {
    return NO_SIDEBAR_CHILDREN
  }
  let changed = !previous || previous.size !== next.size
  for (const [parent, children] of next) {
    const before = previous?.get(parent)
    if (
      before?.length === children.length &&
      children.every((child, index) => child === before[index])
    ) {
      next.set(parent, before)
    } else {
      changed = true
    }
  }
  return changed || !previous ? next : previous
}
