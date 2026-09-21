import { z } from 'zod'
import type { OnboardingChecklistState } from './onboarding-state-types'

// ── Onboarding ──────────────────────────────────────────────────────────
// Closed enums only — no raw paths/repo names/URLs/error strings (measures activation, not repo debugging).
// Why: event names still carry legacy seven-step payloads; keep validation backward-compatible for old rows.
export const ONBOARDING_TELEMETRY_LEGACY_MAX_STEP = 7
export const onboardingStepSchema = z
  .number()
  .int()
  .min(1)
  .max(ONBOARDING_TELEMETRY_LEGACY_MAX_STEP)
export const onboardingPathSchema = z.enum(['open_folder', 'clone_url', 'add_project_modal'])
export const onboardingFailureReasonSchema = z.enum([
  'invalid_path',
  'clone_failed',
  'cancelled',
  'unknown'
])
export const onboardingValueKindSchema = z.enum([
  'agent',
  'theme',
  'notifications',
  'agent_setup',
  'integrations',
  'windows_terminal',
  'tour',
  'repo'
])
export const onboardingTourOutcomeSchema = z.enum([
  'skipped_intro',
  'started_partial',
  'completed_inline'
])
export const onboardingTaskSourcesGithubStatusSchema = z.enum([
  'connected',
  'not_authenticated',
  'not_installed',
  'checking',
  'unknown'
])
export const onboardingTaskSourcesLinearStatusSchema = z.enum([
  'connected',
  'not_connected',
  'checking',
  'unknown'
])
export const onboardingTaskSourcesExitActionSchema = z.enum(['continue', 'skip_to_project_setup'])
export const onboardingWindowsTerminalShellSchema = z.enum([
  'powershell',
  'command_prompt',
  'git_bash',
  'wsl',
  'other'
])
export const onboardingWindowsTerminalRightClickSchema = z.enum(['paste', 'menu'])
export const onboardingWindowsTerminalExitActionSchema = z.enum([
  'continue',
  'skip_to_project_setup'
])
// `dismissed` is intentionally excluded — it's a UI panel-visibility flag, not an activation event.
export const onboardingChecklistItemSchema = z.enum([
  'addedRepo',
  'addedFolder',
  'choseAgent',
  'ranFirstAgent',
  'ranSecondAgentOnSameTask',
  'triedCmdJ',
  'shapedSidebar',
  'reviewedDiff',
  'openedPr',
  'openedFile',
  'ranAgentOnFile'
])
export const onboardingFeatureSetupFeatureSchema = z.enum([
  'browser_use',
  'computer_use',
  'orchestration',
  'linear_tickets'
])
export const onboardingFeatureSetupSelectionSchema = {
  browser_use: z.boolean(),
  computer_use: z.boolean(),
  linear_tickets: z.boolean(),
  orchestration: z.boolean(),
  selected_count: z.number().int().min(0).max(3)
} as const
export type OnboardingFeatureSetupSelectionTelemetry = {
  browser_use: boolean
  computer_use: boolean
  linear_tickets: boolean
  orchestration: boolean
  selected_count: number
}
export const onboardingFeatureSetupSelectedCountRefinement = {
  path: ['selected_count'],
  message: 'selected_count must match selected feature flags'
}

export function hasMatchingOnboardingFeatureSetupSelectedCount(
  props: OnboardingFeatureSetupSelectionTelemetry
): boolean {
  // Why: Linear ticket setup is a recommended add-on and excluded from progress metrics.
  const selectedCount =
    (props.browser_use ? 1 : 0) + (props.computer_use ? 1 : 0) + (props.orchestration ? 1 : 0)
  return props.selected_count === selectedCount
}

// Compile-time guard: enum must match OnboardingChecklistState activation keys (minus UI-only `dismissed`); drift breaks the build.
export type _OnboardingChecklistItemSync =
  z.infer<typeof onboardingChecklistItemSchema> extends Exclude<
    keyof OnboardingChecklistState,
    'dismissed'
  >
    ? Exclude<keyof OnboardingChecklistState, 'dismissed'> extends z.infer<
        typeof onboardingChecklistItemSchema
      >
      ? true
      : never
    : never
export const _onboardingChecklistItemSyncCheck: _OnboardingChecklistItemSync = true
void _onboardingChecklistItemSyncCheck

// Cohort discriminator for onboarding events; `.optional()` is load-bearing so `.strict()` accepts the `undefined` fallback.
export const cohortSchema = z.enum(['fresh_install', 'upgrade_backfill']).optional()
