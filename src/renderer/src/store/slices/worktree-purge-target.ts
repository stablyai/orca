import type { Worktree } from '../../../../shared/worktree/types'

/** A purge target with optional host ownership for host-scoped state. */
export type WorktreePurgeTarget = Pick<Worktree, 'id' | 'hostId'>

/** Strings remain supported for callers that only have a raw worktree id. */
export type WorktreePurgeTargets = readonly (string | WorktreePurgeTarget)[]
