import {
  getRepoExecutionHostId,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type {
  DirectSshRepoOwner as RepoOwner,
  DirectSshTargetScopeInput,
  DirectSshWorktreeOwner as WorktreeOwner
} from './direct-ssh-target-scope-types'
import { indexDirectSshOwnerRows } from './direct-ssh-target-owner-index'
export type { DirectSshTargetScopeInput } from './direct-ssh-target-scope-types'

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
  const host = parseRoutableExecutionHostId(rawHostId)
  if (!host) {
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
    const parsedHost = parseRoutableExecutionHostId(row.hostId)
    if (row.hostId?.trim() && !parsedHost) {
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

/** Git worktrees whose owner evidence names exactly this SSH target; ambiguous or contradictory rows are left out. */
export function resolveDirectSshTargetWorktreeIds(input: DirectSshTargetScopeInput): Set<string> {
  const expectedHost = toSshExecutionHostId(input.targetId)
  const repoRowsById = indexDirectSshOwnerRows(input.repos)
  const worktreeIds = new Set<string>()
  for (const [worktreeId, rows] of collectWorktreeRows(input)) {
    const evidence = resolveWorktreeEvidence(input, rows, repoRowsById)
    if (!evidence.contradictory && !evidence.ambiguous && evidence.hosts.has(expectedHost)) {
      worktreeIds.add(worktreeId)
    }
  }
  return worktreeIds
}
