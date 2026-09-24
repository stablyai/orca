import {
  COMPLETED_WORKSPACE_STATUS_ID,
  DEFAULT_WORKSPACE_STATUS_ID,
  MAIN_WORKTREE_WORKSPACE_STATUS_ID
} from '../workspace-statuses'

/** Cached review state. `unknown` means a link exists but its state was not verified. */
export type LinkedReviewSettlementState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown'

/**
 * `finished` means every linked orchestration task is completed or failed.
 * `unknown` means the link could not be read — that must not count as finished.
 */
export type LinkedTaskSettlementSignal = 'finished' | 'active' | 'none' | 'unknown'

export type WorkspaceStatusSettlementInput = {
  isMainWorktree: boolean
  /** Persisted status. Missing means the non-main default, which is in-progress. */
  storedStatus?: string
  /**
   * Commits reachable from HEAD that are not on the default branch.
   * `0` means HEAD is contained there, so there is no unique unpushed work against that ref.
   * `null` means the comparison could not be verified.
   */
  uniqueCommitCount: number | null
  linkedReviewState: LinkedReviewSettlementState | null
  linkedTaskSignal: LinkedTaskSettlementSignal
}

const FINISHED_REVIEW_STATES = new Set<LinkedReviewSettlementState>(['merged', 'closed'])

function currentTaskStatus(storedStatus: string | undefined): string {
  return storedStatus && storedStatus.length > 0 ? storedStatus : DEFAULT_WORKSPACE_STATUS_ID
}

/**
 * Decide the status a worktree list should publish.
 * Non-main rows leave in-progress only for a verified completion signal.
 * Any other stored status is left alone, and an unverified git or task fact never counts.
 */
export function settleWorkspaceStatus(input: WorkspaceStatusSettlementInput): string {
  if (input.isMainWorktree) {
    return MAIN_WORKTREE_WORKSPACE_STATUS_ID
  }
  const current = currentTaskStatus(input.storedStatus)
  if (current !== DEFAULT_WORKSPACE_STATUS_ID) {
    return current
  }
  if (
    (input.linkedReviewState !== null && FINISHED_REVIEW_STATES.has(input.linkedReviewState)) ||
    input.linkedTaskSignal === 'finished' ||
    input.uniqueCommitCount === 0
  ) {
    return COMPLETED_WORKSPACE_STATUS_ID
  }
  return current
}

export function shouldPersistSettledWorkspaceStatus(args: {
  isMainWorktree: boolean
  storedStatus: string | undefined
  nextStatus: string
}): boolean {
  if (args.storedStatus === args.nextStatus) {
    return false
  }
  if (args.isMainWorktree) {
    return args.nextStatus === MAIN_WORKTREE_WORKSPACE_STATUS_ID
  }
  if (args.nextStatus !== COMPLETED_WORKSPACE_STATUS_ID) {
    return false
  }
  return (
    args.storedStatus === undefined ||
    args.storedStatus.length === 0 ||
    args.storedStatus === DEFAULT_WORKSPACE_STATUS_ID
  )
}
