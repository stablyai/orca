export const QUICK_OPEN_READDIR_MAX_FILES = 10_000
export const QUICK_OPEN_READDIR_TIMEOUT_MS = 10_000

export type QuickOpenReaddirBudget = {
  remainingFiles: number
  deadlineMs: number
}

export function createQuickOpenReaddirBudget(
  opts: { maxFiles?: number; timeoutMs?: number; nowMs?: number } = {}
): QuickOpenReaddirBudget {
  return {
    remainingFiles: opts.maxFiles ?? QUICK_OPEN_READDIR_MAX_FILES,
    deadlineMs: (opts.nowMs ?? Date.now()) + (opts.timeoutMs ?? QUICK_OPEN_READDIR_TIMEOUT_MS)
  }
}

const FILE_LISTING_TIMED_OUT = 'File listing timed out'
const FILE_LISTING_EXCEEDED_PREFIX = 'File listing exceeded'

/** Budget errors are the only fallback failures translated into install-rg guidance. */
export function isQuickOpenReaddirBudgetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return message === FILE_LISTING_TIMED_OUT || message.startsWith(FILE_LISTING_EXCEEDED_PREFIX)
}

export function assertQuickOpenReaddirDeadline(budget: QuickOpenReaddirBudget): void {
  if (Date.now() > budget.deadlineMs) {
    throw new Error(FILE_LISTING_TIMED_OUT)
  }
}

export function consumeQuickOpenReaddirFileBudget(budget: QuickOpenReaddirBudget): void {
  if (budget.remainingFiles <= 0) {
    throw new Error(`${FILE_LISTING_EXCEEDED_PREFIX} ${QUICK_OPEN_READDIR_MAX_FILES} files`)
  }
  budget.remainingFiles--
}
