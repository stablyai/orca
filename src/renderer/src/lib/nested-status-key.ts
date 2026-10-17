const NESTED_KEY_SEPARATOR = '::'

/** Store slot for state that belongs to a git repo nested inside a workspace rather than the workspace itself. */
export function nestedStatusKey(worktreeId: string, repoPath: string): string {
  return `${worktreeId}${NESTED_KEY_SEPARATOR}${repoPath}`
}

/** Keys in `record` owned by the given workspaces' nested repos, for teardown. */
export function nestedStatusKeysForWorktrees(
  record: Record<string, unknown> | undefined,
  worktreeIds: Iterable<string>
): string[] {
  if (!record) {
    return []
  }
  const prefixes = [...worktreeIds].map((id) => `${id}${NESTED_KEY_SEPARATOR}`)
  return Object.keys(record).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
}
