/** Final: Try again cannot help, so the dialog offers Dismiss only. */
export type BranchAutoRenameIneligibleReason =
  | 'branch-pushed'
  | 'branch-renamed'
  | 'name-chosen'
  | 'setting-off'
  | 'no-distinct-name'
  | 'first-message-unavailable'
  | 'already-named'
  | 'unavailable'

/** Retryable: the dialog keeps Try again. */
export type BranchAutoRenameDeferredReason =
  | 'branch-changed'
  | 'project-moving'
  | 'history-unreadable'
  | 'interrupted'

export type BranchAutoRenameOutcome =
  | { kind: 'renamed' }
  /** Generation or configuration failed; the persisted error carries the details. */
  | { kind: 'failed' }
  | { kind: 'nothing-yet' }
  | { kind: 'deferred'; reason: BranchAutoRenameDeferredReason }
  | { kind: 'ineligible'; reason: BranchAutoRenameIneligibleReason }

/** Attempts run on the desktop's own host; a same-id workspace on another host is a different one. */
export type BranchAutoRenameAttemptHost = 'local'

export type BranchAutoRenameAttemptEvent =
  | {
      executionHostId: BranchAutoRenameAttemptHost
      worktreeId: string
      attemptId: number
      phase: 'started'
    }
  | {
      executionHostId: BranchAutoRenameAttemptHost
      worktreeId: string
      attemptId: number
      phase: 'finished'
      outcome: BranchAutoRenameOutcome
      finishedAt: number
    }

export type BranchAutoRenameRetryAvailability = {
  available: boolean
  /** An automatic or manual attempt for this workspace is already running. */
  runningAttemptId: number | null
}

/** False when the workspace is gone; the error then has nothing left to clear. */
export type BranchAutoRenameDismissResult = { dismissed: boolean }

export type BranchAutoRenameRetryResult = {
  attemptId: number | null
  outcome: BranchAutoRenameOutcome
  finishedAt: number
}

/** A remote Try again waits on a full generation run (its own timeout is 60s) plus setup. */
export const AUTO_NAME_RETRY_TIMEOUT_MS = 120_000

/** The runtime methods behind a paired client's Try again and Dismiss. */
export const AUTO_NAME_RPC_METHODS = {
  availability: 'worktree.autoName.availability',
  retry: 'worktree.autoName.retry',
  dismiss: 'worktree.autoName.dismiss',
  wait: 'worktree.autoName.wait'
} as const
