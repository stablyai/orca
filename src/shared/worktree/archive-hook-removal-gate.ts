// A successful archive hook is a precondition for stop/delete mutations (#19334).

/** Clients must wait beyond this deadline; otherwise they report failure while the host can still finish the hook and delete (#19334). */
export const ARCHIVE_HOOK_TIMEOUT_MS = 120_000

/** Allow unbounded Git deletion and the host’s two-at-a-time queue after any hook deadline. A client timeout is not proof removal failed; settle from host listings. */
export function worktreeRemovalReplyTimeoutMs(runsArchiveHook: boolean): number {
  return (runsArchiveHook ? ARCHIVE_HOOK_TIMEOUT_MS : 0) + 180_000
}

/** RPC/CLI error code for a removal refused because the repo's archive hook did not succeed. */
export const ARCHIVE_HOOK_FAILED_REMOVAL_CODE = 'worktree_archive_hook_failed'

export const ARCHIVE_HOOK_FAILED_REMOVAL_PREFIX = 'Archive hook failed for worktree:'

// Name both desktop and CLI waivers so each surface offers an actionable override.
export const ARCHIVE_HOOK_OVERRIDE_HINT =
  'Nothing was stopped, deleted or deregistered. Fix the hook and retry, or delete anyway with an explicit waiver — "Delete Anyway" in the app, or --allow-failed-archive-hook on the CLI.'

/** exited requires an observed nonzero exit. Spawn failure, timeout or lost host contact is unverifiable; both block removal. Use the UnstoppedPtyVerdict vocabulary (docs/reference/ssh-execution-boundary.md). */
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

function describeArchiveHookVerdict(failure: ArchiveHookFailure): string {
  return failure.outcome === 'exited'
    ? `exited ${failure.exitCode}`
    : 'outcome unverifiable (the hook never reported an exit)'
}

export function formatArchiveHookFailure(failure: ArchiveHookFailure): string {
  const output = failure.output.trim()
  return [
    `${ARCHIVE_HOOK_FAILED_REMOVAL_PREFIX} ${failure.worktreePath} — ${describeArchiveHookVerdict(failure)}.`,
    ARCHIVE_HOOK_OVERRIDE_HINT,
    ...(output ? [output] : [])
  ].join(' ')
}

/** The waived case did remove the checkout; never reuse the refusal’s "Nothing was stopped, deleted or deregistered" message. */
export function formatArchiveHookOverride(override: ArchiveHookOverride): string {
  const output = override.output.trim()
  return [
    `Archive hook failed for worktree: ${override.worktreePath} — ${describeArchiveHookVerdict(override)}.`,
    'Deleted anyway because the failure was explicitly waived; nothing was archived.',
    ...(output ? [output] : [])
  ].join(' ')
}

/** Use the same typed refusal branch in callers and tests; rethrow unrelated failures. */
export function asArchiveHookRefusal(error: unknown): WorktreeArchiveHookFailedError {
  if (error instanceof WorktreeArchiveHookFailedError) {
    return error
  }
  throw error
}

/** Recognise the refusal on a surface that only has the message, e.g. a renderer toast. */
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
