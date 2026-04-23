/**
 * Keeps path-only consumers decoupled from the full Worktree shape.
 */
export function useActiveWorktreePath(worktreePath: string | null): string | null {
  return worktreePath
}
