/**
 * Checked-in performance budget for the Cmd+J matcher, measured against the
 * synthetic corpus in `palette-match-performance.test.ts`. These are ceilings for
 * catching order-of-magnitude regressions, not targets — the measured numbers on
 * a developer machine sit roughly an order of magnitude under each one.
 *
 * Raising any value requires a fresh measurement recorded in the PR.
 */
export const PALETTE_MATCH_BUDGET = {
  /** Workspaces normalized in one cold palette open. */
  candidateCount: 800,
  /** Unique tokens in the worst supported query. */
  tokenCount: 16,
  /** p95 milliseconds to normalize every document once (cold open). */
  coldBuildP95Ms: 900,
  /** p95 milliseconds to match the whole corpus against one prepared query. */
  warmMatchP95Ms: 220,
  /**
   * Megabytes of indexed text and offset tables the normalized documents retain.
   * Measured deterministically rather than from `heapUsed`, which is polluted by
   * whatever else shares the vitest worker. Process heap for the same corpus
   * measured ~40 MB in isolation.
   */
  documentPayloadMb: 24
} as const
