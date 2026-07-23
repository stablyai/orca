import type { Worktree } from '../../../shared/types'

// Why: displayName is typed non-optional but arrives undefined at runtime for
// persisted/discovered worktrees (crash 99657ab1); coalesce so it can't throw.
export function compareDisplayName(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  return (a ?? '').localeCompare(b ?? '')
}

// Row models copy this same runtime-undefined displayName into string-typed
// fields, so they share the guard.
export function compareWorktreeDisplayName(a: Worktree, b: Worktree): number {
  return compareDisplayName(a.displayName, b.displayName)
}
