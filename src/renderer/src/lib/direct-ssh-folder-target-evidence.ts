import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type {
  DirectSshFolderOwner,
  DirectSshGroupOwner,
  DirectSshRepoOwner,
  DirectSshTargetScopeInput
} from './direct-ssh-target-scope-types'
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'
import {
  addDirectSshHostEvidence,
  newDirectSshHostEvidence,
  resolveDirectSshRepoEvidence,
  type DirectSshHostEvidence
} from './direct-ssh-owner-host-evidence'

function getFolderCandidateRepos(
  folder: DirectSshFolderOwner,
  groups: readonly DirectSshGroupOwner[],
  repos: readonly DirectSshRepoOwner[],
  scopeConnectionId: string | null,
  scopeHostId: ExecutionHostId | null
): DirectSshRepoOwner[] {
  const groupIds = getProjectGroupSubtreeIds(groups, folder.projectGroupId)
  const hostMatches = (repo: DirectSshRepoOwner): boolean =>
    !scopeHostId || getRepoExecutionHostId(repo) === scopeHostId
  const groupRepos = repos.filter(
    (repo) =>
      typeof repo.projectGroupId === 'string' &&
      groupIds.has(repo.projectGroupId) &&
      hostMatches(repo)
  )
  const pathRepos = repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(folder.folderPath, repo.path) &&
      hostMatches(repo)
  )
  if (scopeConnectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => (repo.connectionId ?? null) === scopeConnectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  const groupConnections = new Set(groupRepos.map((repo) => repo.connectionId ?? null))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnections.has(repo.connectionId ?? null))
  ]
}

export function resolveDirectSshFolderEvidence(
  input: DirectSshTargetScopeInput,
  folder: DirectSshFolderOwner,
  group: DirectSshGroupOwner | undefined
): DirectSshHostEvidence {
  const evidence = newDirectSshHostEvidence()
  const rawFolderHost = folder.executionHostId?.trim()
  const folderHost = parseExecutionHostId(rawFolderHost)
  if (rawFolderHost && !folderHost) {
    evidence.ambiguous = true
  }
  const rawGroupHost = group?.executionHostId?.trim()
  const groupHost = parseExecutionHostId(rawGroupHost)
  if (rawGroupHost && !groupHost) {
    evidence.ambiguous = true
  }
  const folderConnection = folder.connectionId?.trim() || null
  const groupConnection = group?.connectionId?.trim() || null
  const explicitLocal = folder.connectionId === null && !folderHost
  if (folderHost) {
    evidence.hosts.add(folderHost.id)
  } else if (groupHost?.kind === 'runtime') {
    evidence.hosts.add(groupHost.id)
  } else if (explicitLocal) {
    evidence.hosts.add(LOCAL_EXECUTION_HOST_ID)
  } else {
    if (folderConnection) {
      evidence.hosts.add(toSshExecutionHostId(folderConnection))
    }
    if (groupConnection) {
      evidence.hosts.add(toSshExecutionHostId(groupConnection))
    }
    addDirectSshHostEvidence(evidence, group?.executionHostId)
  }
  addDirectSshHostEvidence(
    evidence,
    input.restoredRuntimeHostIdByWorkspaceSessionKey?.[folderWorkspaceKey(folder.id)]
  )

  const scopeConnection =
    folderHost?.kind === 'ssh'
      ? folderHost.targetId
      : folderHost || groupHost?.kind === 'runtime' || explicitLocal
        ? null
        : (folderConnection ?? (groupHost?.kind === 'ssh' ? groupHost.targetId : groupConnection))
  const scopeHostId = resolveFolderWorkspaceExecutionHostId({
    folderWorkspace: folder,
    projectGroup: group
  })
  const candidateRepos = getFolderCandidateRepos(
    folder,
    input.projectGroups ?? [],
    input.repos,
    scopeConnection,
    scopeHostId
  )
  const repoOwnerKeys = new Set<string>()
  for (const repo of candidateRepos) {
    const repoEvidence = resolveDirectSshRepoEvidence(repo)
    evidence.ambiguous ||= repoEvidence.ambiguous
    evidence.contradictory ||= repoEvidence.contradictory
    for (const host of repoEvidence.hosts) {
      const ownerKey = JSON.stringify([repo.id, host])
      evidence.ambiguous ||= repoOwnerKeys.has(ownerKey)
      repoOwnerKeys.add(ownerKey)
      evidence.hosts.add(host)
    }
  }
  const hasSshOwner = [...evidence.hosts].some(
    (hostId) => parseExecutionHostId(hostId)?.kind === 'ssh'
  )
  const hasConnectionOwner =
    Boolean(scopeConnection) || candidateRepos.some((repo) => Boolean(repo.connectionId?.trim()))
  evidence.ambiguous ||= !group || (hasSshOwner && !hasConnectionOwner)
  evidence.contradictory ||= evidence.hosts.size > 1
  return evidence
}
