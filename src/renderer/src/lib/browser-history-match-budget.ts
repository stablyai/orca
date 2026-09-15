/**
 * Checked-in performance budget for the shared browser-history matcher, measured
 * against the synthetic corpus in `browser-history-match.performance.test.ts`.
 * These are ceilings for catching order-of-magnitude regressions, not targets —
 * the measured numbers on a developer machine sit far under each one.
 *
 * Raising any value requires a fresh measurement recorded in the PR.
 */
export const BROWSER_HISTORY_MATCH_BUDGET = {
  /** Entries prepared in one omnibox open. Tracks MAX_BROWSER_HISTORY_ENTRIES. */
  candidateCount: 200,
  /** p95 ms to prepare the whole corpus once (cold open). */
  prepareP95Ms: 2,
  /** p95 ms to match the prepared corpus against one query. */
  matchP95Ms: 2
} as const
