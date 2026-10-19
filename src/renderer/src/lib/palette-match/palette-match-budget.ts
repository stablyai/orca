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
   * The accepted fixture has 16 indexed fields across each of its 16 tokens.
   */
  fieldMatchesPerCandidate: 280,
  /** Fixed-domain selection visits per accepted candidate. */
  selectionCandidateVisitsPerCandidate: 3_600,
  /** Milliseconds to normalize every document once (cold open), fastest sample. */
  coldBuildMs: 900,
  /**
   * Ceiling on one full-corpus pass over four quarter-corpus passes, for warm
   * matching and for search plus sort. Measured in one run so runner speed
   * cancels out: linear work is ~1, quadratic ~4. Measured 0.97–1.01 idle and
   * 0.80–1.29 with every core oversubscribed 2x; an injected O(n²) search
   * measured 3.68. Replaces 220/180 ms ceilings that shared CI runners exceeded.
   */
  quadrupledCorpusCostRatio: 2,
  /**
   * Megabytes of indexed text and offset tables the normalized documents retain.
   * Measured deterministically rather than from `heapUsed`, which is polluted by
   * whatever else shares the vitest worker. Process heap for the same corpus
   * measured ~40 MB in isolation.
   */
  documentPayloadMb: 24,
  /** Megabytes retained by the accepted query's match/range results. Measured 0.69 MB. */
  matchPayloadMb: 1
} as const
