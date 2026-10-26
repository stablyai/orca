import type { Worktree } from '../../../shared/worktree/types'

// Persisted/discovered rows can lack required displayName (crash 99657ab1); coalesce before comparing.
export function compareWorktreeDisplayName(a: Worktree, b: Worktree): number {
  return (a.displayName ?? '').localeCompare(b.displayName ?? '')
}
