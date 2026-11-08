export const WORKTREE_CREATE_COLLISION_CODE = 'worktree_create_collision' as const

// Marks an exhausted name search before any workspace was created.
export class WorktreeCreateCollisionError extends Error {}

export const WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE = 'worktree_create_exact_name_taken' as const

/** An exact-name create refused before creating anything; the trailing code survives Electron's IPC wrapper. */
export class WorktreeCreateExactNameTakenError extends Error {
  readonly code = WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE

  constructor(detail: string) {
    super(`${detail}\n${WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE}`)
    this.name = 'WorktreeCreateExactNameTakenError'
  }
}
