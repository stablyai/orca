// Why (#19334): the archive hook is a user's last chance to save work off a checkout Orca is
// about to delete. A failed hook used to be logged and stepped over, so the delete went ahead
// with nothing archived. It is a precondition, evaluated before any stop/delete mutation.

/** RPC/CLI error code for a removal refused because the repo's archive hook did not succeed. */
export const ARCHIVE_HOOK_FAILED_REMOVAL_CODE = 'worktree_archive_hook_failed'

export const ARCHIVE_HOOK_FAILED_REMOVAL_PREFIX = 'Archive hook failed for worktree:'

// Surface-neutral on purpose: the CLI spells the flag, the desktop offers the skip-hook choice.
export const ARCHIVE_HOOK_OVERRIDE_HINT =
  'Nothing was stopped, deleted or deregistered. Fix the hook and retry, retry with the archive hook skipped, or retry with an explicit waiver for the failed hook.'

/**
 * `exited` means the host reported a non-zero exit for this hook run. `unverifiable` covers every
 * case where the hook's outcome was never observed — spawn failure, timeout, lost contact with the
 * execution host. Loss of contact is never evidence that the hook passed, so both block removal.
 * Vocabulary is deliberately the `UnstoppedPtyVerdict` spelling; see docs/reference/ssh-execution-boundary.md.
 */
export type ArchiveHookOutcome = 'exited' | 'unverifiable'

export type ArchiveHookFailure = {
  worktreePath: string
  outcome: ArchiveHookOutcome
  /** Only ever set for `exited` — an absent code is not a zero code. */
  exitCode?: number
  output: string
}

/** What a caller sees when the failure was explicitly overridden instead of blocking. */
export type ArchiveHookOverride = ArchiveHookFailure & { overridden: true }

export class WorktreeArchiveHookFailedError extends Error {
  readonly code = ARCHIVE_HOOK_FAILED_REMOVAL_CODE
  readonly data: ArchiveHookFailure

  constructor(failure: ArchiveHookFailure) {
    super(formatArchiveHookFailure(failure))
    this.name = 'WorktreeArchiveHookFailedError'
    this.data = failure
  }
}

export function formatArchiveHookFailure(failure: ArchiveHookFailure): string {
  const verdict =
    failure.outcome === 'exited'
      ? `exited ${failure.exitCode}`
      : 'outcome unverifiable (the hook never reported an exit)'
  const output = failure.output.trim()
  return [
    `${ARCHIVE_HOOK_FAILED_REMOVAL_PREFIX} ${failure.worktreePath} — ${verdict}.`,
    ARCHIVE_HOOK_OVERRIDE_HINT,
    ...(output ? [output] : [])
  ].join(' ')
}

export function isArchiveHookRemovalError(error: string): boolean {
  return error.includes(ARCHIVE_HOOK_FAILED_REMOVAL_PREFIX)
}

/** Shape both the local and the SSH archive runners answer with. */
export type ArchiveHookRunResult = {
  success: boolean
  output: string
  /** Omitted whenever no exit was observed, which classifies the failure as `unverifiable`. */
  exitCode?: number
}

export function classifyArchiveHookFailure(
  worktreePath: string,
  result: ArchiveHookRunResult
): ArchiveHookFailure {
  return {
    worktreePath,
    outcome: typeof result.exitCode === 'number' ? 'exited' : 'unverifiable',
    ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
    output: result.output
  }
}
