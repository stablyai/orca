export class WorktreeStartupError extends Error {
  readonly worktreeId: string

  constructor(worktreeId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'WorktreeStartupError'
    this.worktreeId = worktreeId
  }
}
