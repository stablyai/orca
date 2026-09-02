export type PollCadenceTier = 'active' | 'idle' | 'hidden' | 'no-evidence'

export const POLL_TIER_INTERVAL_MS: Record<PollCadenceTier, number> = {
  active: 750,
  idle: 2_000,
  hidden: 3_000,
  'no-evidence': 15_000
}

// Pane activity (output/replay/title/hook) on a pane with no agent evidence
// runs the 2s idle cadence for this long...
export const NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS = 10_000
// ...and, where the idle no-evidence timer is disarmed (remote panes), keeps
// cadence inspections armed at the no-evidence tier until this long after the
// activity, so a slow host gets three more looks (~10s/25s/40s) before the pane
// goes fully quiet. Panes that keep the idle timer never reach this gate.
export const NO_EVIDENCE_ACTIVITY_ARMED_WINDOW_MS = 45_000
