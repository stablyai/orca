import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { WorkspaceCleanupCandidate } from './workspace-cleanup'

/** Host evidence a cleanup row carries; `worktreeId` alone repeats across hosts. */
export type WorkspaceCleanupHostFacts = {
  connectionId?: string | null
  executionHostId?: ExecutionHostId
}

export type WorkspaceCleanupIdentityFacts = WorkspaceCleanupHostFacts &
  Pick<WorkspaceCleanupCandidate, 'worktreeId'>

const WORKSPACE_CLEANUP_IDENTITY_SEPARATOR = '\0'

export function getWorkspaceCleanupCandidateHostId(
  candidate: WorkspaceCleanupHostFacts
): ExecutionHostId {
  return (
    resolveWorkspaceCleanupRemovalHostId(candidate) ??
    // Legacy display/index rows need a bucket; destructive removal must never use this fallback.
    LOCAL_EXECUTION_HOST_ID
  )
}

/** Require proven host ownership for removal. Old unqualified rows return null and must fail closed; guessing can delete another host’s uncommitted work (STA-4343). */
export function resolveWorkspaceCleanupRemovalHostId(
  candidate: WorkspaceCleanupHostFacts
): ExecutionHostId | null {
  const explicitHostId = normalizeExecutionHostId(candidate.executionHostId)
  if (explicitHostId) {
    return explicitHostId
  }
  const connectionId = candidate.connectionId?.trim()
  return connectionId ? toSshExecutionHostId(connectionId) : null
}

export function getWorkspaceCleanupHostIdentity(hostId: string, id: string): string {
  return `${hostId}${WORKSPACE_CLEANUP_IDENTITY_SEPARATOR}${id}`
}

/** Stable key for one row of one host — the identity every cleanup surface keys on. */
export function getWorkspaceCleanupCandidateIdentity(
  candidate: WorkspaceCleanupIdentityFacts
): string {
  return getWorkspaceCleanupHostIdentity(
    getWorkspaceCleanupCandidateHostId(candidate),
    candidate.worktreeId
  )
}

export function getWorkspaceCleanupIdentityWorktreeId(identity: string): string {
  const separatorIndex = identity.indexOf(WORKSPACE_CLEANUP_IDENTITY_SEPARATOR)
  return separatorIndex === -1
    ? identity
    : identity.slice(separatorIndex + WORKSPACE_CLEANUP_IDENTITY_SEPARATOR.length)
}
