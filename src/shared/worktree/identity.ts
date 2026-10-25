import type { ExecutionHostId } from '../execution-host'

/** Stable fields needed to identify one checkout occupant. */
export type WorktreeIdentityRef = {
  /** Existing repo/path locator; mutable when the folder moves. */
  worktreeId: string
  /** Host that owns execution for this checkout. */
  executionHostId: ExecutionHostId
  /** Durable identity for this checkout occupant. */
  instanceId: string
}
export type WorktreeIdentity = Omit<WorktreeIdentityRef, 'worktreeId'> & {
  key: string
}

/** Exclude the mutable locator so folder renames preserve occupant identity. */
export function canonicalWorktreeIdentity(ref: WorktreeIdentityRef): string {
  return `wt2:${encodeURIComponent(ref.executionHostId)}:${encodeURIComponent(ref.instanceId)}`
}
export function createWorktreeIdentity(ref: WorktreeIdentityRef): WorktreeIdentity {
  return {
    key: canonicalWorktreeIdentity(ref),
    executionHostId: ref.executionHostId,
    instanceId: ref.instanceId
  }
}
