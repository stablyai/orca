import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { indexDirectSshOwnerRows } from './direct-ssh-target-owner-index'
import type {
  DirectSshOwnerCatalog,
  DirectSshRepoOwner,
  DirectSshWorktreeOwner
} from './direct-ssh-target-scope-types'

export type DirectSshHostEvidence = {
  hosts: Set<ExecutionHostId>
  ambiguous: boolean
  contradictory: boolean
}

export function createDirectSshHostEvidence(): DirectSshHostEvidence {
  return { hosts: new Set(), ambiguous: false, contradictory: false }
}

export function addDirectSshHostEvidence(
  evidence: DirectSshHostEvidence,
  rawHostId: string | null | undefined
): void {
  if (!rawHostId?.trim()) {
    return
  }
  const host = parseExecutionHostId(rawHostId)
  if (!host || (host.kind === 'runtime' && host.environmentId === 'unresolved-owner')) {
    evidence.ambiguous = true
    return
  }
  evidence.hosts.add(host.id)
}

export function resolveDirectSshRepoEvidence(repo: DirectSshRepoOwner): DirectSshHostEvidence {
  const evidence = createDirectSshHostEvidence()
  addDirectSshHostEvidence(evidence, repo.executionHostId)
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

function addRepoDerivedEvidence(
  evidence: DirectSshHostEvidence,
  repos: readonly DirectSshRepoOwner[],
  explicitHosts: ReadonlySet<ExecutionHostId>
): void {
  const repoHosts = new Set<ExecutionHostId>()
  const hostCounts = new Map<ExecutionHostId, number>()
  let hasInvalidRepo = false
  for (const repo of repos) {
    const repoEvidence = resolveDirectSshRepoEvidence(repo)
    hasInvalidRepo ||= repoEvidence.ambiguous
    evidence.contradictory ||= repoEvidence.contradictory
    for (const host of repoEvidence.hosts) {
      repoHosts.add(host)
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1)
    }
  }
  if (explicitHosts.size > 0) {
    const exactHosts = [...explicitHosts].filter((host) => repoHosts.has(host))
    if (exactHosts.length > 0) {
      for (const host of exactHosts) {
        evidence.hosts.add(host)
        evidence.ambiguous ||= (hostCounts.get(host) ?? 0) > 1
      }
    } else if (repoHosts.size === 1) {
      evidence.hosts.add([...repoHosts][0])
    } else if (repoHosts.size > 1) {
      evidence.ambiguous = true
    }
  } else if (repoHosts.size === 1) {
    const repoHost = [...repoHosts][0]
    evidence.hosts.add(repoHost)
    evidence.ambiguous ||= (hostCounts.get(repoHost) ?? 0) > 1
  } else if (repoHosts.size > 1) {
    evidence.ambiguous = true
  }
  evidence.ambiguous ||= hasInvalidRepo
}

function resolveWorktreeEvidence(
  input: DirectSshOwnerCatalog,
  rows: readonly DirectSshWorktreeOwner[],
  reposById: ReadonlyMap<string, readonly DirectSshRepoOwner[]>
): DirectSshHostEvidence {
  const evidence = createDirectSshHostEvidence()
  const repoIds = new Set(rows.map((row) => row.repoId))
  evidence.ambiguous ||= repoIds.size !== 1
  const explicitHosts = new Set<ExecutionHostId>()
  for (const row of rows) {
    const host = parseExecutionHostId(row.hostId)
    if (
      (row.hostId?.trim() && !host) ||
      (host?.kind === 'runtime' && host.environmentId === 'unresolved-owner')
    ) {
      evidence.ambiguous = true
    } else if (host) {
      explicitHosts.add(host.id)
      evidence.hosts.add(host.id)
    }
    const runtimeOwner = row.runtimeOwnerEnvironmentId?.trim()
    if (runtimeOwner) {
      evidence.hosts.add(toRuntimeExecutionHostId(runtimeOwner))
    }
  }
  for (const repoId of repoIds) {
    const repos = reposById.get(repoId)
    if (repos) {
      addRepoDerivedEvidence(evidence, repos, explicitHosts)
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

export function resolveDirectSshWorktreeEvidenceById(
  input: DirectSshOwnerCatalog
): Map<string, DirectSshHostEvidence> {
  const reposById = indexDirectSshOwnerRows(input.repos)
  const rows = indexDirectSshOwnerRows([
    ...Object.values(input.worktreesByRepo ?? {}).flat(),
    ...Object.values(input.detectedWorktreesByRepo ?? {}).flatMap((result) => result.worktrees)
  ])
  return new Map(
    [...rows].map(([worktreeId, owners]) => [
      worktreeId,
      resolveWorktreeEvidence(input, owners, reposById)
    ])
  )
}
