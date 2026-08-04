// Aquarium Reap IPC contract (T7/T8 closure): the backend disposal path the
// Aquarium panel's Reap verb invokes. The renderer passes only worktree
// identities (repo path + worktree path); the server RE-DERIVES ownership and
// guard state and refuses anything it would not own — the client-side deny
// gate is UX only and is never trusted here.
//
// Disposal sequence per allowed worktree (validated on disk 2026-08-03):
//   git worktree remove --force <path>   # evaporates a prunable/ghost
//   git worktree prune                   # drops the orphaned .git/worktrees/<n> stub
// This mirrors the tested `removeWorktree` primitive plus the inline prune
// already used at git/worktree.ts.

export const AQUARIUM_REAP_CHANNEL = 'aquarium:reap'

export type AquariumReapDenyReason = 'owner-uid' | 'not-found' | 'guard-block'

export type AquariumReapRequest = {
  /** Repo the worktrees belong to (the git common-dir root). */
  repoPath: string
  /** Absolute worktree checkout paths to reap (parallel to AquariumEntry.path). */
  worktreePaths: string[]
}

export type AquariumReapDenied = {
  path: string
  reason: AquariumReapDenyReason
  detail?: string
}

export type AquariumReapResult = {
  /** Worktree paths actually removed + pruned. */
  reaped: string[]
  /** Worktree paths refused by a server-side deny gate, with the reason. */
  denied: AquariumReapDenied[]
  /** Paths where disposal threw — surfaced, never silently swallowed. */
  failed: { path: string; error: string }[]
}
