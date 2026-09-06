import { z } from 'zod'
import { FEATURE_WALL_MAX_DWELL_MS } from './feature-wall-telemetry'
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

// Native chat (terminal⇄chat toggle) adoption; view-mode enum mirrors `Tab.viewMode` in shared/types.ts.
export const nativeChatViewModeSchema = z.enum(['terminal', 'chat'])
export const nativeChatToggledSchema = z
  .object({
    from_mode: nativeChatViewModeSchema,
    to_mode: nativeChatViewModeSchema,
    agent_kind: agentKindSchema
  })
  .strict()
// `runtime`: local vs SSH/remote agent PTY; `'unknown'` when unresolved at send time.
export const nativeChatRuntimeSchema = z.enum(['local', 'remote', 'unknown'])
export type NativeChatRuntime = z.infer<typeof nativeChatRuntimeSchema>
export const nativeChatMessageSentSchema = z
  .object({
    agent_kind: agentKindSchema,
    runtime: nativeChatRuntimeSchema
  })
  .strict()
export const nativeChatPickerOpenedSchema = z
  .object({ agent_kind: agentKindSchema, prefix: z.enum(['slash', 'dollar']) })
  .strict()
export const nativeChatPickerItemAcceptedSchema = z
  .object({ agent_kind: agentKindSchema, item_kind: z.enum(['command', 'skill']) })
  .strict()
export const nativeChatSendClassifiedSchema = z
  .object({ agent_kind: agentKindSchema, outcome: z.enum(['chat', 'command', 'unknown-token']) })
  .strict()
export const nativeChatSkillDiscoverySchema = z
  .object({
    agent_kind: agentKindSchema,
    outcome: z.enum(['ready', 'error', 'timeout', 'unavailable']),
    execution_host_kind: z.enum(['local', 'runtime', 'ssh'])
  })
  .strict()

export const telemetryOptedInSchema = z.object({ via: optInViaSchema }).strict()
export const telemetryOptedOutSchema = z.object({ via: optInViaSchema }).strict()

export const orcaCliFeatureTipSourceSchema = z.enum(['app_open', 'manual'])
export const orcaCliFeatureTipShownSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
export const orcaCliFeatureTipSetupClickedSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
export const orcaCliFeatureTipSetupResultSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    result: z.enum(['installed', 'needs_attention', 'dev_preview', 'failed']),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

export const cmdJPaletteFeatureTipShownSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
export const cmdJPaletteFeatureTipAcknowledgedSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

export const featureWallOpenedSchema = z
  .object({
    source: featureWallOpenSourceSchema
  })
  .strict()
export const featureWallClosedSchema = z
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
export const featureWallTileFocusedSchema = z
  .object({
    tile_id: featureWallTileIdSchema
  })
  .strict()
export const featureWallTileClickedSchema = z
  .object({
    tile_id: featureWallTileIdSchema
  })
  .strict()
export const featureWallGroupSelectedSchema = z
  .object({
    group_id: featureWallWorkflowIdSchema,
    source: featureWallOpenSourceSchema
  })
  .strict()
export const featureWallFeatureSelectedSchema = z
  .object({
    group_id: featureWallWorkflowIdSchema,
    tile_id: featureWallTileIdSchema,
    source: featureWallOpenSourceSchema
  })
  .strict()
export const featureWallDocsClickedSchema = z
  .object({
    group_id: featureWallWorkflowIdSchema,
    tile_id: featureWallTileIdSchema,
    source: featureWallOpenSourceSchema
  })
  .strict()
