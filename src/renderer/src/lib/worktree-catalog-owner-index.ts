import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

type FolderWorkspaceOwnerRecord = Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>

type IndexedCatalogOwnerResolution<T> = { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }

const folderWorkspaceOwnerIndexCache = new WeakMap<
  readonly FolderWorkspaceOwnerRecord[],
  ReadonlyMap<string, IndexedCatalogOwnerResolution<FolderWorkspaceOwnerRecord>>
>()
const projectGroupOwnerIndexCache = new WeakMap<
  readonly ProjectGroupOwnerRecord[],
  ReadonlyMap<string, IndexedCatalogOwnerResolution<ProjectGroupOwnerRecord>>
>()

export function getCatalogOwnerHostId(owner: {
  connectionId?: string | null
  executionHostId?: string | null
}): ExecutionHostId {
  const explicitHost = parseExecutionHostId(owner.executionHostId)
  if (explicitHost) {
    return explicitHost.id
  }
  const connectionId = owner.connectionId?.trim()
  return connectionId ? toSshExecutionHostId(connectionId) : 'local'
}

function buildCatalogOwnerIndex<
  T extends { id: string; connectionId?: string | null; executionHostId?: string | null }
>(records: readonly T[]): ReadonlyMap<string, IndexedCatalogOwnerResolution<T>> {
  const next = new Map<string, IndexedCatalogOwnerResolution<T>>()
  for (const record of records) {
    const id = record.id
    const hostId = getCatalogOwnerHostId(record)
    const current = next.get(id)
    if (!current) {
      next.set(id, { kind: 'resolved', owner: record })
    } else if (current.kind === 'resolved' && getCatalogOwnerHostId(current.owner) !== hostId) {
      next.set(id, { kind: 'ambiguous' })
    }
    next.set(`${id}\0${hostId}`, { kind: 'resolved', owner: record })
  }
  return next
}

export function findIndexedFolderWorkspaceOwner(
  folderWorkspaces: readonly FolderWorkspaceOwnerRecord[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): FolderWorkspaceOwnerRecord | null {
  if (!folderWorkspaces) {
    return null
  }
  let index = folderWorkspaceOwnerIndexCache.get(folderWorkspaces)
  if (!index) {
    index = buildCatalogOwnerIndex(folderWorkspaces)
    folderWorkspaceOwnerIndexCache.set(folderWorkspaces, index)
  }
  const resolution = index.get(
    executionHostId ? `${folderWorkspaceId}\0${executionHostId}` : folderWorkspaceId
  )
  return resolution?.kind === 'resolved' ? resolution.owner : null
}

export function findIndexedProjectGroupOwner(
  projectGroups: readonly ProjectGroupOwnerRecord[] | undefined,
  projectGroupId: string,
  executionHostId?: ExecutionHostId
): ProjectGroupOwnerRecord | null {
  if (!projectGroups) {
    return null
  }
  let index = projectGroupOwnerIndexCache.get(projectGroups)
  if (!index) {
    index = buildCatalogOwnerIndex(projectGroups)
    projectGroupOwnerIndexCache.set(projectGroups, index)
  }
  const resolution = index.get(
    executionHostId ? `${projectGroupId}\0${executionHostId}` : projectGroupId
  )
  return resolution?.kind === 'resolved' ? resolution.owner : null
}
