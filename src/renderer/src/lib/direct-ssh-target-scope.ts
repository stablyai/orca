import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type {
  DirectSshFolderOwner as FolderOwner,
  DirectSshGitRepoRef,
  DirectSshGroupOwner as GroupOwner,
  DirectSshOwnerCatalog,
  DirectSshRepoOwner as RepoOwner,
  DirectSshTargetScope,
  DirectSshTargetScopeInput
} from './direct-ssh-target-scope-types'
import { indexDirectSshOwnerRows } from './direct-ssh-target-owner-index'
import {
  addDirectSshHostEvidence,
  createDirectSshHostEvidence,
  resolveDirectSshRepoEvidence,
  resolveDirectSshWorktreeEvidenceById,
  type DirectSshHostEvidence as HostEvidence
} from './direct-ssh-worktree-owner-evidence'
export type {
  DirectSshGitRepoRef,
  DirectSshOwnerCatalog,
  DirectSshTargetScope,
  DirectSshTargetScopeInput
} from './direct-ssh-target-scope-types'

function getFolderCandidateRepos(
  folder: FolderOwner,
  groups: readonly GroupOwner[],
  repos: readonly RepoOwner[],
  scopeConnectionId: string | null
): RepoOwner[] {
  const groupIds = getProjectGroupSubtreeIds(groups, folder.projectGroupId)
  const groupRepos = repos.filter(
    (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
  )
  const pathRepos = repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(folder.folderPath, repo.path)
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

function resolveFolderEvidence(
  input: DirectSshOwnerCatalog,
  folder: FolderOwner,
  group: GroupOwner | undefined
): HostEvidence {
  const evidence = createDirectSshHostEvidence()
  const folderConnection = folder.connectionId?.trim() || null
  const groupConnection = group?.connectionId?.trim() || null
  if (folderConnection) {
    evidence.hosts.add(toSshExecutionHostId(folderConnection))
  }
  if (groupConnection) {
    evidence.hosts.add(toSshExecutionHostId(groupConnection))
  }
  addDirectSshHostEvidence(evidence, group?.executionHostId)
  addDirectSshHostEvidence(
    evidence,
    input.restoredRuntimeHostIdByWorkspaceSessionKey?.[folderWorkspaceKey(folder.id)]
  )

  const scopeConnection = folderConnection ?? groupConnection
  const candidateRepos = getFolderCandidateRepos(
    folder,
    input.projectGroups ?? [],
    input.repos,
    scopeConnection
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

export function resolveDirectSshTargetScope(
  input: DirectSshTargetScopeInput
): DirectSshTargetScope {
  const expectedHost = toSshExecutionHostId(input.targetId)
  const repoRowsById = indexDirectSshOwnerRows(input.repos)
  const gitRepos: DirectSshGitRepoRef[] = []
  let ambiguousOwnerCount = 0
  let contradictoryOwnerCount = 0

  for (const [repoId, rows] of repoRowsById) {
    const matchingRows = rows.filter((repo) => {
      const evidence = resolveDirectSshRepoEvidence(repo)
      if (evidence.contradictory) {
        contradictoryOwnerCount++
        return false
      }
      if (evidence.ambiguous) {
        ambiguousOwnerCount++
        return false
      }
      return evidence.hosts.has(expectedHost)
    })
    if (matchingRows.length === 1) {
      gitRepos.push({ repoId, executionHostId: expectedHost })
    } else if (matchingRows.length > 1) {
      ambiguousOwnerCount++
    }
  }

  const gitWorktreeIds = new Set<string>()
  const terminalWorkspaceKeys = new Set<string>()
  const lineageWorkspaceKeys = new Set<ReturnType<typeof worktreeWorkspaceKey>>()
  for (const [worktreeId, evidence] of resolveDirectSshWorktreeEvidenceById(input)) {
    if (evidence.contradictory) {
      contradictoryOwnerCount++
    } else if (evidence.ambiguous || evidence.hosts.size === 0) {
      ambiguousOwnerCount++
    } else if (evidence.hosts.has(expectedHost)) {
      gitWorktreeIds.add(worktreeId)
      terminalWorkspaceKeys.add(worktreeId)
      lineageWorkspaceKeys.add(worktreeWorkspaceKey(worktreeId))
    }
  }

  const folderRowsById = indexDirectSshOwnerRows(input.folderWorkspaces ?? [])
  const groupRowsById = indexDirectSshOwnerRows(input.projectGroups ?? [])
  for (const [folderId, rows] of folderRowsById) {
    if (rows.length !== 1) {
      ambiguousOwnerCount++
      continue
    }
    const groupRows = groupRowsById.get(rows[0].projectGroupId) ?? []
    if (groupRows.length > 1) {
      ambiguousOwnerCount++
      continue
    }
    const evidence = resolveFolderEvidence(input, rows[0], groupRows[0])
    if (evidence.contradictory) {
      contradictoryOwnerCount++
    } else if (evidence.ambiguous || evidence.hosts.size === 0) {
      ambiguousOwnerCount++
    } else if (evidence.hosts.has(expectedHost)) {
      const workspaceKey = folderWorkspaceKey(folderId)
      terminalWorkspaceKeys.add(workspaceKey)
      lineageWorkspaceKeys.add(workspaceKey)
    }
  }

  return {
    catalogRevision: input.catalogRevision,
    gitRepos,
    gitWorktreeIds,
    terminalWorkspaceKeys,
    lineageWorkspaceKeys,
    ambiguousOwnerCount,
    contradictoryOwnerCount
  }
}

export function resolveDirectSshGitWorktreeTargetIds(
  input: DirectSshOwnerCatalog
): Map<string, string> {
  const targetIdByWorktree = new Map<string, string>()
  for (const [worktreeId, evidence] of resolveDirectSshWorktreeEvidenceById(input)) {
    if (evidence.ambiguous || evidence.contradictory || evidence.hosts.size !== 1) {
      continue
    }
    const owner = parseExecutionHostId([...evidence.hosts][0])
    if (owner?.kind === 'ssh') {
      targetIdByWorktree.set(worktreeId, owner.targetId)
    }
  }
  return targetIdByWorktree
}
