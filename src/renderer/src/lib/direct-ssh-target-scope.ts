import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type {
  DirectSshGitRepoRef,
  DirectSshRepoOwner as RepoOwner,
  DirectSshTargetScope,
  DirectSshTargetScopeInput,
  DirectSshWorktreeOwner as WorktreeOwner
} from './direct-ssh-target-scope-types'
import { indexDirectSshOwnerRows } from './direct-ssh-target-owner-index'
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'
import { resolveDirectSshFolderEvidence } from './direct-ssh-folder-target-evidence'
import {
  addDirectSshHostEvidence,
  newDirectSshHostEvidence,
  resolveDirectSshRepoEvidence,
  type DirectSshHostEvidence
} from './direct-ssh-owner-host-evidence'
export type {
  DirectSshGitRepoRef,
  DirectSshTargetScope,
  DirectSshTargetScopeInput
} from './direct-ssh-target-scope-types'

function collectWorktreeRows(input: DirectSshTargetScopeInput): Map<string, WorktreeOwner[]> {
  return indexDirectSshOwnerRows([
    ...Object.values(input.worktreesByRepo ?? {}).flat(),
    ...Object.values(input.detectedWorktreesByRepo ?? {}).flatMap((result) => result.worktrees)
  ])
}

function addRepoDerivedEvidence(
  evidence: DirectSshHostEvidence,
  repoRows: readonly RepoOwner[],
  explicitHosts: ReadonlySet<ExecutionHostId>
): void {
  const repoHosts = new Set<ExecutionHostId>()
  const repoHostCounts = new Map<ExecutionHostId, number>()
  let hasInvalidRepo = false
  for (const repo of repoRows) {
    const repoEvidence = resolveDirectSshRepoEvidence(repo)
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
): DirectSshHostEvidence {
  const evidence = newDirectSshHostEvidence()
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
  addDirectSshHostEvidence(evidence, restored?.[rows[0].id])
  addDirectSshHostEvidence(evidence, restored?.[worktreeWorkspaceKey(rows[0].id)])
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
    let group = groupRows[0]
    if (groupRows.length > 1) {
      const folderHostId = resolveFolderWorkspaceExecutionHostId({
        folderWorkspace: rows[0]
      })
      const matchingGroups = folderHostId
        ? groupRows.filter(
            (candidate) =>
              resolveFolderWorkspaceExecutionHostId({
                folderWorkspace: {},
                projectGroup: candidate
              }) === folderHostId
          )
        : []
      if (matchingGroups.length !== 1) {
        ambiguousOwnerCount++
        continue
      }
      group = matchingGroups[0]
    }
    const evidence = resolveDirectSshFolderEvidence(input, rows[0], group)
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
