export type PollCadenceTier = 'active' | 'idle' | 'hidden' | 'quiet-agent' | 'no-evidence'

export const POLL_TIER_INTERVAL_MS: Record<PollCadenceTier, number> = {
  active: 750,
  idle: 2_000,
  hidden: 3_000,
  // A silent agent pane only needs a safety net; any output, title or hook restores 'active'.
  'quiet-agent': 15_000,
  'no-evidence': 15_000
}

export const NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS = 10_000
