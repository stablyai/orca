/** Synthetic-corpus regression ceilings: fastest samples reduce preemption noise, deterministic field-call counts catch fan-out. Raising limits requires fresh PR measurements. */
export const PALETTE_MATCH_BUDGET = {
  /** Workspaces normalized in one cold palette open. */
  candidateCount: 800,
  /** Unique tokens in the worst supported query. */
  tokenCount: 16,
  /** Count field matches independent of machine speed; the accepted worst-query fixture has 16 fields × 16 tokens. */
  fieldMatchesPerCandidate: 280,
  /** Fixed-domain selection visits per accepted candidate. */
  selectionCandidateVisitsPerCandidate: 3_600,
  /** Milliseconds to normalize every document once (cold open), fastest sample. */
  coldBuildMs: 900,
  /** Time a full pass against four quarter passes in one run: linear work is ~1, quadratic ~4. The ratio cancels runner speed that made absolute ceilings flaky. */
  quadrupledCorpusCostRatio: 2,
  /** Measure retained text/offset bytes deterministically; shared-worker heapUsed includes unrelated allocations. */
  documentPayloadMb: 24,
  /** Megabytes retained by the accepted query's match/range results. Measured 0.69 MB. */
  matchPayloadMb: 1
} as const
