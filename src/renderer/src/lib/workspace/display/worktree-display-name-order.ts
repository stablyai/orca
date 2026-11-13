import type { Worktree } from '../../../../../shared/worktree/types'

// Persisted/discovered rows can lack required displayName (crash 99657ab1).
export function compareDisplayName(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  return (a ?? '').localeCompare(b ?? '')
}

export function compareWorktreeDisplayName(a: Worktree, b: Worktree): number {
  return compareDisplayName(a.displayName, b.displayName)
}
