export class StandaloneBranchDeletionError extends Error {
  constructor(
    message: string,
    readonly code: 'branch_deletion_failed' | 'capability_unsupported' = 'branch_deletion_failed'
  ) {
    super(message)
  }
}
