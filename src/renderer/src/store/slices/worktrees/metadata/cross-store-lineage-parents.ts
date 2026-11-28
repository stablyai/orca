import {
  buildCrossStoreLineageView,
  OWN_LINEAGE_STORE_KEY,
  type CrossStoreLineageView
} from '../../../../../../shared/worktree/lineage/cross-store-lineage-resolution'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getSidebarLineageParentsByIdentity,
  resolveSidebarLineageParentIdentities,
  type SidebarLineageParentIdentities
} from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { workspaceKeyOfRow } from '../../../../../../shared/worktree/lineage/lineage-row-identity'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { pickFolderLineageRecord } from '../../../../../../shared/worktree/lineage/folder-lineage-parents'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../../workspaces/catalog/workspace-record-fields'
import type { AppState } from '../../../types'
import type { RuntimeStatuses } from '../../runtime-status/views/runtime-status-owner'
import {
  buildRowsByHostIdentity,
  hasAnyOwnKey,
  hasCrossStoreRecords,
  hasFolderParentRecords,
  hasInlineParent,
  type CrossStoreLineageInputs
} from './cross-store-lineage-records'

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

type WorktreesByRepoMap = Record<string, Worktree[]>

type LineageCoreSnapshot = {
  worktreeMap: WorktreesByRepoMap
  worktreeLineageById: AppState['worktreeLineageById']
  crossStoreLineageByStoreKey: AppState['crossStoreLineageByStoreKey']
  workspaceLineageByChildKey: CrossStoreLineageInputs['workspaceLineageByChildKey']
  folders: readonly FolderWorkspace[] | undefined
}

let cached:
  | (LineageCoreSnapshot & { identityKey: string; parents: SidebarLineageParentIdentities })
  | null = null

let lastCall:
  | (LineageCoreSnapshot & {
      ownLineageInstallationId: AppState['ownLineageInstallationId']
      statuses: RuntimeStatuses
      removedRuntimeEnvironmentIds: AppState['removedRuntimeEnvironmentIds']
      result: SidebarLineageParentIdentities | undefined
    })
  | null = null

function matchesCore(
  prev: LineageCoreSnapshot,
  state: CrossStoreLineageInputs,
  worktreeMap: WorktreesByRepoMap,
  folders: readonly FolderWorkspace[] | undefined
): boolean {
  return (
    prev.worktreeMap === worktreeMap &&
    prev.worktreeLineageById === state.worktreeLineageById &&
    prev.crossStoreLineageByStoreKey === state.crossStoreLineageByStoreKey &&
    prev.workspaceLineageByChildKey === state.workspaceLineageByChildKey &&
    prev.folders === folders
  )
}

/** Sidebar parents over every visible store, folder workspaces included, or undefined while no store
 * holds a cross-store record or a folder workspace parent (the sidebar then resolves same-store
 * parents exactly as before). */
export function selectSidebarLineageParentIdentities(
  state: CrossStoreLineageInputs,
  statuses: RuntimeStatuses
): SidebarLineageParentIdentities | undefined {
  // Every subscriber runs this on unrelated writes; unchanged inputs skip the record scans.
  const worktreeMap = selectWorktreesByRepo(state)
  const folders = selectFolderWorkspaces(state)
  const previous = lastCall
  if (
    previous &&
    matchesCore(previous, state, worktreeMap, folders) &&
    previous.ownLineageInstallationId === state.ownLineageInstallationId &&
    previous.statuses === statuses &&
    previous.removedRuntimeEnvironmentIds === state.removedRuntimeEnvironmentIds
  ) {
    return previous.result
  }
  const result = resolveSidebarParents(state, statuses, worktreeMap, folders)
  lastCall = {
    worktreeMap,
    worktreeLineageById: state.worktreeLineageById,
    crossStoreLineageByStoreKey: state.crossStoreLineageByStoreKey,
    ownLineageInstallationId: state.ownLineageInstallationId,
    statuses,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    workspaceLineageByChildKey: state.workspaceLineageByChildKey,
    folders,
    result
  }
  return result
}

function resolveSidebarParents(
  state: CrossStoreLineageInputs,
  statuses: RuntimeStatuses,
  worktreeMap: WorktreesByRepoMap,
  folders: readonly FolderWorkspace[] | undefined
): SidebarLineageParentIdentities | undefined {
  const crossStore = hasCrossStoreRecords(state)
  const folderParents = hasFolderParentRecords(state, worktreeMap, folders)
  if (!crossStore && !folderParents) {
    return undefined
  }
  const view = crossStore ? buildView(state, statuses) : undefined
  const identityKey = view ? storeIdentityKey(view) : ''
  // Status probes churn the status map; only store identities change resolution.
  if (
    cached &&
    cached.identityKey === identityKey &&
    matchesCore(cached, state, worktreeMap, folders)
  ) {
    return cached.parents
  }
  const rows = buildRowsByHostIdentity(worktreeMap, folders)
  const workspaceLineage = state.workspaceLineageByChildKey ?? {}
  const parents = resolveSidebarLineageParentIdentities(
    state.worktreeLineageById,
    rows,
    view,
    folderParents
      ? (row) => pickFolderLineageRecord(workspaceLineage[workspaceKeyOfRow(row)], row)
      : undefined
  )
  cached = {
    worktreeMap,
    worktreeLineageById: state.worktreeLineageById,
    crossStoreLineageByStoreKey: state.crossStoreLineageByStoreKey,
    workspaceLineageByChildKey: state.workspaceLineageByChildKey,
    folders,
    identityKey,
    parents
  }
  return parents
}

type FolderChildrenInputs = CrossStoreLineageInputs & Pick<AppState, 'folderWorkspaces'>

const NO_SIDEBAR_CHILDREN: ReadonlyMap<string, readonly Worktree[]> = new Map()

let lastSidebarChildren: {
  parentIdentities: SidebarLineageParentIdentities | undefined
  worktreeMap: WorktreesByRepoMap
  folders: readonly FolderWorkspace[] | undefined
  worktreeLineageById: AppState['worktreeLineageById']
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
  const worktreeMap = selectWorktreesByRepo(state)
  const folders = selectFolderWorkspaces(state)
  const previous = lastSidebarChildren
  if (
    previous &&
    previous.parentIdentities === parentIdentities &&
    previous.worktreeMap === worktreeMap &&
    previous.folders === folders &&
    previous.worktreeLineageById === state.worktreeLineageById
  ) {
    return previous.result
  }
  const hasLineage =
    Boolean(parentIdentities) ||
    hasAnyOwnKey(state.worktreeLineageById) ||
    hasInlineParent(worktreeMap)
  let shared: ReadonlyMap<string, readonly Worktree[]> = NO_SIDEBAR_CHILDREN
  if (hasLineage) {
    const rows = buildRowsByHostIdentity(worktreeMap, folders)
    const result = new Map<string, Worktree[]>()
    for (const [identity, parent] of getSidebarLineageParentsByIdentity(
      state.worktreeLineageById,
      rows,
      parentIdentities
    )) {
      const child = rows.get(identity)!
      const parentIdentity = getWorktreeHostIdentity(parent)
      const siblings = result.get(parentIdentity)
      if (siblings) {
        siblings.push(child)
      } else {
        result.set(parentIdentity, [child])
      }
    }
    shared = shareUnchangedChildren(previous?.result, result)
  }
  lastSidebarChildren = {
    parentIdentities,
    worktreeMap,
    folders,
    worktreeLineageById: state.worktreeLineageById,
    result: shared
  }
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
