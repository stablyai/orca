import {
  buildCrossStoreLineageView,
  OWN_LINEAGE_STORE_KEY,
  resolveCrossStoreLineageParents,
  type CrossStoreLineageView
} from '../../../../../../shared/worktree/lineage/cross-store-lineage-resolution'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  resolveSidebarLineageParentIdentities,
  type SidebarLineageParentIdentities
} from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
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

type CrossStoreLineageInputs = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'worktreeLineageById'
  | 'crossStoreLineageByStoreKey'
  | 'ownLineageInstallationId'
  | 'runtimeStatusByEnvironmentId'
  | 'removedRuntimeEnvironmentIds'
> &
  Partial<Pick<AppState, 'workspaceLineageByChildKey' | 'folderWorkspaces'>>

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
  inputs: readonly unknown[]
  identityKey: string
  parents: SidebarLineageParentIdentities
} | null = null

/** Every resolution input, compared by identity to skip recomputation. */
function resolutionInputs(state: CrossStoreLineageInputs): readonly unknown[] {
  return [
    selectWorktreesByRepo(state),
    state.worktreeLineageById,
    state.crossStoreLineageByStoreKey,
    state.ownLineageInstallationId,
    state.runtimeStatusByEnvironmentId,
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
  state: CrossStoreLineageInputs
): SidebarLineageParentIdentities | undefined {
  // Every subscriber runs this on unrelated writes; unchanged inputs skip the record scans.
  const inputs = resolutionInputs(state)
  const previous = lastCall
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) {
    return previous.result
  }
  const result = resolveSidebarParents(state)
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
  state: CrossStoreLineageInputs
): SidebarLineageParentIdentities | undefined {
  const crossStore = hasCrossStoreRecords(state)
  const folderParents = hasFolderParentRecords(state)
  if (!crossStore && !folderParents) {
    return undefined
  }
  const view = crossStore ? buildView(state) : undefined
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
      ? (row) => pickFolderLineageRecord(workspaceLineage[worktreeWorkspaceKey(row.id)], row)
      : undefined
  )
  cached = { inputs, identityKey, parents }
  return parents
}

type FolderChildrenInputs = CrossStoreLineageInputs & Pick<AppState, 'folderWorkspaces'>

const NO_FOLDER_CHILDREN: ReadonlyMap<string, readonly Worktree[]> = new Map()

let lastFolderChildrenCall: {
  inputs: readonly unknown[]
  result: ReadonlyMap<string, readonly Worktree[]>
} | null = null

/** Workspaces in other stores whose saved parent is a folder workspace, by folder workspace id.
 * The folder panels list them with the folder's own children. */
export function selectCrossStoreFolderChildrenById(
  state: FolderChildrenInputs
): ReadonlyMap<string, readonly Worktree[]> {
  const inputs = [...resolutionInputs(state), selectFolderWorkspaces(state)]
  const previous = lastFolderChildrenCall
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) {
    return previous.result
  }
  const result = resolveFolderChildren(state)
  lastFolderChildrenCall = { inputs, result }
  return result
}

function resolveFolderChildren(
  state: FolderChildrenInputs
): ReadonlyMap<string, readonly Worktree[]> {
  const folderWorkspaces = selectFolderWorkspaces(state) ?? []
  if (folderWorkspaces.length === 0 || !hasCrossStoreRecords(state)) {
    return NO_FOLDER_CHILDREN
  }
  const folderIdByRow = new Map(
    folderWorkspaces.map((folder) => [getFolderWorkspaceWorktree(folder), folder.id])
  )
  const rows = new Map<string, Worktree>()
  for (const row of [
    ...getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    ...folderIdByRow.keys()
  ]) {
    rows.set(getWorktreeHostIdentity(row), row)
  }
  const childrenById = new Map<string, Worktree[]>()
  for (const [childIdentity, parent] of resolveCrossStoreLineageParents(rows, buildView(state))) {
    const folderId = folderIdByRow.get(parent)
    const child = rows.get(childIdentity)
    if (folderId === undefined || !child || child.isArchived) {
      continue
    }
    childrenById.set(folderId, [...(childrenById.get(folderId) ?? []), child])
  }
  return childrenById.size > 0 ? childrenById : NO_FOLDER_CHILDREN
}
