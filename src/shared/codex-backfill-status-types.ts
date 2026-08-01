/**
 * Why a narrow shape: the pane only needs go/no-go plus a cheap progress hint;
 * the full CodexStateDbBackfillStatus union stays a main-process concern.
 */
export type CodexBackfillGateStatus = {
  pending: boolean
  /** Backfill cursor (a sessions/... rollout path) while pending; null otherwise. */
  lastWatermark: string | null
}

export type CodexBackfillPaneHoldPhase = 'indexing' | 'launched'

/** Why: main owns gate enforcement (#11828); panes mirror this per-paneKey state to drive the indexing overlay. */
export type CodexBackfillPaneHoldState = {
  paneKey: string
  phase: CodexBackfillPaneHoldPhase
  lastWatermark: string | null
}
