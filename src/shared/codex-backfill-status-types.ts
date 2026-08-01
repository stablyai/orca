/**
 * Why a narrow shape: the pane only needs go/no-go plus a cheap progress hint;
 * the full CodexStateDbBackfillStatus union stays a main-process concern.
 */
export type CodexBackfillGateStatus = {
  pending: boolean
  /** Backfill cursor (a sessions/... rollout path) while pending; null otherwise. */
  lastWatermark: string | null
}
