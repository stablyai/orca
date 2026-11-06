export class StandaloneBranchDeletionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'branch_deletion_failed'
      | 'capability_unsupported'
      | 'branch_deletion_uncertain' = 'branch_deletion_failed',
    readonly data?: {
      effect: 'unknown'
      restoration: 'not-attempted' | 'restored' | 'failed'
      inventoryRequired: true
    }
  ) {
    super(message)
  }
}

export function uncertainBranchDeletion(
  message: string,
  restoration: 'not-attempted' | 'restored' | 'failed' = 'not-attempted'
): StandaloneBranchDeletionError {
  return new StandaloneBranchDeletionError(
    `Branch deletion outcome is uncertain. ${message} Obtain fresh inventory before retrying.`,
    'branch_deletion_uncertain',
    { effect: 'unknown', restoration, inventoryRequired: true }
  )
}
