/** How many finished new-per-run worktrees an automation keeps before older safe ones can be removed. */
export const MAX_AUTOMATION_WORKTREE_KEEP_LAST = 100

/**
 * Absent on existing-workspace automations and on new-per-run rows that still
 * use the default. The default removes a worktree only after a successful run
 * whose commit matches the base ref and whose status is clean.
 */
export type AutomationWorktreeRetention =
  | { mode: 'keep' }
  | { mode: 'keep_last'; count: number }
  | { mode: 'reclaim_clean_success' }

export type WorktreeReclaimSafety = 'reclaimable' | 'keep' | 'unverifiable'

export type AutomationWorktreeRetentionCandidate = {
  id: string
  createdAt: number
  automationRunId: string
  isMainWorktree: boolean
  safety: WorktreeReclaimSafety
}

type RetentionRecord = { mode?: unknown; count?: unknown }

export function resolveAutomationWorktreeRetention(
  workspaceMode: 'existing' | 'new_per_run',
  stored: AutomationWorktreeRetention | null | undefined
): AutomationWorktreeRetention {
  if (workspaceMode !== 'new_per_run') {
    return { mode: 'keep' }
  }
  return stored ?? { mode: 'reclaim_clean_success' }
}

/** Unknown mode strings become `keep` so a newer writer cannot make this host delete. */
export function interpretAutomationWorktreeRetention(
  value: unknown
): AutomationWorktreeRetention | null | 'invalid' | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return 'invalid'
  }
  const record = value as RetentionRecord
  if (record.mode === 'keep' || record.mode === 'reclaim_clean_success') {
    return { mode: record.mode }
  }
  if (record.mode === 'keep_last') {
    const count = record.count
    if (
      typeof count === 'number' &&
      Number.isInteger(count) &&
      count >= 1 &&
      count <= MAX_AUTOMATION_WORKTREE_KEEP_LAST
    ) {
      return { mode: 'keep_last', count }
    }
    return 'invalid'
  }
  if (typeof record.mode === 'string' && record.mode.length > 0) {
    return { mode: 'keep' }
  }
  return 'invalid'
}

/** A stored value this host cannot read stays on disk as keep, which deletes nothing. */
export function normalizeStoredAutomationWorktreeRetention(
  value: unknown
): AutomationWorktreeRetention | undefined {
  const interpreted = interpretAutomationWorktreeRetention(value)
  if (interpreted === undefined || interpreted === null) {
    return undefined
  }
  if (interpreted === 'invalid') {
    return { mode: 'keep' }
  }
  return interpreted
}

export function formatAutomationWorktreeRetention(
  workspaceMode: 'existing' | 'new_per_run',
  stored: AutomationWorktreeRetention | null | undefined
): string {
  if (workspaceMode !== 'new_per_run') {
    return 'n/a'
  }
  if (!stored) {
    return 'reclaim_clean_success (default)'
  }
  if (stored.mode === 'keep_last') {
    return `keep_last:${stored.count}`
  }
  return stored.mode
}

/**
 * CLI spellings. `null` clears a saved override back to the default.
 * `invalid` is a caller error, not an unrecognized future mode.
 */
export function parseAutomationWorktreeRetentionFlag(
  raw: string
): AutomationWorktreeRetention | null | 'invalid' {
  const value = raw.trim().toLowerCase()
  if (value === 'default') {
    return null
  }
  const keepLast = /^(?:keep-last|keep_last):(\d+)$/.exec(value)
  if (keepLast) {
    const interpreted = interpretAutomationWorktreeRetention({
      mode: 'keep_last',
      count: Number(keepLast[1])
    })
    return interpreted === 'invalid' || interpreted === undefined || interpreted === null
      ? 'invalid'
      : interpreted
  }
  const mode = value.replace(/-/g, '_')
  if (mode === 'keep' || mode === 'reclaim_clean_success') {
    return { mode }
  }
  return 'invalid'
}

function compareNewestFirst(
  left: AutomationWorktreeRetentionCandidate,
  right: AutomationWorktreeRetentionCandidate
): number {
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt
  }
  if (left.id < right.id) {
    return -1
  }
  if (left.id > right.id) {
    return 1
  }
  return 0
}

export function automationRunWorkspaceStatus(
  runStatus: 'completed' | 'dispatch_failed'
): 'completed' | 'failed' {
  return runStatus === 'completed' ? 'completed' : 'failed'
}

/**
 * Ids to remove. Dirty, unique, unverifiable, failed, and primary checkouts are
 * never selected. A truncated listing cannot prove which rows are the newest,
 * so keep-last removes nothing and the success reclaim only considers this run.
 */
export function selectAutomationWorktreesToReclaim(args: {
  policy: AutomationWorktreeRetention
  listingTruncated: boolean
  finishedRunId: string
  runStatusById: ReadonlyMap<string, string | undefined>
  candidates: readonly AutomationWorktreeRetentionCandidate[]
}): string[] {
  if (args.policy.mode === 'keep') {
    return []
  }
  const removable = args.candidates.filter(
    (candidate) =>
      !candidate.isMainWorktree &&
      candidate.safety === 'reclaimable' &&
      args.runStatusById.get(candidate.automationRunId) === 'completed'
  )
  if (args.policy.mode === 'reclaim_clean_success') {
    if (!args.listingTruncated) {
      return removable.map((candidate) => candidate.id)
    }
    return removable
      .filter((candidate) => candidate.automationRunId === args.finishedRunId)
      .map((candidate) => candidate.id)
  }
  if (args.listingTruncated) {
    return []
  }
  const protectedIds = new Set(
    [...args.candidates]
      .sort((left, right) => compareNewestFirst(left, right))
      .slice(0, args.policy.count)
      .map((candidate) => candidate.id)
  )
  return removable
    .filter((candidate) => !protectedIds.has(candidate.id))
    .map((candidate) => candidate.id)
}
