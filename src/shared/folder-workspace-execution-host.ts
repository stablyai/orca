/** Share host resolution between main dispatch and renderer projection. Workspace executionHostId pins override repo ownership.
 * Mixed-host scopes return ambiguous; callers must fail visibly rather than defaulting to local. */

import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { isPathInsideOrEqual } from './cross-platform-path'
import { getProjectGroupSubtreeIds } from './project-groups'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeHostPart,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'

export type FolderWorkspaceHostState = {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}

/** The fields host resolution reads, so a catalog read over the wire resolves the same way. */
export type FolderHostRepo = {
  path: string
  projectGroupId?: string | null
  connectionId?: string | null
  executionHostId?: string | null
}

export type FolderHostCatalog<R extends FolderHostRepo = Repo> = {
  folderWorkspaces: readonly (Pick<FolderWorkspace, 'id' | 'folderPath' | 'projectGroupId'> & {
    connectionId?: string | null
    executionHostId?: string | null
  })[]
  projectGroups: readonly (Pick<ProjectGroup, 'id'> & {
    parentGroupId: string | null
    connectionId?: string | null
    executionHostId?: string | null
  })[]
  repos: readonly R[]
}

export type FolderWorkspaceHost =
  | { kind: 'missing' }
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  // A paired server's folder; `sshTargetId` is that server's own target, addressable only with it.
  | { kind: 'runtime'; environmentId: string; sshTargetId: string | null }
  | { kind: 'ambiguous' }

/** Resolve legacy connectionId and unified SSH ownership in both candidate filters and the resolver; raw reads can discard SSH-only rows early.
 * Non-SSH hosts retain raw connectionId for runtime-nested targets, which require the environment to dial. */
function getRepoScopeConnectionId(repo: FolderHostRepo): string | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'ssh' ? host.targetId : normalizeHostPart(repo.connectionId)
}

function getFolderScopeCandidateRepos<R extends FolderHostRepo>(args: {
  folderPath: string
  projectGroupId: string
  connectionId: string | null
  projectGroups: FolderHostCatalog<R>['projectGroups']
  repos: readonly R[]
}): R[] {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  // Classify once rather than reading projectGroupId in two filters before the same path predicate.
  const groupRepos: R[] = []
  const pathRepos: R[] = []
  for (const repo of args.repos) {
    const projectGroupId = repo.projectGroupId
    if (typeof projectGroupId === 'string' && groupIds.has(projectGroupId)) {
      groupRepos.push(repo)
    } else if (isPathInsideOrEqual(args.folderPath, repo.path)) {
      pathRepos.push(repo)
    }
  }
  if (args.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => getRepoScopeConnectionId(repo) === args.connectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  // Resolve both sides or legacy/unified group comparisons diverge again.
  const groupConnectionIds = new Set(groupRepos.map(getRepoScopeConnectionId))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(getRepoScopeConnectionId(repo)))
  ]
}

export function findFolderWorkspaceCandidateRepos<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  folderWorkspaceId: string
): R[] {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return []
  }
  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  return getFolderScopeCandidateRepos({
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId: normalizeHostPart(workspace.connectionId ?? group?.connectionId),
    projectGroups: state.projectGroups,
    repos: state.repos
  })
}

export function resolveFolderWorkspaceHost<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  folderWorkspaceId: string
): FolderWorkspaceHost {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return { kind: 'missing' }
  }
  const readScopeConnectionId = (): string | null =>
    normalizeHostPart(
      workspace.connectionId ??
        state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId
    )
  const explicitHost = parseExecutionHostId(workspace.executionHostId)
  switch (explicitHost?.kind) {
    case 'ssh':
      return { kind: 'ssh', targetId: explicitHost.targetId }
    case 'runtime': {
      // Only an unambiguous folder id identifies which host’s nested target is selected.
      const isOnlyOwner = state.folderWorkspaces.every(
        (entry) => entry.id !== folderWorkspaceId || entry === workspace
      )
      return {
        kind: 'runtime',
        environmentId: explicitHost.environmentId,
        sshTargetId: isOnlyOwner ? readScopeConnectionId() : null
      }
    }
    case 'local':
      return { kind: 'local' }
    case undefined:
      break
  }
  const scopeConnectionId = readScopeConnectionId()
  const candidateRepos = findFolderWorkspaceCandidateRepos(state, folderWorkspaceId)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    const connectionId = getRepoScopeConnectionId(repo)
    if (connectionId) {
      connectionIds.add(connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (scopeConnectionId) {
    const hasDifferentSshConnection = [...connectionIds].some(
      (connectionId) => connectionId !== scopeConnectionId
    )
    return hasLocalRepo || hasDifferentSshConnection
      ? { kind: 'ambiguous' }
      : { kind: 'ssh', targetId: scopeConnectionId }
  }
  if (candidateRepos.length === 0 || connectionIds.size === 0) {
    return { kind: 'local' }
  }
  if (hasLocalRepo || connectionIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  return { kind: 'ssh', targetId: [...connectionIds][0] }
}

export function getFolderWorkspaceHostId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): ExecutionHostId {
  const explicitHostId = parseExecutionHostId(workspace.executionHostId)?.id
  if (explicitHostId) {
    return explicitHostId
  }
  if (workspace.connectionId) {
    return toSshExecutionHostId(workspace.connectionId)
  }
  let matchingHostId: ExecutionHostId | undefined
  for (const group of projectGroups) {
    if (group.id !== workspace.projectGroupId) {
      continue
    }
    const hostId = getRepoExecutionHostId(group)
    if (matchingHostId === undefined) {
      matchingHostId = hostId
    } else if (matchingHostId !== hostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
  }
  return matchingHostId ?? LOCAL_EXECUTION_HOST_ID
}
