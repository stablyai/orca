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
  /** An automatic attempt left the seed name because the inherited agent can't run; Try again reports why. */
  | 'default-agent-skipped'
  | 'default-agent-skipped-title'

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

export type BranchAutoRenameRetryResult = {
  attemptId: number | null
  outcome: BranchAutoRenameOutcome
  finishedAt: number
}
