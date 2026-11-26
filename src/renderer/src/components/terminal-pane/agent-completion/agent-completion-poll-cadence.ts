export type PollCadenceTier = 'active' | 'idle' | 'hidden' | 'quiet-agent' | 'no-evidence'

export const POLL_TIER_INTERVAL_MS: Record<PollCadenceTier, number> = {
  active: 750,
  idle: 2_000,
  hidden: 3_000,
  // Quiet panes read only to retry an inconclusive read; events arm the faster tiers.
  'quiet-agent': 15_000,
  'no-evidence': 15_000
}

export const NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS = 10_000
