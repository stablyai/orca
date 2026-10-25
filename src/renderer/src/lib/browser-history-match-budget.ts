/** Regression ceilings for the synthetic matcher corpus, measured by lower quartile to discard preemption tails without trusting one lucky sample. Raising a ceiling requires fresh PR measurements. */
export const BROWSER_HISTORY_MATCH_BUDGET = {
  candidateCount: 200,
  /** Milliseconds to prepare the whole corpus once (cold open), lower quartile. Measured 0.07 ms. */
  prepareMs: 2,
  /** Milliseconds to match the prepared corpus against one query, lower quartile. Measured 0.03 ms. */
  matchMs: 2
} as const
