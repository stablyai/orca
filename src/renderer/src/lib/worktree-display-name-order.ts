import type { Worktree } from '../../../shared/types'

// Why: displayName is typed non-optional but arrives undefined at runtime for
// persisted/discovered worktrees (crash 99657ab1); coalesce so it can't throw.
export function compareWorktreeDisplayName(a: Worktree, b: Worktree): number {
  return (a.displayName ?? '').localeCompare(b.displayName ?? '')
}
