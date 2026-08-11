import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import { buildCatalogOwnerIndex } from '../../lib/catalog-owner-index'
import { resolveFolderWorkspaceExecutionHostId } from '../../lib/folder-workspace-execution-host'
import {
  resolveFolderWorkspacePathStatusSourceHostId,
  resolveProjectGroupPathStatusSourceHostId,
  resolveRepoPathStatusSourceHostId
} from '../../lib/folder-workspace-path-status-request'

type CatalogOwner = Pick<
  ProjectGroup | FolderWorkspace,
  'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
>

type OwnerStamp = {
  transportHostId: ExecutionHostId
  sourceHostId: ExecutionHostId | null
  token: string
}

export type SidebarProjectGroupOwnerIndex = {
  groups: readonly ProjectGroup[]
  findFolderProjectGroup: (folderWorkspace: FolderWorkspace) => ProjectGroup | null
  findRepoProjectGroup: (repo: Repo) => ProjectGroup | null
  getProjectGroupsForRepo: (repo: Repo) => readonly ProjectGroup[]
  findParentProjectGroup: (group: ProjectGroup) => ProjectGroup | null
  getHeaderKey: (group: ProjectGroup) => string
  getOwnerToken: (group: ProjectGroup) => string | null
  isDuplicateId: (groupId: string) => boolean
  findByHeaderKey: (headerKey: string) => ProjectGroup | null
}

export function getReorderableSidebarProjectGroupsById(
  ownerIndex: SidebarProjectGroupOwnerIndex
): ReadonlyMap<string, ProjectGroup> {
  const groups = ownerIndex.groups.filter((group) => {
    if (ownerIndex.isDuplicateId(group.id)) {
      return false
    }
    const parent = ownerIndex.findParentProjectGroup(group)
    return !parent || !ownerIndex.isDuplicateId(parent.id)
  })
  return new Map(groups.map((group) => [group.id, group]))
}

function connectionHostId(connectionId: string | null | undefined): ExecutionHostId | null {
  if (connectionId === null) {
    return 'local'
  }
  const normalized = connectionId?.trim()
  return normalized ? toSshExecutionHostId(normalized) : null
}

function hasInvalidOwnerMetadata(owner: CatalogOwner): boolean {
  const executionHost = parseExecutionHostId(owner.executionHostId)
  const sourceHost = parseExecutionHostId(owner.runtimeSourceExecutionHostId)
  const connectionHost = connectionHostId(owner.connectionId)
  if (
    (owner.executionHostId != null && !executionHost) ||
    (owner.runtimeSourceExecutionHostId != null && !sourceHost) ||
    (owner.connectionId !== undefined && !connectionHost)
  ) {
    return true
  }
  const physicalHosts = new Set<ExecutionHostId>()
  if (sourceHost) {
    physicalHosts.add(sourceHost.id)
  }
  if (connectionHost) {
    physicalHosts.add(connectionHost)
  }
  if (executionHost && executionHost.kind !== 'runtime') {
    physicalHosts.add(executionHost.id)
  }
  return physicalHosts.size > 1
}

function getGroupOwnerStamp(group: ProjectGroup): OwnerStamp | null {
  if (hasInvalidOwnerMetadata(group)) {
    return null
  }
  const transportHostId = resolveFolderWorkspaceExecutionHostId({
    folderWorkspace: {},
    projectGroup: group,
    fallbackHostId: 'local'
  })
  if (!transportHostId) {
    return null
  }
  const sourceHostId = resolveProjectGroupPathStatusSourceHostId(group)
  return {
    transportHostId,
    sourceHostId,
    token: JSON.stringify([transportHostId, sourceHostId])
  }
}

function getFolderDeclaredHostIds(folderWorkspace: FolderWorkspace): ExecutionHostId[] {
  if (hasInvalidOwnerMetadata(folderWorkspace)) {
    return []
  }
  const hostIds = new Set<ExecutionHostId>()
  const sourceHostId = resolveFolderWorkspacePathStatusSourceHostId(folderWorkspace)
  const transportHostId = resolveFolderWorkspaceExecutionHostId({ folderWorkspace })
  if (transportHostId) {
    hostIds.add(transportHostId)
  }
  if (sourceHostId) {
    hostIds.add(sourceHostId)
  }
  return [...hostIds]
}

function getRepoDeclaredHostIds(repo: Repo): ExecutionHostId[] {
  const transportHostId = getRepoExecutionHostId(repo)
  const sourceHostId = resolveRepoPathStatusSourceHostId(repo)
  if (!sourceHostId) {
    return []
  }
  return sourceHostId === transportHostId ? [transportHostId] : [transportHostId, sourceHostId]
}

function findGroupForHostIds(
  catalogIndex: ReturnType<typeof buildCatalogOwnerIndex<ProjectGroup>>,
  validGroupSet: ReadonlySet<ProjectGroup>,
  groupId: string,
  hostIds: readonly ExecutionHostId[]
): ProjectGroup | null {
  for (const hostId of hostIds) {
    const resolution = catalogIndex.get(`${groupId}\0${hostId}`)
    if (resolution?.kind === 'resolved' && validGroupSet.has(resolution.owner)) {
      return resolution.owner
    }
  }
  return null
}

function folderMatchesGroup(folderWorkspace: FolderWorkspace, group: ProjectGroup): boolean {
  const stamp = getGroupOwnerStamp(group)
  if (!stamp || hasInvalidOwnerMetadata(folderWorkspace)) {
    return false
  }
  const transportHostId = resolveFolderWorkspaceExecutionHostId({
    folderWorkspace,
    projectGroup: group,
    fallbackHostId: 'local'
  })
  if (transportHostId !== stamp.transportHostId) {
    return false
  }
  const folderSourceHostId = resolveFolderWorkspacePathStatusSourceHostId(folderWorkspace)
  return !folderSourceHostId || !stamp.sourceHostId || folderSourceHostId === stamp.sourceHostId
}

function qualifiedRowKey(prefix: string, id: string, ownerToken: string): string {
  return `${prefix}:${id}:owner:${encodeURIComponent(ownerToken)}`
}

export function getFolderWorkspaceRowKey(
  folderWorkspace: FolderWorkspace,
  group: ProjectGroup,
  duplicateFolderWorkspaceIds: ReadonlySet<string>,
  groupOwnerIndex: SidebarProjectGroupOwnerIndex
): string | null {
  const ownerToken = groupOwnerIndex.getOwnerToken(group)
  if (!ownerToken || !folderMatchesGroup(folderWorkspace, group)) {
    return null
  }
  return duplicateFolderWorkspaceIds.has(folderWorkspace.id)
    ? qualifiedRowKey('folder-workspace', folderWorkspace.id, ownerToken)
    : `folder-workspace:${folderWorkspace.id}`
}

export function buildSidebarProjectGroupOwnerIndex(
  projectGroups: readonly ProjectGroup[]
): SidebarProjectGroupOwnerIndex {
  const catalogIndex = buildCatalogOwnerIndex(projectGroups)
  const groupStamp = new WeakMap<ProjectGroup, OwnerStamp>()
  const groupsByIdentity = new Map<string, ProjectGroup[]>()
  for (const group of projectGroups) {
    const stamp = getGroupOwnerStamp(group)
    if (!stamp) {
      continue
    }
    groupStamp.set(group, stamp)
    const identity = `${group.id}\0${stamp.token}`
    const identityGroups = groupsByIdentity.get(identity) ?? []
    identityGroups.push(group)
    groupsByIdentity.set(identity, identityGroups)
  }
  const groups = [...groupsByIdentity.values()].flatMap((matches) =>
    matches.length === 1 ? matches : []
  )
  const validGroupSet = new Set(groups)
  const validGroupsById = new Map<string, ProjectGroup[]>()
  for (const group of groups) {
    const list = validGroupsById.get(group.id) ?? []
    list.push(group)
    validGroupsById.set(group.id, list)
  }
  const duplicateIds = new Set(
    [...validGroupsById].filter(([, matches]) => matches.length > 1).map(([id]) => id)
  )
  const headerKeyByGroup = new WeakMap<ProjectGroup, string>()
  const groupByHeaderKey = new Map<string, ProjectGroup>()
  for (const group of groups) {
    const stamp = groupStamp.get(group)!
    const key = duplicateIds.has(group.id)
      ? qualifiedRowKey('project-group', group.id, stamp.token)
      : `project-group:${group.id}`
    headerKeyByGroup.set(group, key)
    groupByHeaderKey.set(key, group)
  }

  const findFolderProjectGroup = (folderWorkspace: FolderWorkspace): ProjectGroup | null => {
    if (hasInvalidOwnerMetadata(folderWorkspace)) {
      return null
    }
    const declaredOwner = findGroupForHostIds(
      catalogIndex,
      validGroupSet,
      folderWorkspace.projectGroupId,
      getFolderDeclaredHostIds(folderWorkspace)
    )
    if (declaredOwner && folderMatchesGroup(folderWorkspace, declaredOwner)) {
      return declaredOwner
    }
    const matches = (validGroupsById.get(folderWorkspace.projectGroupId) ?? []).filter((group) =>
      folderMatchesGroup(folderWorkspace, group)
    )
    return matches.length === 1 ? matches[0]! : null
  }
  const findRepoProjectGroup = (repo: Repo): ProjectGroup | null => {
    if (!repo.projectGroupId) {
      return null
    }
    return findGroupForHostIds(
      catalogIndex,
      validGroupSet,
      repo.projectGroupId,
      getRepoDeclaredHostIds(repo)
    )
  }
  const getProjectGroupsForRepo = (repo: Repo): readonly ProjectGroup[] => {
    const ids = new Set(groups.map((group) => group.id))
    const matches: ProjectGroup[] = []
    for (const id of ids) {
      const match = findGroupForHostIds(
        catalogIndex,
        validGroupSet,
        id,
        getRepoDeclaredHostIds(repo)
      )
      if (match) {
        matches.push(match)
      }
    }
    return matches
  }
  const findParentProjectGroup = (group: ProjectGroup): ProjectGroup | null => {
    if (!group.parentGroupId) {
      return null
    }
    const stamp = groupStamp.get(group)
    if (!stamp) {
      return null
    }
    const matches = (validGroupsById.get(group.parentGroupId) ?? []).filter(
      (candidate) => groupStamp.get(candidate)?.token === stamp.token
    )
    return matches.length === 1 ? matches[0]! : null
  }

  return {
    groups,
    findFolderProjectGroup,
    findRepoProjectGroup,
    getProjectGroupsForRepo,
    findParentProjectGroup,
    getHeaderKey: (group) => headerKeyByGroup.get(group) ?? `project-group:${group.id}`,
    getOwnerToken: (group) => groupStamp.get(group)?.token ?? null,
    isDuplicateId: (groupId) => duplicateIds.has(groupId),
    findByHeaderKey: (headerKey) => groupByHeaderKey.get(headerKey) ?? null
  }
}
