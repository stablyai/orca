import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type {
  DirectSshFolderOwner as FolderOwner,
  DirectSshGitRepoRef,
  DirectSshGroupOwner as GroupOwner,
  DirectSshRepoOwner as RepoOwner,
  DirectSshTargetScope,
  DirectSshTargetScopeInput,
  DirectSshWorktreeOwner as WorktreeOwner
} from './direct-ssh-target-scope-types'
import { indexDirectSshOwnerRows } from './direct-ssh-target-owner-index'
export type {
  DirectSshGitRepoRef,
  DirectSshTargetScope,
  DirectSshTargetScopeInput
} from './direct-ssh-target-scope-types'

type HostEvidence = {
  hosts: Set<ExecutionHostId>
  ambiguous: boolean
  contradictory: boolean
}

function newHostEvidence(): HostEvidence {
  return { hosts: new Set(), ambiguous: false, contradictory: false }
}

function addHostEvidence(evidence: HostEvidence, rawHostId: string | null | undefined): void {
  if (!rawHostId?.trim()) {
    return
  }
  const host = parseExecutionHostId(rawHostId)
  if (!host) {
    evidence.ambiguous = true
    return
  }
  if (host.kind === 'runtime' && host.environmentId === 'unresolved-owner') {
    evidence.ambiguous = true
    return
  }
  evidence.hosts.add(host.id)
}

function resolveRepoEvidence(repo: RepoOwner): HostEvidence {
  const evidence = newHostEvidence()
  addHostEvidence(evidence, repo.executionHostId)
  if (repo.connectionId?.trim()) {
    evidence.hosts.add(toSshExecutionHostId(repo.connectionId.trim()))
  }
  evidence.hosts =
    evidence.hosts.size === 0 && !evidence.ambiguous
      ? new Set([getRepoExecutionHostId(repo)])
      : evidence.hosts
  evidence.contradictory = evidence.hosts.size > 1
  return evidence
}

function collectWorktreeRows(input: DirectSshTargetScopeInput): Map<string, WorktreeOwner[]> {
  return indexDirectSshOwnerRows([
    ...Object.values(input.worktreesByRepo ?? {}).flat(),
    ...Object.values(input.detectedWorktreesByRepo ?? {}).flatMap((result) => result.worktrees)
  ])
}

function addRepoDerivedEvidence(
  evidence: HostEvidence,
  repoRows: readonly RepoOwner[],
  explicitHosts: ReadonlySet<ExecutionHostId>
): void {
  const repoHosts = new Set<ExecutionHostId>()
  const repoHostCounts = new Map<ExecutionHostId, number>()
  let hasInvalidRepo = false
  for (const repo of repoRows) {
    const repoEvidence = resolveRepoEvidence(repo)
    hasInvalidRepo ||= repoEvidence.ambiguous
    evidence.contradictory ||= repoEvidence.contradictory
    for (const host of repoEvidence.hosts) {
      repoHosts.add(host)
      repoHostCounts.set(host, (repoHostCounts.get(host) ?? 0) + 1)
    }
  }
  if (explicitHosts.size > 0) {
    const exactHosts = [...explicitHosts].filter((host) => repoHosts.has(host))
    if (exactHosts.length > 0) {
      for (const host of exactHosts) {
        evidence.hosts.add(host)
        evidence.ambiguous ||= (repoHostCounts.get(host) ?? 0) > 1
      }
    } else if (repoHosts.size === 1) {
      evidence.hosts.add([...repoHosts][0])
    } else if (repoHosts.size > 1) {
      evidence.ambiguous = true
    }
  } else if (repoHosts.size === 1) {
    const repoHost = [...repoHosts][0]
    evidence.hosts.add(repoHost)
    evidence.ambiguous ||= (repoHostCounts.get(repoHost) ?? 0) > 1
  } else if (repoHosts.size > 1) {
    evidence.ambiguous = true
  }
  evidence.ambiguous ||= hasInvalidRepo
}

function resolveWorktreeEvidence(
  input: DirectSshTargetScopeInput,
  rows: readonly WorktreeOwner[],
  repoRowsById: ReadonlyMap<string, readonly RepoOwner[]>
): HostEvidence {
  const evidence = newHostEvidence()
  const repoIds = new Set(rows.map((row) => row.repoId))
  evidence.ambiguous ||= repoIds.size !== 1
  const explicitHosts = new Set<ExecutionHostId>()
  for (const row of rows) {
    const parsedHost = parseExecutionHostId(row.hostId)
    if (row.hostId?.trim() && !parsedHost) {
      evidence.ambiguous = true
    } else if (parsedHost?.kind === 'runtime' && parsedHost.environmentId === 'unresolved-owner') {
      evidence.ambiguous = true
    } else if (parsedHost) {
      explicitHosts.add(parsedHost.id)
      evidence.hosts.add(parsedHost.id)
    }
    const runtimeOwner = row.runtimeOwnerEnvironmentId?.trim()
    if (runtimeOwner) {
      evidence.hosts.add(toRuntimeExecutionHostId(runtimeOwner))
    }
  }
  for (const repoId of repoIds) {
    const repoRows = repoRowsById.get(repoId)
    if (repoRows) {
      addRepoDerivedEvidence(evidence, repoRows, explicitHosts)
    } else if (explicitHosts.size === 0) {
      evidence.ambiguous = true
    }
  }
  const restored = input.restoredRuntimeHostIdByWorkspaceSessionKey
  addHostEvidence(evidence, restored?.[rows[0].id])
  addHostEvidence(evidence, restored?.[worktreeWorkspaceKey(rows[0].id)])
  evidence.contradictory ||= evidence.hosts.size > 1
  return evidence
}

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
  input: DirectSshTargetScopeInput,
  folder: FolderOwner,
  group: GroupOwner | undefined
): HostEvidence {
  const evidence = newHostEvidence()
  const folderConnection = folder.connectionId?.trim() || null
  const groupConnection = group?.connectionId?.trim() || null
  if (folderConnection) {
    evidence.hosts.add(toSshExecutionHostId(folderConnection))
  }
  if (groupConnection) {
    evidence.hosts.add(toSshExecutionHostId(groupConnection))
  }
  addHostEvidence(evidence, group?.executionHostId)
  addHostEvidence(
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
    const repoEvidence = resolveRepoEvidence(repo)
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
      const evidence = resolveRepoEvidence(repo)
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
  for (const [worktreeId, rows] of collectWorktreeRows(input)) {
    const evidence = resolveWorktreeEvidence(input, rows, repoRowsById)
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
