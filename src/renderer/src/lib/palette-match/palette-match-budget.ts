/**
 * Checked-in performance budget for the Cmd+J matcher, measured against the
 * synthetic corpus in `palette-match-performance.test.ts`. These are ceilings for
 * catching order-of-magnitude regressions, not targets.
 *
 * The wall-clock ceilings are asserted against the *fastest* sample of a batch,
 * never the slowest: a vitest worker sharing cores with the rest of the suite
 * gets preempted mid-measurement, so the slowest sample measures the machine
 * while the fastest still approximates the matcher. Fan-out regressions are
 * caught by `fieldMatchesPerCandidate` instead, which counts work rather than
 * time and so does not depend on machine speed at all.
 *
 * Raising any value requires a fresh measurement recorded in the PR.
 */
export const PALETTE_MATCH_BUDGET = {
  /** Workspaces normalized in one cold palette open. */
  candidateCount: 800,
  /** Unique tokens in the worst supported query. */
  tokenCount: 16,
  /**
   * Ceiling on `matchPaletteField` calls per candidate for the worst query.
   * Deterministic — it counts work, not time — so it catches a fan-out
   * regression (re-matching every field per evidence unit, say) on any machine.
   * Measured 45: 15 fields across the 3 tokens scanned before the first miss.
   */
  fieldMatchesPerCandidate: 60,
  /** Milliseconds to normalize every document once (cold open), fastest sample. */
  coldBuildMs: 900,
  /** Milliseconds to match the whole corpus against one prepared query, fastest sample. */
  warmMatchMs: 220,
  /**
   * Megabytes of indexed text and offset tables the normalized documents retain.
   * Measured deterministically rather than from `heapUsed`, which is polluted by
   * whatever else shares the vitest worker. Process heap for the same corpus
   * measured ~40 MB in isolation.
   */
  documentPayloadMb: 24
} as const
