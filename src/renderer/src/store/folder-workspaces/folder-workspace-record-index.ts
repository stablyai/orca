import { resolveQualifiedFolderWorkspaceResult } from '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import type {
  QualifiedFolderHostState,
  FolderHostWorkspace
} from '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { selectFolderWorkspaces } from '../workspaces/catalog/workspace-record-fields'

// ─── Keyed records ───────────────────────────────────────────────────

const folderRecordsById = new WeakMap<
  readonly FolderWorkspace[],
  ReadonlyMap<string, FolderWorkspace>
>()

/** Directory readers preserve catalog order, including unqualified twin rows. */
export function findFolderWorkspaceRecord(
  folderWorkspaces: readonly FolderWorkspace[],
  folderWorkspaceId: string,
  hostId?: ExecutionHostId
): FolderWorkspace | undefined {
  let index = folderRecordsById.get(folderWorkspaces)
  if (!index) {
    const rows = new Map<string, FolderWorkspace>()
    for (const folder of folderWorkspaces) {
      const id = folder.id
      for (const key of [id, `${id}\0${getRepoExecutionHostId(folder)}`]) {
        if (!rows.has(key)) {
          rows.set(key, folder)
        }
      }
    }
    index = rows
    folderRecordsById.set(folderWorkspaces, index)
  }
  return index.get(hostId ? `${folderWorkspaceId}\0${hostId}` : folderWorkspaceId)
}

const qualifiedFolderOwnerCache = new WeakMap<
  readonly FolderHostWorkspace[],
  {
    groups: QualifiedFolderHostState['projectGroups']
    repos: QualifiedFolderHostState['repos']
    rows: ReadonlyMap<string, readonly FolderHostWorkspace[]>
    positions: ReadonlyMap<FolderHostWorkspace, number>
    results: Map<string, ReturnType<typeof resolveQualifiedFolderWorkspaceResult>>
  }
>()

function qualifiedFolderCacheOf(
  state: QualifiedFolderHostState,
  folders: readonly FolderHostWorkspace[]
) {
  let cache = qualifiedFolderOwnerCache.get(folders)
  if (!cache || cache.groups !== state.projectGroups || cache.repos !== state.repos) {
    const rows = new Map<string, FolderHostWorkspace[]>()
    const positions = new Map<FolderHostWorkspace, number>()
    for (const [index, folder] of folders.entries()) {
      positions.set(folder, index)
      const id = folder.id
      const copies = rows.get(id) ?? []
      copies.push(folder)
      rows.set(id, copies)
    }
    cache = { groups: state.projectGroups, repos: state.repos, rows, positions, results: new Map() }
    qualifiedFolderOwnerCache.set(folders, cache)
  }
  return cache
}

const NO_FOLDER_COPIES: readonly FolderHostWorkspace[] = []

/** The catalog's copies of one folder id from the shared id index (one pass per catalog snapshot); the array is stable until the catalog changes. */
export function selectFolderWorkspaceCopies(
  state: QualifiedFolderHostState,
  folderWorkspaceId: string
): readonly FolderHostWorkspace[] {
  const folders = selectFolderWorkspaces(state)
  return folders
    ? (qualifiedFolderCacheOf(state, folders).rows.get(folderWorkspaceId) ?? NO_FOLDER_COPIES)
    : NO_FOLDER_COPIES
}

export function resolveQualifiedIndexedFolderWorkspace<W extends FolderHostWorkspace>(
  state: QualifiedFolderHostState<W>,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): ReturnType<typeof resolveQualifiedFolderWorkspaceResult<W>> {
  const folders = selectFolderWorkspaces(state)
  if (!folders) {
    return { kind: 'missing' }
  }
  const cache = qualifiedFolderCacheOf(state, folders)
  const key = executionHostId ? `${folderWorkspaceId}\0${executionHostId}` : folderWorkspaceId
  let result = cache.results.get(key)
  if (!result) {
    result = resolveQualifiedFolderWorkspaceResult(
      { ...state, folderWorkspaces: cache.rows.get(folderWorkspaceId) ?? [] },
      folderWorkspaceId,
      executionHostId
    )
    cache.results.set(key, result)
  }
  const positions = cache.positions
  const isCallerResult = (
    value: ReturnType<typeof resolveQualifiedFolderWorkspaceResult>
  ): value is ReturnType<typeof resolveQualifiedFolderWorkspaceResult<W>> =>
    value.kind !== 'selected' ||
    folders[positions.get(value.value.workspace) ?? -1] === value.value.workspace
  return isCallerResult(result)
    ? result
    : resolveQualifiedFolderWorkspaceResult(state, folderWorkspaceId, executionHostId)
}
