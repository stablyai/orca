import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'

/** Host evidence a cleanup row carries; `worktreeId` alone repeats across hosts. */
export type WorkspaceCleanupHostFacts = {
  connectionId?: string | null
  executionHostId?: ExecutionHostId
}

/**
 * The owner a destructive removal is allowed to target, or null when the row
 * carries no host evidence at all (a snapshot or publisher that predates
 * host-qualified candidates). Callers must fail closed on null instead of
 * guessing — a wrong guess deletes another host's uncommitted work (STA-4343).
 */
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
