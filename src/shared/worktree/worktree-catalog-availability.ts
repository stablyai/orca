/**
 * "I could not ask" is not "there is nothing there".
 *
 * A worktree catalog that could not be read must stay distinguishable from one that
 * genuinely lists no worktrees, or downstream reconciliation converts a transport or
 * Git failure into authoritative emptiness and tears down live state
 * (docs/reference/ssh-execution-boundary.md, issue #14004).
 */
export class WorktreeCatalogUnavailableError extends Error {
  /** Structural marker: survives JSON-RPC re-wrapping better than `instanceof` across module copies. */
  readonly worktreeCatalogUnavailable = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorktreeCatalogUnavailableError'
  }
}

export function isWorktreeCatalogUnavailableError(error: unknown): boolean {
  return (
    error instanceof WorktreeCatalogUnavailableError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { worktreeCatalogUnavailable?: unknown }).worktreeCatalogUnavailable === true)
  )
}

/**
 * Git always lists at least the repository's own checkout, so a zero-row listing for a Git repo
 * can only mean the scan never produced an answer. Older relays converted worktree-list failures
 * into `[]`, so a mixed-version client must reject that shape rather than publish it.
 */
export function assertAuthoritativeWorktreeCatalog<T>(worktrees: unknown, repoPath: string): T[] {
  if (!Array.isArray(worktrees) || worktrees.length === 0) {
    throw new WorktreeCatalogUnavailableError(
      `Worktree catalog unavailable for ${repoPath}: the execution host returned no worktree listing. ` +
        'Treating this as an empty catalog would authorize removing workspaces that still exist.'
    )
  }
  return worktrees as T[]
}
