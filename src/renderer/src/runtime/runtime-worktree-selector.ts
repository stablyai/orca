const RUNTIME_WORKTREE_ID_SELECTOR_PREFIX = 'id:'

export function toRuntimeWorktreeSelector(worktreeId: string): string {
  const trimmed = worktreeId.trim()
  if (!trimmed || trimmed.startsWith(RUNTIME_WORKTREE_ID_SELECTOR_PREFIX)) {
    return trimmed
  }
  return `${RUNTIME_WORKTREE_ID_SELECTOR_PREFIX}${trimmed}`
}
