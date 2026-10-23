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
