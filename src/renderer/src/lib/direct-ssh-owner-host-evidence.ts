import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { DirectSshRepoOwner } from './direct-ssh-target-scope-types'

export type DirectSshHostEvidence = {
  hosts: Set<ExecutionHostId>
  ambiguous: boolean
  contradictory: boolean
}

export function newDirectSshHostEvidence(): DirectSshHostEvidence {
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
  const evidence = newDirectSshHostEvidence()
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
