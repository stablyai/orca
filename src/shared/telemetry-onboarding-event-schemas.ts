import { z } from 'zod'
import { FEATURE_WALL_MAX_DWELL_MS } from './feature-wall-telemetry'
import type { DiscoveryStatusEmitted } from './onboarding-state-types'
import type { PathSource, ShellHydrationFailureReason } from './shell-path-hydration-types'
import { agentKindSchema, featureWallTourDepthStepSchema } from './telemetry-property-schemas'
import {
  cohortSchema,
  hasMatchingOnboardingFeatureSetupSelectedCount,
  onboardingChecklistItemSchema,
  onboardingFailureReasonSchema,
  onboardingFeatureSetupFeatureSchema,
  onboardingFeatureSetupSelectedCountRefinement,
  onboardingFeatureSetupSelectionSchema,
  onboardingPathSchema,
  onboardingStepSchema,
  onboardingTaskSourcesExitActionSchema,
  onboardingTaskSourcesGithubStatusSchema,
  onboardingTaskSourcesLinearStatusSchema,
  onboardingTourOutcomeSchema,
  onboardingValueKindSchema,
  onboardingWindowsTerminalExitActionSchema,
  onboardingWindowsTerminalRightClickSchema,
  onboardingWindowsTerminalShellSchema
} from './telemetry-onboarding-foundation-schemas'

// Uniform button/keyboard shape lets keyboard skip/dismiss paths arrive without a schema migration.
export const advancedViaSchema = z.enum(['button', 'keyboard']).optional()

export const onboardingStartedSchema = z
  .object({ resumed_from_step: onboardingStepSchema.optional(), cohort: cohortSchema })
  .strict()
export const onboardingStepViewedSchema = z
  .object({
    step: onboardingStepSchema,
    value_kind: onboardingValueKindSchema,
    cohort: cohortSchema
  })
  .strict()
export const onboardingStepCompletedSchema = z
  .object({
    step: onboardingStepSchema,
    value_kind: onboardingValueKindSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
export const onboardingStepSkippedSchema = z
  .object({
    step: onboardingStepSchema,
    value_kind: onboardingValueKindSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
export type OnboardingTourOutcomeTelemetry = {
  outcome: z.infer<typeof onboardingTourOutcomeSchema>
  tour_dwell_ms?: number
  furthest_step?: z.infer<typeof featureWallTourDepthStepSchema>
  visited_workflow_count?: number
  visited_substep_count?: number
  completed_workflow_count?: number
  completed_substep_count?: number
}

export function validateOnboardingTourOutcome(
  props: OnboardingTourOutcomeTelemetry,
  ctx: z.RefinementCtx
): void {
  if (props.outcome !== 'skipped_intro') {
    return
  }
  for (const key of [
    'tour_dwell_ms',
    'furthest_step',
    'visited_workflow_count',
    'visited_substep_count',
    'completed_workflow_count',
    'completed_substep_count'
  ] as const) {
    if (props[key] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is only valid after the inline tour starts`
      })
    }
  }
}

export const onboardingTourOutcomeEventSchema = z
  .object({
    outcome: onboardingTourOutcomeSchema,
    intro_duration_ms: z.number().int().min(0).max(FEATURE_WALL_MAX_DWELL_MS).optional(),
    tour_dwell_ms: z.number().int().min(0).max(FEATURE_WALL_MAX_DWELL_MS).optional(),
    furthest_step: featureWallTourDepthStepSchema.optional(),
    visited_workflow_count: z.number().int().min(0).max(5).optional(),
    visited_substep_count: z.number().int().min(0).max(9).optional(),
    completed_workflow_count: z.number().int().min(0).max(5).optional(),
    completed_substep_count: z.number().int().min(0).max(9).optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
  .superRefine(validateOnboardingTourOutcome)
export const onboardingStep4PathClickedSchema = z
  .object({ path: onboardingPathSchema, cohort: cohortSchema })
  .strict()
export const onboardingStep4PathFailedSchema = z
  .object({
    path: onboardingPathSchema,
    reason: onboardingFailureReasonSchema,
    cohort: cohortSchema
  })
  .strict()
export const onboardingTaskSourcesSnapshotSchema = z
  .object({
    github_status: onboardingTaskSourcesGithubStatusSchema,
    linear_status: onboardingTaskSourcesLinearStatusSchema,
    exit_action: onboardingTaskSourcesExitActionSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
export const onboardingWindowsTerminalSnapshotSchema = z
  .object({
    default_shell: onboardingWindowsTerminalShellSchema,
    right_click_behavior: onboardingWindowsTerminalRightClickSchema,
    exit_action: onboardingWindowsTerminalExitActionSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
// Why: no `is_git_repo` here; the signal moved to `repo_added.is_git_repo`.
export const onboardingCompletedSchema = z
  .object({
    path: onboardingPathSchema,
    total_duration_ms: z.number().int().nonnegative(),
    cohort: cohortSchema
  })
  .strict()
export const onboardingDismissedSchema = z
  .object({
    last_step: onboardingStepSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
export const activationChecklistItemCompletedSchema = z
  .object({
    item: onboardingChecklistItemSchema,
    time_since_completed_ms: z.number().int().nonnegative()
  })
  .strict()

// Why: disambiguates `on_path:false` rows on dashboard 1562016 (shell-hydration failure vs genuinely-not-on-PATH). See docs/agent-on-path-detection.md.
export const pathSourceSchema = z.enum(['shell_hydrate', 'sync_seed_only'])
export const pathFailureReasonSchema = z.enum([
  'none',
  'no_shell',
  'timeout',
  'spawn_error',
  'empty_path'
])

// Compile-time guard: schema enum must match `ShellHydrationFailureReason`; drift breaks the build, not runtime parsing.
export type _PathFailureReasonSync =
  z.infer<typeof pathFailureReasonSchema> extends ShellHydrationFailureReason
    ? ShellHydrationFailureReason extends z.infer<typeof pathFailureReasonSchema>
      ? true
      : never
    : never
export const _pathFailureReasonSyncCheck: _PathFailureReasonSync = true
void _pathFailureReasonSyncCheck

export type _PathSourceSync =
  z.infer<typeof pathSourceSchema> extends PathSource
    ? PathSource extends z.infer<typeof pathSourceSchema>
      ? true
      : never
    : never
export const _pathSourceSyncCheck: _PathSourceSync = true
void _pathSourceSyncCheck

// Fired at click time (captures mind-changes); `agent_kind` uses `tuiAgentToAgentKind` to keep the wire enum closed.
export const onboardingAgentPickedSchema = z
  .object({
    agent_kind: agentKindSchema,
    on_path: z.boolean(),
    detected_count: z.number().int().nonnegative(),
    // `'pending'` when detection is still running at click time (picked-before-detection vs picked-the-only-agent).
    detection_state: z.enum(['complete', 'pending']),
    // `true` when the agent lived under the "Show N more" disclosure — signals demand for less-popular agents.
    from_collapsed_section: z.boolean(),
    // Why: `.optional()` is load-bearing so pre-deploy events validate under `.strict()`. See docs/agent-on-path-detection.md.
    path_source: pathSourceSchema.optional(),
    path_failure_reason: pathFailureReasonSchema.optional(),
    cohort: cohortSchema
  })
  .strict()

// Mirrors ThemeStep.tsx DiscoveryState; `failed` is intentionally absent (it's an import outcome, see onboarding_ghostty_import_failed).
export const ghosttyDiscoveryStateSchema = z.enum(['found', 'absent', 'imported'])

// Compile-time guard: schema enum must stay in sync with the renderer's DiscoveryState; drift breaks the build, not runtime.
export type _GhosttyDiscoveryStateSync =
  z.infer<typeof ghosttyDiscoveryStateSchema> extends DiscoveryStatusEmitted
    ? DiscoveryStatusEmitted extends z.infer<typeof ghosttyDiscoveryStateSchema>
      ? true
      : never
    : never
export const _ghosttyDiscoveryStateSyncCheck: _GhosttyDiscoveryStateSync = true
void _ghosttyDiscoveryStateSyncCheck

export const onboardingGhosttyDiscoveredSchema = z
  .object({
    state: ghosttyDiscoveryStateSchema,
    // Bucketed not raw: exact group counts fingerprint heavy customizers.
    field_group_count_bucket: z.enum(['0', '1-3', '4-7', '8+']),
    cohort: cohortSchema
  })
  .strict()
export const onboardingGhosttyImportClickedSchema = z.object({ cohort: cohortSchema }).strict()

// Smart-sort telemetry: measures whether the redesign concentrates users in Class 1-3, and flags Smart→Recent abandonment as a regression.
// Why class_5: splitting the old catch-all idle class into unverifiable (4) and idle (5) moved
// what class_4 counts, so the previously-absent bucket is the one that keeps the total honest.
export const smartSortClassDistributionSchema = z
  .object({
    class_1: z.number().int().nonnegative(),
    class_2: z.number().int().nonnegative(),
    class_3: z.number().int().nonnegative(),
    class_4: z.number().int().nonnegative(),
    class_5: z.number().int().nonnegative().optional(),
    total_worktrees: z.number().int().nonnegative()
  })
  .strict()
export const smartSortClass1PromotionSchema = z
  .object({
    cause: z.enum(['blocked', 'waiting', 'title-heuristic'])
  })
  .strict()
// Why `_v` not `z.object({})`: empty zod object infers as TS `{}` ("anything"), breaking the `keyof EventMap[N]` roster probes.
export const smartToRecentSwitchSchema = z.object({ _v: z.literal(1).optional() }).strict()
export const onboardingGhosttyImportFailedSchema = z
  .object({
    // `'no_config'` is reserved for future use; call sites currently emit `'empty_diff'` or `'unknown'`.
    reason: z.enum(['no_config', 'empty_diff', 'unknown']),
    cohort: cohortSchema
  })
  .strict()
export const onboardingFeatureSetupToggledSchema = z
  .object({
    feature: onboardingFeatureSetupFeatureSchema,
    selected: z.boolean(),
    cohort: cohortSchema
  })
  .strict()
export const onboardingFeatureSetupRunSchema = z
  .object({
    ...onboardingFeatureSetupSelectionSchema,
    cli_touched: z.boolean(),
    skill_commands_copied: z.boolean(),
    skill_install_command_prepared: z.boolean(),
    computer_use_permissions_opened: z.boolean(),
    warning_count: z.number().int().nonnegative(),
    cohort: cohortSchema
  })
  // Why: validate derived selected_count at the untrusted IPC boundary rather than trust renderer callers.
  .refine(
    hasMatchingOnboardingFeatureSetupSelectedCount,
    onboardingFeatureSetupSelectedCountRefinement
  )
  .strict()
export const onboardingFeatureSetupTerminalOpenedSchema = z
  .object({
    ...onboardingFeatureSetupSelectionSchema,
    cohort: cohortSchema
  })
  .refine(
    hasMatchingOnboardingFeatureSetupSelectedCount,
    onboardingFeatureSetupSelectedCountRefinement
  )
  .strict()
export const onboardingFeatureSetupTerminalInteractedSchema = z
  .object({
    ...onboardingFeatureSetupSelectionSchema,
    method: z.enum(['keyboard', 'pointer']),
    cohort: cohortSchema
  })
  .refine(
    hasMatchingOnboardingFeatureSetupSelectedCount,
    onboardingFeatureSetupSelectedCountRefinement
  )
  .strict()
