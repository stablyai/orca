// Subset of onboarding Ghostty DiscoveryState statuses that emit telemetry; UI-only 'idle'/'detecting' don't.
export type DiscoveryStatusEmitted = 'found' | 'absent' | 'imported'

export type OnboardingOutcome = 'completed' | 'dismissed'

export type OnboardingChecklistState = {
  addedRepo: boolean
  choseAgent: boolean
  ranFirstAgent: boolean
  ranSecondAgentOnSameTask: boolean
  triedCmdJ: boolean
  // Persisted field, also a telemetry enum member in ./telemetry-onboarding-foundation-schemas;
  // renaming it would orphan saved state. Rule exemption: config/oxlint-anti-slop.json.
  shapedSidebar: boolean
  reviewedDiff: boolean
  openedPr: boolean
  addedFolder: boolean
  openedFile: boolean
  ranAgentOnFile: boolean
  // Panel visibility only; telemetry’s activation checklist excludes it.
  dismissed: boolean
}

export type OnboardingState = {
  // Version changed step meanings so migrations cannot replay over new progress.
  flowVersion: number
  closedAt: number | null
  outcome: OnboardingOutcome | null
  // -1 means not started; 1..5 is highest completed step. Keep number for Math.max/min clamping.
  lastCompletedStep: number
  checklist: OnboardingChecklistState
}
