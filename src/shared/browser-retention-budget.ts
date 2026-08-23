// Why (STA-4341): Orca bounds live browser renderers on two very different
// hosts. The desktop app retains hidden worktrees' webview guests; a headless
// `orca serve` retains agent-opened offscreen pages. The unit differs (worktree
// vs page) and so does the way each host learns something changed, but the
// budget itself is one decision: keep the most recently used, never evict
// something in use, and optionally shed anything untouched for too long. Both
// hosts call the selector below, so the policy can only diverge where a host
// deliberately configures it to.

/** Renderers a host keeps warm. Matches TERMINAL_WORKTREE_HOT_RETAIN_LIMIT. */
export const BROWSER_RETENTION_LIMIT = 4

export type BrowserRetentionCandidate = {
  id: string
  /**
   * Last use, epoch ms. Omitted by hosts that rank by activation order alone
   * and have no clock rule — such a candidate is never idle and never in grace,
   * so only its rank can evict it.
   */
  lastActivityAt?: number
}

export type BrowserRetentionBudget = {
  /** Candidates kept by rank. Pinned ones hold their slot rather than yield it. */
  limit: number
  /** Evict once untouched this long, even within the limit. Infinity disables. */
  idleMs: number
  /** Never evict something used more recently than this. 0 disables. */
  graceMs: number
}

export type BrowserRetentionSelection = {
  /** Most-recently-used first. Anything omitted is invisible to the budget. */
  candidates: readonly BrowserRetentionCandidate[]
  /**
   * In use right now, so never evicted. Consulted only for candidates the rank
   * and clock rules would otherwise evict, because a host may pay real work to
   * answer it.
   */
  isPinned: (id: string) => boolean
  now: number
  budget: BrowserRetentionBudget
}

export function isBrowserRetentionCandidateIdle(
  candidate: BrowserRetentionCandidate,
  now: number,
  budget: BrowserRetentionBudget
): boolean {
  return candidate.lastActivityAt !== undefined && now - candidate.lastActivityAt >= budget.idleMs
}

export function isBrowserRetentionCandidateInGrace(
  candidate: BrowserRetentionCandidate,
  now: number,
  budget: BrowserRetentionBudget
): boolean {
  return candidate.lastActivityAt !== undefined && now - candidate.lastActivityAt < budget.graceMs
}

/**
 * The candidates to evict: everything not in use that is either ranked beyond
 * the limit or has gone idle.
 *
 * A pinned candidate keeps its slot instead of yielding it, so a host can sit
 * over budget while work is genuinely in flight — interrupting a download or a
 * streamed page to satisfy an accounting limit would break the work the budget
 * exists to protect.
 */
export function selectBrowserRetentionEvictions(args: BrowserRetentionSelection): string[] {
  const evicted: string[] = []
  args.candidates.forEach((candidate, rank) => {
    const overLimit = rank >= args.budget.limit
    if (!overLimit && !isBrowserRetentionCandidateIdle(candidate, args.now, args.budget)) {
      return
    }
    if (isBrowserRetentionCandidateInGrace(candidate, args.now, args.budget)) {
      return
    }
    if (args.isPinned(candidate.id)) {
      return
    }
    evicted.push(candidate.id)
  })
  return evicted
}
