export const QUICK_OPEN_READDIR_MAX_FILES = 10_000
export const QUICK_OPEN_READDIR_MAX_ENTRIES = 50_000
export const QUICK_OPEN_READDIR_MAX_DIRECTORIES = 25_000
export const QUICK_OPEN_READDIR_MAX_DEPTH = 256
export const QUICK_OPEN_READDIR_MAX_PATH_CODE_UNITS = 16 * 1024 * 1024
export const QUICK_OPEN_READDIR_TIMEOUT_MS = 10_000

export type QuickOpenReaddirBudget = {
  remainingFiles: number
  remainingEntries: number
  remainingDirectories: number
  remainingPathCodeUnits: number
  maxFiles: number
  maxEntries: number
  maxDirectories: number
  maxDepth: number
  maxPathCodeUnits: number
  deadlineMs: number
}

export function createQuickOpenReaddirBudget(
  opts: {
    maxFiles?: number
    maxEntries?: number
    maxDirectories?: number
    maxDepth?: number
    maxPathCodeUnits?: number
    timeoutMs?: number
    nowMs?: number
  } = {}
): QuickOpenReaddirBudget {
  const maxFiles = opts.maxFiles ?? QUICK_OPEN_READDIR_MAX_FILES
  const maxEntries = opts.maxEntries ?? QUICK_OPEN_READDIR_MAX_ENTRIES
  const maxDirectories = opts.maxDirectories ?? QUICK_OPEN_READDIR_MAX_DIRECTORIES
  const maxDepth = opts.maxDepth ?? QUICK_OPEN_READDIR_MAX_DEPTH
  const maxPathCodeUnits = opts.maxPathCodeUnits ?? QUICK_OPEN_READDIR_MAX_PATH_CODE_UNITS
  for (const [name, value] of Object.entries({
    maxFiles,
    maxEntries,
    maxDirectories,
    maxDepth,
    maxPathCodeUnits
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
  return {
    remainingFiles: maxFiles,
    remainingEntries: maxEntries,
    remainingDirectories: maxDirectories,
    remainingPathCodeUnits: maxPathCodeUnits,
    maxFiles,
    maxEntries,
    maxDirectories,
    maxDepth,
    maxPathCodeUnits,
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
    throw new Error(`${FILE_LISTING_EXCEEDED_PREFIX} ${budget.maxFiles} files`)
  }
  budget.remainingFiles--
}

export function consumeQuickOpenReaddirEntryBudget(budget: QuickOpenReaddirBudget): void {
  if (budget.remainingEntries <= 0) {
    throw new Error(`${FILE_LISTING_EXCEEDED_PREFIX} ${budget.maxEntries} entries`)
  }
  budget.remainingEntries--
}

export function consumeQuickOpenReaddirDirectoryBudget(budget: QuickOpenReaddirBudget): void {
  if (budget.remainingDirectories <= 0) {
    throw new Error(`${FILE_LISTING_EXCEEDED_PREFIX} ${budget.maxDirectories} directories`)
  }
  budget.remainingDirectories--
}

export function assertQuickOpenReaddirDepth(budget: QuickOpenReaddirBudget, depth: number): void {
  if (depth > budget.maxDepth) {
    throw new Error(`${FILE_LISTING_EXCEEDED_PREFIX} depth ${budget.maxDepth}`)
  }
}

export function consumeQuickOpenReaddirPathBudget(
  budget: QuickOpenReaddirBudget,
  path: string
): void {
  if (path.length > budget.remainingPathCodeUnits) {
    throw new Error(`${FILE_LISTING_EXCEEDED_PREFIX} ${budget.maxPathCodeUnits} path code units`)
  }
  budget.remainingPathCodeUnits -= path.length
}
