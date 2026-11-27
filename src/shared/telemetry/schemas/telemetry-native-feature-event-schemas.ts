import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { FEATURE_WALL_MAX_DWELL_MS } from '../../feature-education/explore/feature-wall-telemetry'
import { nthRepoAddedSchema } from './telemetry-app-event-schemas'
import {
  agentKindSchema,
  featureWallExitActionSchema,
  featureWallOpenSourceSchema,
  featureWallTileIdSchema,
  featureWallTourDepthStepSchema,
  featureWallWorkflowIdSchema,
  optInViaSchema
} from './telemetry-property-schemas'

export const nativeChatViewModeSchema = lazyZodSchema(() => z.enum(['terminal', 'chat']))
export const nativeChatToggledSchema = lazyZodSchema(() =>
  z
    .object({
      from_mode: nativeChatViewModeSchema,
      to_mode: nativeChatViewModeSchema,
      agent_kind: agentKindSchema
    })
    .strict()
)
// unknown means runtime was unresolved at send time.
export const nativeChatRuntimeSchema = lazyZodSchema(() => z.enum(['local', 'remote', 'unknown']))
export type NativeChatRuntime = z.infer<typeof nativeChatRuntimeSchema>
// Which device the person typed on; the host emits phone sends, the desktop renderer its own.
export const nativeChatClientSchema = lazyZodSchema(() => z.enum(['desktop', 'mobile']))
export const nativeChatMessageSentSchema = lazyZodSchema(() =>
  z
    .object({
      agent_kind: agentKindSchema,
      runtime: nativeChatRuntimeSchema,
      client: nativeChatClientSchema
    })
    .strict()
)
// A phone opening a chat transcript or a full terminal stream, once per phone, view, surface and
// UTC day; agent_kind is absent for a plain shell.
export const mobileSessionOpenedSchema = lazyZodSchema(() =>
  z
    .object({
      surface: nativeChatViewModeSchema,
      agent_kind: agentKindSchema.optional()
    })
    .strict()
)
export const nativeChatPickerItemAcceptedSchema = lazyZodSchema(() =>
  z.object({ agent_kind: agentKindSchema, item_kind: z.enum(['command', 'skill']) }).strict()
)
/** One UTC day's picker accepts per agent and kind, rolled up locally instead of per-accept rows.
 *  Each row is the day's full count: a rare repeat after a crash has the same install, day, agent and kind, so keep one. */
export const nativeChatPickerAcceptsDailySchema = lazyZodSchema(() =>
  nativeChatPickerItemAcceptedSchema
    .extend({
      accept_count: z.number().int().positive().max(1_000_000),
      usage_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    })
    .strict()
)

export const telemetryOptedInSchema = lazyZodSchema(() =>
  z.object({ via: optInViaSchema }).strict()
)
export const telemetryOptedOutSchema = lazyZodSchema(() =>
  z.object({ via: optInViaSchema }).strict()
)

export const orcaCliFeatureTipSourceSchema = lazyZodSchema(() => z.enum(['app_open', 'manual']))
export const orcaCliFeatureTipShownSchema = lazyZodSchema(() =>
  z
    .object({
      source: orcaCliFeatureTipSourceSchema,
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)
export const orcaCliFeatureTipSetupClickedSchema = lazyZodSchema(() =>
  z
    .object({
      source: orcaCliFeatureTipSourceSchema,
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)
export const orcaCliFeatureTipSetupResultSchema = lazyZodSchema(() =>
  z
    .object({
      source: orcaCliFeatureTipSourceSchema,
      result: z.enum(['installed', 'needs_attention', 'dev_preview', 'failed']),
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)

export const cmdJPaletteFeatureTipShownSchema = lazyZodSchema(() =>
  z
    .object({
      source: orcaCliFeatureTipSourceSchema,
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)
export const cmdJPaletteFeatureTipAcknowledgedSchema = lazyZodSchema(() =>
  z
    .object({
      source: orcaCliFeatureTipSourceSchema,
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)

// Missing versions identify events emitted before the corner-card rollout.
const chatUiLaunchTipExperimentVersionSchema = lazyZodSchema(() =>
  z.enum(['corner-card-v2', 'corner-card-v3']).optional()
)
const chatUiFeatureTipVariantSchema = lazyZodSchema(() => z.enum(['chat_ui_off', 'chat_ui_on']))
export const chatUiFeatureTipShownSchema = lazyZodSchema(() =>
  z
    .object({
      launch_tip_experiment_version: chatUiLaunchTipExperimentVersionSchema,
      variant: chatUiFeatureTipVariantSchema,
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)
export const chatUiFeatureTipActionSchema = lazyZodSchema(() =>
  z
    .object({
      launch_tip_experiment_version: chatUiLaunchTipExperimentVersionSchema,
      variant: chatUiFeatureTipVariantSchema,
      action: z.enum([
        'use_chat_ui',
        'stay_in_terminal',
        'switch_to_terminal',
        'open_settings',
        'open_live_switching',
        'live_switching_shown',
        'dismissed'
      ]),
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)
// Fires in both arms when the tip would open, so control has the same exposure moment as treatment.
export const chatUiFeatureTipExposureSchema = lazyZodSchema(() =>
  z
    .object({
      launch_tip_experiment_version: chatUiLaunchTipExperimentVersionSchema,
      variant: chatUiFeatureTipVariantSchema,
      launch_tip_cohort: z.enum([
        'control',
        'treatment',
        'treatment-live-switch',
        'treatment-swapped-buttons',
        'treatment-center',
        'unassigned'
      ]),
      shown: z.boolean(),
      targeting: z.enum(['all', 'eligible-harnesses', 'not-switched']).optional(),
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)
export const agentDefaultSurfaceChangedSchema = lazyZodSchema(() =>
  z
    .object({
      from_mode: nativeChatViewModeSchema,
      to_mode: nativeChatViewModeSchema,
      source: z.enum(['launch_card', 'settings']),
      launch_tip_shown: z.boolean().optional(),
      nth_repo_added: nthRepoAddedSchema
    })
    .strict()
)

export const featureWallOpenedSchema = lazyZodSchema(() =>
  z
    .object({
      source: featureWallOpenSourceSchema
    })
    .strict()
)
export const featureWallClosedSchema = lazyZodSchema(() =>
  z
    .object({
      dwell_ms: z.number().int().min(0).max(FEATURE_WALL_MAX_DWELL_MS),
      source: featureWallOpenSourceSchema.optional(),
      exit_action: featureWallExitActionSchema.optional(),
      furthest_step: featureWallTourDepthStepSchema.optional(),
      last_group_id: featureWallWorkflowIdSchema.optional(),
      visited_workflow_count: z.number().int().min(0).max(5).optional(),
      visited_substep_count: z.number().int().min(0).max(9).optional(),
      completed_workflow_count: z.number().int().min(0).max(5).optional(),
      completed_substep_count: z.number().int().min(0).max(9).optional()
    })
    .strict()
)
export const featureWallTileFocusedSchema = lazyZodSchema(() =>
  z
    .object({
      tile_id: featureWallTileIdSchema
    })
    .strict()
)
export const featureWallTileClickedSchema = lazyZodSchema(() =>
  z
    .object({
      tile_id: featureWallTileIdSchema
    })
    .strict()
)
export const featureWallGroupSelectedSchema = lazyZodSchema(() =>
  z
    .object({
      group_id: featureWallWorkflowIdSchema,
      source: featureWallOpenSourceSchema
    })
    .strict()
)
export const featureWallFeatureSelectedSchema = lazyZodSchema(() =>
  z
    .object({
      group_id: featureWallWorkflowIdSchema,
      tile_id: featureWallTileIdSchema,
      source: featureWallOpenSourceSchema
    })
    .strict()
)
export const featureWallDocsClickedSchema = lazyZodSchema(() =>
  z
    .object({
      group_id: featureWallWorkflowIdSchema,
      tile_id: featureWallTileIdSchema,
      source: featureWallOpenSourceSchema
    })
    .strict()
)
