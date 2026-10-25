import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'

/** A purge target after normalization: a raw id, or one host's copy of it. */
export type WorktreePurgeTarget = Pick<Worktree, 'id' | 'hostId'>

/**
 * A raw id purges every bucket under it. A host target purges only that host's attributable
 * state while another host still publishes the id, and everything otherwise.
 */
export type WorktreePurgeTargets = readonly (string | HostWorktreeTarget)[]
