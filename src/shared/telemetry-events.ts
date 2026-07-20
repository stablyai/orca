/* eslint-disable max-lines -- Why: this is the single source of truth for every telemetry event schema, enum, and the cohort-injection set predicates. Splitting it would scatter the .strict() / Zod-first doctrine across files and break the EventMap derivation that makes adding an event a one-line change. */
// Single source of truth for telemetry event names, schemas, and enums.
// Zod-first: `EventMap` is `z.infer`-derived from the same `eventSchemas` record the runtime validator consumes — no parallel union to drift.
// `.strict()` on every object schema is the runtime "no extra keys"; free-form strings carry an explicit `.max(N)` cap.

import { z } from 'zod'
import { FEATURE_WALL_MAX_DWELL_MS } from './feature-wall-telemetry'
import { FEATURE_WALL_EXIT_ACTIONS, FEATURE_WALL_TOUR_DEPTH_STEPS } from './feature-wall-tour-depth'
import {
  CONTEXTUAL_TOUR_OUTCOMES,
  FEATURE_EDUCATION_CONTEXTUAL_TOUR_IDS,
  FEATURE_EDUCATION_SOURCES,
  SETUP_GUIDE_CLOSE_OUTCOMES,
  SETUP_GUIDE_SOURCES,
  TERMINAL_PANE_SPLIT_SOURCES
} from './feature-education-telemetry'
import { FEATURE_WALL_SETUP_STEP_IDS } from './feature-wall-setup-steps'
import {
  FEATURE_INTERACTION_CATEGORIES,
  FEATURE_INTERACTION_IDS,
  FEATURE_INTERACTION_USAGE_BUCKETS,
  getFeatureInteractionCategory
} from './feature-interactions'
import { SETUP_SCRIPT_IMPORT_PROVIDERS } from './setup-script-import-providers'
import { WORKSPACE_SOURCE_VALUES, type WorkspaceSource } from './workspace-source'
import { appStarSourceSchema } from './gh-star-source'
import {
  starNagAgentBucketSchema,
  starNagOutcomeSchema,
  starNagPromptModeSchema,
  starNagPromptSourceSchema
} from './star-nag-telemetry'
import {
  NESTED_REPO_COUNT_BUCKETS,
  NESTED_REPO_IMPORT_ACTIONS,
  NESTED_REPO_IMPORT_OUTCOMES,
  NESTED_REPO_SCAN_RESULTS,
  NESTED_REPO_TELEMETRY_MAX_REPO_COUNT,
  NESTED_REPO_TELEMETRY_RUNTIME_KINDS,
  NESTED_REPO_TELEMETRY_SURFACES,
  bucketNestedRepoTelemetryCount
} from './nested-repo-telemetry'

import { AGENT_HOOK_TARGETS } from './agent-hook-types'
import type {
  DiscoveryStatusEmitted,
  GlobalSettings,
  OnboardingChecklistState,
  PathSource,
  ShellHydrationFailureReason
} from './types'

// ── Shared property enums ───────────────────────────────────────────────

// Mirrors `TuiAgent` launch surface; `claude`↔`claude-code` (product, not CLI string). `other` is the escape hatch; see `tuiAgentToAgentKind`.
export const AGENT_KIND_VALUES = [
  'claude-code',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'autohand',
  'opencode',
  'mimo-code',
  'pi',
  'omp',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'cline',
  'codebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'openclaw',
  'copilot',
  'grok',
  'devin',
  'ante',
  'other'
] as const
export const agentKindSchema = z.enum(AGENT_KIND_VALUES)
export type AgentKind = z.infer<typeof agentKindSchema>

// Small set: only failures Orca's PTY-typed-command launch can observe (`binary_not_found` = shell ENOENT, `paste_readiness_timeout`, `unknown`).
// Provider-side errors (auth/rate-limit/network) happen inside the agent CLI subprocess and are invisible to Orca. See telemetry-plan.md §Defer per-incident error fields.
export const errorClassSchema = z.enum(['binary_not_found', 'paste_readiness_timeout', 'unknown'])
export type ErrorClass = z.infer<typeof errorClassSchema>

export const repoMethodSchema = z.enum(['folder_picker', 'clone_url', 'drag_drop'])
export type RepoMethod = z.infer<typeof repoMethodSchema>

// Historical setup-step choices (current flows skip that screen); kept for pre-rollout rows and compatibility.
export const addRepoSetupStepActionSchema = z.enum([
  'open_primary',
  'create_worktree',
  'configure',
  'skip',
  'open_existing',
  'back'
])
export type AddRepoSetupStepAction = z.infer<typeof addRepoSetupStepActionSchema>

export const addRepoExistingWorkspaceSourceSchema = z.enum([
  'local_folder_picker',
  'runtime_server_path',
  'ssh_remote_path',
  'clone_url',
  'create_project'
])
export type AddRepoExistingWorkspaceSource = z.infer<typeof addRepoExistingWorkspaceSourceSchema>
export const addRepoDefaultCheckoutHandoffSourceSchema = z.enum([
  'local_folder_picker',
  'runtime_server_path',
  'ssh_remote_path',
  'clone_url',
  'create_project',
  'onboarding_open_folder',
  'onboarding_clone_url',
  'project_added_compat'
])
export type AddRepoDefaultCheckoutHandoffSource = z.infer<
  typeof addRepoDefaultCheckoutHandoffSourceSchema
>
export const addRepoDefaultCheckoutHandoffResultSchema = z.enum([
  'opened_default_checkout',
  'revealed_project'
])
export const addRepoDefaultCheckoutHandoffReasonSchema = z.enum([
  'loaded_default_checkout',
  'detected_default_checkout',
  'no_authoritative_detection',
  'no_default_checkout',
  'show_detected_default_failed',
  'show_detected_linked_failed',
  'authoritative_refresh_failed',
  'linked_external_refresh_failed',
  'refreshed_default_missing'
])

export const setupScriptImportProviderSchema = z.enum(SETUP_SCRIPT_IMPORT_PROVIDERS)
export type SetupScriptImportProviderTelemetry = z.infer<typeof setupScriptImportProviderSchema>

// Separate enum from `errorClassSchema` — different domain (git/filesystem worktree-create failures); merging would couple the two forever.
export const workspaceCreateErrorClassSchema = z.enum([
  'git_failed',
  'path_collision',
  'permission_denied',
  'base_ref_missing',
  'unknown'
])
export type WorkspaceCreateErrorClass = z.infer<typeof workspaceCreateErrorClassSchema>

export const workspaceSourceSchema = z.enum(WORKSPACE_SOURCE_VALUES)
export type { WorkspaceSource }

export const launchSourceSchema = z.enum([
  'command_palette',
  'sidebar',
  'quick_command',
  'tab_bar_quick_launch',
  'task_page',
  'new_workspace_composer',
  'workspace_jump_palette',
  'shortcut',
  'onboarding',
  'diff_notes_send',
  'notes_send',
  'conflict_resolution',
  'source_control_recovery',
  'terminal_context_menu',
  'unknown'
])
export type LaunchSource = z.infer<typeof launchSourceSchema>

export const requestKindSchema = z.enum(['new', 'resume', 'followup'])
export type RequestKind = z.infer<typeof requestKindSchema>

export const featureWallTileIdSchema = z.enum([
  'tile-01',
  'tile-02',
  'tile-03',
  'tile-04',
  'tile-05',
  'tile-06',
  'tile-07',
  'tile-08',
  'tile-09',
  'tile-10',
  'tile-11',
  'tile-12'
])
export type FeatureWallTileIdTelemetry = z.infer<typeof featureWallTileIdSchema>

export const featureWallOpenSourceSchema = z.enum(['help_menu', 'popup', 'onboarding', 'unknown'])
export type FeatureWallOpenSourceTelemetry = z.infer<typeof featureWallOpenSourceSchema>

export const featureWallWorkflowIdSchema = z.enum([
  'tasks',
  'workspaces',
  'agents-orchestration',
  'workbench',
  'review'
])
export type FeatureWallWorkflowIdTelemetry = z.infer<typeof featureWallWorkflowIdSchema>

export const featureWallTourDepthStepSchema = z.enum(FEATURE_WALL_TOUR_DEPTH_STEPS)
export type FeatureWallTourDepthStepTelemetry = z.infer<typeof featureWallTourDepthStepSchema>

export const featureWallExitActionSchema = z.enum(FEATURE_WALL_EXIT_ACTIONS)
export type FeatureWallExitActionTelemetry = z.infer<typeof featureWallExitActionSchema>

// `env_var` absent — env-var/CI paths override consent at runtime only, never firing an opt-in/out event.
// `first_launch_notice` absent — the new-user cohort has no first-launch surface; those opt-outs come via `'settings'`.
export const optInViaSchema = z.enum(['first_launch_banner', 'settings'])
export type OptInVia = z.infer<typeof optInViaSchema>

// Whitelist of settings emittable on `settings_changed`. `orca_channel` (build-time, not user-togglable) is absent.
// The telemetry opt-in toggle is also absent — it fires dedicated `telemetry_opted_in/out` events; listing it would double-fire.
type BooleanGlobalSettingsKey = {
  // Why: new toggles may be optional for legacy-settings compat but are still boolean once defaulted.
  [Key in keyof GlobalSettings]-?: NonNullable<GlobalSettings[Key]> extends boolean ? Key : never
}[keyof GlobalSettings]
export const SETTINGS_CHANGED_WHITELIST = [
  'editorAutoSave',
  'openLinksInApp',
  'experimentalMobile',
  'experimentalPet',
  'experimentalNativeChat',
  'experimentalActivity',
  'experimentalTerminalAttention',
  'experimentalAgentHibernation',
  'experimentalEphemeralVms',
  'geminiCliOAuthEnabled',
  'openAgentTabsInChatByDefault'
] as const satisfies readonly BooleanGlobalSettingsKey[]
export const settingsChangedKeySchema = z.enum(SETTINGS_CHANGED_WHITELIST)
export type SettingsChangedKey = z.infer<typeof settingsChangedKeySchema>

// ── Per-event schemas ───────────────────────────────────────────────────

// Cohort signal (repo count at emit time); `.optional()` lets a fail-soft `undefined` validate. See docs/onboarding-funnel-cohort-addendum.md.
const nthRepoAddedSchema = z.number().int().nonnegative().optional()

const appOpenedSchema = z.object({ nth_repo_added: nthRepoAddedSchema }).strict()

export const featureInteractionIdSchema = z.enum(FEATURE_INTERACTION_IDS)
export const featureInteractionCategorySchema = z.enum(FEATURE_INTERACTION_CATEGORIES)
export const featureInteractionUsageBucketSchema = z.enum(FEATURE_INTERACTION_USAGE_BUCKETS)
export const featureInteractionUsageBucketSourceSchema = z.enum([
  'crossed_now',
  'observed_existing'
])
const featureInteractionUsageBucketReachedSchema = z
  .object({
    feature_id: featureInteractionIdSchema,
    feature_category: featureInteractionCategorySchema,
    count_bucket: featureInteractionUsageBucketSchema,
    bucket_source: featureInteractionUsageBucketSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
  .refine((value) => getFeatureInteractionCategory(value.feature_id) === value.feature_category, {
    message: 'feature_category must match feature_id',
    path: ['feature_category']
  })

const repoAddedSchema = z
  // Why: `.optional()` so paths that can't detect git-ness validate cleanly; never default-guess `false` — omit instead.
  .object({
    method: repoMethodSchema,
    is_git_repo: z.boolean().optional(),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

const appStarredOrcaSchema = z
  .object({
    source: appStarSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

const starNagOutcomeEventSchema = z
  .object({
    outcome: starNagOutcomeSchema,
    source: starNagPromptSourceSchema,
    mode: starNagPromptModeSchema,
    threshold: z.number().int().positive(),
    agents_since_baseline: z.number().int().nonnegative(),
    agents_since_baseline_bucket: starNagAgentBucketSchema,
    nth_repo_added: nthRepoAddedSchema,
    next_threshold: z.number().int().positive().optional(),
    cooldown_days: z.number().int().positive().optional()
  })
  .strict()
  .refine(
    (payload) =>
      payload.next_threshold === undefined ||
      payload.outcome === 'dismissed' ||
      payload.outcome === 'later',
    {
      message: 'next_threshold is only valid for later or dismissed outcomes',
      path: ['next_threshold']
    }
  )
  .refine(
    (payload) =>
      payload.cooldown_days === undefined ||
      payload.outcome === 'later' ||
      payload.outcome === 'dismissed',
    {
      message: 'cooldown_days is only valid for later or dismissed outcomes',
      path: ['cooldown_days']
    }
  )

const workspaceCreatedSchema = z
  .object({
    source: workspaceSourceSchema,
    from_existing_branch: z.boolean(),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

const agentStartedSchema = z
  .object({
    agent_kind: agentKindSchema,
    launch_source: launchSourceSchema,
    request_kind: requestKindSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
const agentPromptSentSchema = z
  .object({
    agent_kind: agentKindSchema,
    launch_source: launchSourceSchema,
    request_kind: requestKindSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

// Enum-only by design: `.strict()` blocks `error_message`/`error_stack`, keeping raw user/path content off the wire.
const agentErrorSchema = z
  .object({
    error_class: errorClassSchema,
    agent_kind: agentKindSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

// Why: daemon start-failure signal (fleet-wide outage like v1.4.129-rc.1); enum-only so raw stderr never reaches the wire.
const daemonStartFailedSchema = z.object({ error_class: errorClassSchema }).strict()

const settingsChangedSchema = z
  .object({
    setting_key: settingsChangedKeySchema,
    value_kind: z.enum(['bool', 'enum'])
  })
  .strict()

// Native chat (terminal⇄chat toggle) adoption; view-mode enum mirrors `Tab.viewMode` in shared/types.ts.
const nativeChatViewModeSchema = z.enum(['terminal', 'chat'])
const nativeChatToggledSchema = z
  .object({
    from_mode: nativeChatViewModeSchema,
    to_mode: nativeChatViewModeSchema,
    agent_kind: agentKindSchema
  })
  .strict()
// `runtime`: local vs SSH/remote agent PTY; `'unknown'` when unresolved at send time.
const nativeChatRuntimeSchema = z.enum(['local', 'remote', 'unknown'])
export type NativeChatRuntime = z.infer<typeof nativeChatRuntimeSchema>
const nativeChatMessageSentSchema = z
  .object({
    agent_kind: agentKindSchema,
    runtime: nativeChatRuntimeSchema
  })
  .strict()
const nativeChatPickerOpenedSchema = z
  .object({ agent_kind: agentKindSchema, prefix: z.enum(['slash', 'dollar']) })
  .strict()
const nativeChatPickerItemAcceptedSchema = z
  .object({ agent_kind: agentKindSchema, item_kind: z.enum(['command', 'skill']) })
  .strict()
const nativeChatSendClassifiedSchema = z
  .object({ agent_kind: agentKindSchema, outcome: z.enum(['chat', 'command', 'unknown-token']) })
  .strict()
const nativeChatSkillDiscoverySchema = z
  .object({
    agent_kind: agentKindSchema,
    outcome: z.enum(['ready', 'error', 'timeout', 'unavailable']),
    execution_host_kind: z.enum(['local', 'runtime', 'ssh'])
  })
  .strict()

const telemetryOptedInSchema = z.object({ via: optInViaSchema }).strict()
const telemetryOptedOutSchema = z.object({ via: optInViaSchema }).strict()

const orcaCliFeatureTipSourceSchema = z.enum(['app_open', 'manual'])
const orcaCliFeatureTipShownSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
const orcaCliFeatureTipSetupClickedSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
const orcaCliFeatureTipSetupResultSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    result: z.enum(['installed', 'needs_attention', 'dev_preview', 'failed']),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

const cmdJPaletteFeatureTipShownSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
const cmdJPaletteFeatureTipAcknowledgedSchema = z
  .object({
    source: orcaCliFeatureTipSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

const featureWallOpenedSchema = z
  .object({
    source: featureWallOpenSourceSchema
  })
  .strict()
const featureWallClosedSchema = z
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
const featureWallTileFocusedSchema = z
  .object({
    tile_id: featureWallTileIdSchema
  })
  .strict()
const featureWallTileClickedSchema = z
  .object({
    tile_id: featureWallTileIdSchema
  })
  .strict()
const featureWallGroupSelectedSchema = z
  .object({
    group_id: featureWallWorkflowIdSchema,
    source: featureWallOpenSourceSchema
  })
  .strict()
const featureWallFeatureSelectedSchema = z
  .object({
    group_id: featureWallWorkflowIdSchema,
    tile_id: featureWallTileIdSchema,
    source: featureWallOpenSourceSchema
  })
  .strict()
const featureWallDocsClickedSchema = z
  .object({
    group_id: featureWallWorkflowIdSchema,
    tile_id: featureWallTileIdSchema,
    source: featureWallOpenSourceSchema
  })
  .strict()

const existingWorkspaceCountSchema = z.number().int().min(1).max(50)
const addRepoExistingWorkspaceContextSchema = {
  source: addRepoExistingWorkspaceSourceSchema,
  existing_workspace_count: existingWorkspaceCountSchema,
  existing_linked_workspace_count: z.number().int().min(0).max(50)
} as const

const addRepoSetupStepActionEventSchema = z
  .object({
    action: addRepoSetupStepActionSchema,
    source: addRepoExistingWorkspaceSourceSchema.optional(),
    existing_workspace_count: existingWorkspaceCountSchema.optional(),
    existing_linked_workspace_count: z.number().int().min(0).max(50).optional(),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
const addRepoExistingWorkspacesDetectedSchema = z
  .object({
    ...addRepoExistingWorkspaceContextSchema,
    main_workspace_count: z.number().int().min(0).max(50),
    branch_named_workspace_count: z.number().int().min(0).max(50),
    detached_workspace_count: z.number().int().min(0).max(50),
    custom_named_workspace_count: z.number().int().min(0).max(50),
    sparse_workspace_count: z.number().int().min(0).max(50),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
const addRepoDefaultCheckoutHandoffSchema = z
  .object({
    source: addRepoDefaultCheckoutHandoffSourceSchema,
    result: addRepoDefaultCheckoutHandoffResultSchema,
    reason: addRepoDefaultCheckoutHandoffReasonSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

// Why: enum-only like `agent_error` — `.strict()` blocks raw error strings from ever crossing the wire.
const workspaceCreateFailedSchema = z
  .object({
    source: workspaceSourceSchema,
    error_class: workspaceCreateErrorClassSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

const setupScriptPromptModeSchema = z.enum(['import_available', 'configure_needed'])
const setupScriptCountBucketSchema = z.enum(['0', '1', '2-3', '4+'])
const setupScriptPromptContextSchema = {
  mode: setupScriptPromptModeSchema,
  // Why: superRefine (not transform) keeps the top-level ZodObject shape that cohort injection probes.
  provider: setupScriptImportProviderSchema.optional(),
  file_count_bucket: setupScriptCountBucketSchema,
  unsupported_field_count_bucket: setupScriptCountBucketSchema,
  has_shared_hooks: z.boolean(),
  nth_repo_added: nthRepoAddedSchema
} as const

type SetupScriptPromptContextTelemetry = {
  mode: z.infer<typeof setupScriptPromptModeSchema>
  provider?: z.infer<typeof setupScriptImportProviderSchema>
}

function validateSetupScriptPromptProvider(
  props: SetupScriptPromptContextTelemetry,
  ctx: z.RefinementCtx
): void {
  if (props.mode === 'import_available' && props.provider === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['provider'],
      message: 'provider is required when a setup candidate is available'
    })
  }
  if (props.mode === 'configure_needed' && props.provider !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['provider'],
      message: 'provider is only valid when a setup candidate is available'
    })
  }
}
// Why: retention-cohort telemetry, not repo debugging — closed enums and count buckets only.
const setupScriptPromptShownSchema = z
  .object(setupScriptPromptContextSchema)
  .strict()
  .superRefine(validateSetupScriptPromptProvider)
const setupScriptDetectedSaveActions = [
  'save_detected_setup_clicked',
  'save_detected_setup_completed',
  'save_detected_setup_failed'
] as const

function isSetupScriptDetectedSaveAction(action: unknown): boolean {
  return setupScriptDetectedSaveActions.includes(action as never)
}

function validateSetupScriptPromptAction(
  props: SetupScriptPromptContextTelemetry & {
    action?: string
    edited_before_save?: boolean
  },
  ctx: z.RefinementCtx
): void {
  validateSetupScriptPromptProvider(props, ctx)
  const isDetectedSave = isSetupScriptDetectedSaveAction(props.action)
  if (isDetectedSave && props.provider !== 'package-manager') {
    ctx.addIssue({
      code: 'custom',
      path: ['provider'],
      message: 'detected setup save actions require the package-manager provider'
    })
  }
  if (isDetectedSave && props.edited_before_save === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['edited_before_save'],
      message: 'edited_before_save is required for detected setup save actions'
    })
  }
  if (!isDetectedSave && props.edited_before_save !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['edited_before_save'],
      message: 'edited_before_save is only valid for detected setup save actions'
    })
  }
}

const setupScriptPromptActionSchema = z
  .object({
    ...setupScriptPromptContextSchema,
    action: z.enum([
      'import_completed',
      'import_failed',
      'configure_clicked',
      'dismissed',
      ...setupScriptDetectedSaveActions
    ]),
    edited_before_save: z.boolean().optional()
  })
  .strict()
  .superRefine(validateSetupScriptPromptAction)

// Managed-hook installer label from `AGENT_HOOK_TARGETS`, distinct from `AGENT_KIND_VALUES`; `claude` (not `claude-code`) is intentional.
export const hookInstallAgentSchema = z.enum(AGENT_HOOK_TARGETS)
export type HookInstallAgent = z.infer<typeof hookInstallAgentSchema>

// Why: config-shape errors (not user content); callers must truncate before `track` — `.max(200)` drops overlength strings.
const agentHookInstallFailedSchema = z
  .object({
    agent: hookInstallAgentSchema,
    error_message: z.string().max(200)
  })
  .strict()

// Why: regression signal for paneKey attribution — a hook event that can't route to a pane. See docs/cli-terminal-hook-pane-key.md.
const agentHookUnattributedSchema = z
  .object({ reason: z.enum(['empty_pane_key', 'unknown_tab_id']) })
  .strict()

// ── Onboarding ──────────────────────────────────────────────────────────
// Closed enums only — no raw paths/repo names/URLs/error strings (measures activation, not repo debugging).
// Why: event names still carry legacy seven-step payloads; keep validation backward-compatible for old rows.
const ONBOARDING_TELEMETRY_LEGACY_MAX_STEP = 7
const onboardingStepSchema = z.number().int().min(1).max(ONBOARDING_TELEMETRY_LEGACY_MAX_STEP)
const onboardingPathSchema = z.enum(['open_folder', 'clone_url', 'add_project_modal'])
const onboardingFailureReasonSchema = z.enum([
  'invalid_path',
  'clone_failed',
  'cancelled',
  'unknown'
])
const onboardingValueKindSchema = z.enum([
  'agent',
  'theme',
  'notifications',
  'agent_setup',
  'integrations',
  'windows_terminal',
  'tour',
  'repo'
])
const onboardingTourOutcomeSchema = z.enum(['skipped_intro', 'started_partial', 'completed_inline'])
const onboardingTaskSourcesGithubStatusSchema = z.enum([
  'connected',
  'not_authenticated',
  'not_installed',
  'checking',
  'unknown'
])
const onboardingTaskSourcesLinearStatusSchema = z.enum([
  'connected',
  'not_connected',
  'checking',
  'unknown'
])
const onboardingTaskSourcesExitActionSchema = z.enum(['continue', 'skip_to_project_setup'])
const onboardingWindowsTerminalShellSchema = z.enum([
  'powershell',
  'command_prompt',
  'git_bash',
  'wsl',
  'other'
])
const onboardingWindowsTerminalRightClickSchema = z.enum(['paste', 'menu'])
const onboardingWindowsTerminalExitActionSchema = z.enum(['continue', 'skip_to_project_setup'])
// `dismissed` is intentionally excluded — it's a UI panel-visibility flag, not an activation event.
const onboardingChecklistItemSchema = z.enum([
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
const onboardingFeatureSetupFeatureSchema = z.enum([
  'browser_use',
  'computer_use',
  'orchestration',
  'linear_tickets'
])
const onboardingFeatureSetupSelectionSchema = {
  browser_use: z.boolean(),
  computer_use: z.boolean(),
  linear_tickets: z.boolean(),
  orchestration: z.boolean(),
  selected_count: z.number().int().min(0).max(3)
} as const
type OnboardingFeatureSetupSelectionTelemetry = {
  browser_use: boolean
  computer_use: boolean
  linear_tickets: boolean
  orchestration: boolean
  selected_count: number
}
const onboardingFeatureSetupSelectedCountRefinement = {
  path: ['selected_count'],
  message: 'selected_count must match selected feature flags'
}

function hasMatchingOnboardingFeatureSetupSelectedCount(
  props: OnboardingFeatureSetupSelectionTelemetry
): boolean {
  // Why: Linear ticket setup is a recommended add-on and excluded from progress metrics.
  const selectedCount =
    (props.browser_use ? 1 : 0) + (props.computer_use ? 1 : 0) + (props.orchestration ? 1 : 0)
  return props.selected_count === selectedCount
}

// Compile-time guard: enum must match OnboardingChecklistState activation keys (minus UI-only `dismissed`); drift breaks the build.
type _OnboardingChecklistItemSync =
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
const _onboardingChecklistItemSyncCheck: _OnboardingChecklistItemSync = true
void _onboardingChecklistItemSyncCheck

// Cohort discriminator for onboarding events; `.optional()` is load-bearing so `.strict()` accepts the `undefined` fallback.
const cohortSchema = z.enum(['fresh_install', 'upgrade_backfill']).optional()

const nestedRepoTelemetrySurfaceSchema = z.enum(NESTED_REPO_TELEMETRY_SURFACES)
const nestedRepoTelemetryRuntimeKindSchema = z.enum(NESTED_REPO_TELEMETRY_RUNTIME_KINDS)
const nestedRepoCountSchema = z.number().int().min(0).max(NESTED_REPO_TELEMETRY_MAX_REPO_COUNT)
const nestedRepoCountBucketSchema = z.enum(NESTED_REPO_COUNT_BUCKETS)
const nestedRepoScanResultSchema = z.enum(NESTED_REPO_SCAN_RESULTS)
const nestedRepoImportActionSchema = z.enum(NESTED_REPO_IMPORT_ACTIONS)
const nestedRepoImportOutcomeSchema = z.enum(NESTED_REPO_IMPORT_OUTCOMES)
const nestedRepoScanPathKindSchema = z.enum(['git_repo', 'non_git_folder'])
const nestedRepoImportModeSchema = z.enum(['group', 'separate'])
const nestedRepoAttemptIdSchema = z.string().uuid()

function validateNestedRepoCountBucket(
  props: Record<string, unknown>,
  countKey: string,
  bucketKey: string,
  ctx: z.RefinementCtx
): void {
  const count = props[countKey]
  const bucket = props[bucketKey]
  if (typeof count !== 'number' || typeof bucket !== 'string') {
    return
  }
  if (bucketNestedRepoTelemetryCount(count) !== bucket) {
    ctx.addIssue({
      code: 'custom',
      path: [bucketKey],
      message: `${bucketKey} must match ${countKey}`
    })
  }
}

function validateNestedRepoCountBuckets(
  props: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  validateNestedRepoCountBucket(props, 'found_count', 'found_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'selected_count', 'selected_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'imported_count', 'imported_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'already_known_count', 'already_known_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'failed_count', 'failed_count_bucket', ctx)
}

const nestedRepoTelemetryBaseSchema = {
  // Why: high-cardinality but random and non-persistent — correlates scan→action→result without path-derived IDs.
  attempt_id: nestedRepoAttemptIdSchema,
  surface: nestedRepoTelemetrySurfaceSchema,
  runtime_kind: nestedRepoTelemetryRuntimeKindSchema,
  nth_repo_added: nthRepoAddedSchema
} as const

const addRepoNestedScanResultSchema = z
  .object({
    ...nestedRepoTelemetryBaseSchema,
    result: nestedRepoScanResultSchema,
    selected_path_kind: nestedRepoScanPathKindSchema.optional(),
    found_count: nestedRepoCountSchema,
    found_count_bucket: nestedRepoCountBucketSchema,
    truncated: z.boolean(),
    timed_out: z.boolean()
  })
  .strict()
  .superRefine(validateNestedRepoCountBuckets)

const addRepoNestedImportActionSchema = z
  .object({
    ...nestedRepoTelemetryBaseSchema,
    action: nestedRepoImportActionSchema,
    found_count: nestedRepoCountSchema,
    found_count_bucket: nestedRepoCountBucketSchema,
    selected_count: nestedRepoCountSchema,
    selected_count_bucket: nestedRepoCountBucketSchema,
    all_selected: z.boolean()
  })
  .strict()
  .superRefine(validateNestedRepoCountBuckets)

const addRepoNestedImportResultSchema = z
  .object({
    ...nestedRepoTelemetryBaseSchema,
    mode: nestedRepoImportModeSchema,
    outcome: nestedRepoImportOutcomeSchema,
    found_count: nestedRepoCountSchema,
    found_count_bucket: nestedRepoCountBucketSchema,
    selected_count: nestedRepoCountSchema,
    selected_count_bucket: nestedRepoCountBucketSchema,
    imported_count: nestedRepoCountSchema,
    imported_count_bucket: nestedRepoCountBucketSchema,
    already_known_count: nestedRepoCountSchema,
    already_known_count_bucket: nestedRepoCountBucketSchema,
    failed_count: nestedRepoCountSchema,
    failed_count_bucket: nestedRepoCountBucketSchema,
    all_selected: z.boolean()
  })
  .strict()
  .superRefine(validateNestedRepoCountBuckets)

// Uniform button/keyboard shape lets keyboard skip/dismiss paths arrive without a schema migration.
const advancedViaSchema = z.enum(['button', 'keyboard']).optional()

const onboardingStartedSchema = z
  .object({ resumed_from_step: onboardingStepSchema.optional(), cohort: cohortSchema })
  .strict()
const onboardingStepViewedSchema = z
  .object({
    step: onboardingStepSchema,
    value_kind: onboardingValueKindSchema,
    cohort: cohortSchema
  })
  .strict()
const onboardingStepCompletedSchema = z
  .object({
    step: onboardingStepSchema,
    value_kind: onboardingValueKindSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
const onboardingStepSkippedSchema = z
  .object({
    step: onboardingStepSchema,
    value_kind: onboardingValueKindSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
type OnboardingTourOutcomeTelemetry = {
  outcome: z.infer<typeof onboardingTourOutcomeSchema>
  tour_dwell_ms?: number
  furthest_step?: z.infer<typeof featureWallTourDepthStepSchema>
  visited_workflow_count?: number
  visited_substep_count?: number
  completed_workflow_count?: number
  completed_substep_count?: number
}

function validateOnboardingTourOutcome(
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

const onboardingTourOutcomeEventSchema = z
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
const onboardingStep4PathClickedSchema = z
  .object({ path: onboardingPathSchema, cohort: cohortSchema })
  .strict()
const onboardingStep4PathFailedSchema = z
  .object({
    path: onboardingPathSchema,
    reason: onboardingFailureReasonSchema,
    cohort: cohortSchema
  })
  .strict()
const onboardingTaskSourcesSnapshotSchema = z
  .object({
    github_status: onboardingTaskSourcesGithubStatusSchema,
    linear_status: onboardingTaskSourcesLinearStatusSchema,
    exit_action: onboardingTaskSourcesExitActionSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
const onboardingWindowsTerminalSnapshotSchema = z
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
const onboardingCompletedSchema = z
  .object({
    path: onboardingPathSchema,
    total_duration_ms: z.number().int().nonnegative(),
    cohort: cohortSchema
  })
  .strict()
const onboardingDismissedSchema = z
  .object({
    last_step: onboardingStepSchema,
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
const activationChecklistItemCompletedSchema = z
  .object({
    item: onboardingChecklistItemSchema,
    time_since_completed_ms: z.number().int().nonnegative()
  })
  .strict()

// Why: disambiguates `on_path:false` rows on dashboard 1562016 (shell-hydration failure vs genuinely-not-on-PATH). See docs/agent-on-path-detection.md.
const pathSourceSchema = z.enum(['shell_hydrate', 'sync_seed_only'])
const pathFailureReasonSchema = z.enum(['none', 'no_shell', 'timeout', 'spawn_error', 'empty_path'])

// Compile-time guard: schema enum must match `ShellHydrationFailureReason`; drift breaks the build, not runtime parsing.
type _PathFailureReasonSync =
  z.infer<typeof pathFailureReasonSchema> extends ShellHydrationFailureReason
    ? ShellHydrationFailureReason extends z.infer<typeof pathFailureReasonSchema>
      ? true
      : never
    : never
const _pathFailureReasonSyncCheck: _PathFailureReasonSync = true
void _pathFailureReasonSyncCheck

type _PathSourceSync =
  z.infer<typeof pathSourceSchema> extends PathSource
    ? PathSource extends z.infer<typeof pathSourceSchema>
      ? true
      : never
    : never
const _pathSourceSyncCheck: _PathSourceSync = true
void _pathSourceSyncCheck

// Fired at click time (captures mind-changes); `agent_kind` uses `tuiAgentToAgentKind` to keep the wire enum closed.
const onboardingAgentPickedSchema = z
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
const ghosttyDiscoveryStateSchema = z.enum(['found', 'absent', 'imported'])

// Compile-time guard: schema enum must stay in sync with the renderer's DiscoveryState; drift breaks the build, not runtime.
type _GhosttyDiscoveryStateSync =
  z.infer<typeof ghosttyDiscoveryStateSchema> extends DiscoveryStatusEmitted
    ? DiscoveryStatusEmitted extends z.infer<typeof ghosttyDiscoveryStateSchema>
      ? true
      : never
    : never
const _ghosttyDiscoveryStateSyncCheck: _GhosttyDiscoveryStateSync = true
void _ghosttyDiscoveryStateSyncCheck

const onboardingGhosttyDiscoveredSchema = z
  .object({
    state: ghosttyDiscoveryStateSchema,
    // Bucketed not raw: exact group counts fingerprint heavy customizers.
    field_group_count_bucket: z.enum(['0', '1-3', '4-7', '8+']),
    cohort: cohortSchema
  })
  .strict()
const onboardingGhosttyImportClickedSchema = z.object({ cohort: cohortSchema }).strict()

// Smart-sort telemetry: measures whether the redesign concentrates users in Class 1-3, and flags Smart→Recent abandonment as a regression.
const smartSortClassDistributionSchema = z
  .object({
    class_1: z.number().int().nonnegative(),
    class_2: z.number().int().nonnegative(),
    class_3: z.number().int().nonnegative(),
    class_4: z.number().int().nonnegative(),
    total_worktrees: z.number().int().nonnegative()
  })
  .strict()
const smartSortClass1PromotionSchema = z
  .object({
    cause: z.enum(['blocked', 'waiting', 'title-heuristic'])
  })
  .strict()
// Why `_v` not `z.object({})`: empty zod object infers as TS `{}` ("anything"), breaking the `keyof EventMap[N]` roster probes.
const smartToRecentSwitchSchema = z.object({ _v: z.literal(1).optional() }).strict()
const onboardingGhosttyImportFailedSchema = z
  .object({
    // `'no_config'` is reserved for future use; call sites currently emit `'empty_diff'` or `'unknown'`.
    reason: z.enum(['no_config', 'empty_diff', 'unknown']),
    cohort: cohortSchema
  })
  .strict()
const onboardingFeatureSetupToggledSchema = z
  .object({
    feature: onboardingFeatureSetupFeatureSchema,
    selected: z.boolean(),
    cohort: cohortSchema
  })
  .strict()
const onboardingFeatureSetupRunSchema = z
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
const onboardingFeatureSetupTerminalOpenedSchema = z
  .object({
    ...onboardingFeatureSetupSelectionSchema,
    cohort: cohortSchema
  })
  .refine(
    hasMatchingOnboardingFeatureSetupSelectedCount,
    onboardingFeatureSetupSelectedCountRefinement
  )
  .strict()
const onboardingFeatureSetupTerminalInteractedSchema = z
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

const featureEducationSourceSchema = z.enum(FEATURE_EDUCATION_SOURCES)
const featureEducationContextualTourIdSchema = z.enum(FEATURE_EDUCATION_CONTEXTUAL_TOUR_IDS)
const setupGuideSourceSchema = z.enum(SETUP_GUIDE_SOURCES)
const setupGuideCloseOutcomeSchema = z.enum(SETUP_GUIDE_CLOSE_OUTCOMES)
const setupGuideStepIdSchema = z.enum(FEATURE_WALL_SETUP_STEP_IDS)
const setupGuideStepIdOrNoneSchema = z.enum([...FEATURE_WALL_SETUP_STEP_IDS, 'none'] as const)
const terminalPaneSplitSourceSchema = z.enum(TERMINAL_PANE_SPLIT_SOURCES)

const contextualTourShownSchema = z
  .object({
    tour_id: featureEducationContextualTourIdSchema,
    source: featureEducationSourceSchema,
    was_feature_previously_interacted: z.boolean()
  })
  .strict()

const contextualTourOutcomeSchema = z
  .object({
    tour_id: featureEducationContextualTourIdSchema,
    source: featureEducationSourceSchema,
    outcome: z.enum(CONTEXTUAL_TOUR_OUTCOMES),
    steps_seen: z.number().int().min(0).max(8),
    total_steps: z.number().int().min(1).max(8),
    furthest_step_index: z.number().int().min(1).max(8).optional(),
    defined_step_count: z.number().int().min(1).max(8).optional()
  })
  .refine((payload) => payload.steps_seen <= payload.total_steps, {
    message: 'steps_seen must be less than or equal to total_steps',
    path: ['steps_seen']
  })
  .refine(
    (payload) =>
      payload.furthest_step_index === undefined ||
      payload.defined_step_count === undefined ||
      payload.furthest_step_index <= payload.defined_step_count,
    {
      message: 'furthest_step_index must be less than or equal to defined_step_count',
      path: ['furthest_step_index']
    }
  )
  .refine(
    (payload) =>
      (payload.furthest_step_index === undefined) === (payload.defined_step_count === undefined),
    {
      message: 'furthest_step_index and defined_step_count must be sent together',
      path: ['defined_step_count']
    }
  )
  .strict()

const setupGuideOpenedSchema = z
  .object({
    source: setupGuideSourceSchema,
    initial_completed_count: z.number().int().min(0).max(8),
    total_steps: z.literal(8),
    first_incomplete_step_id: setupGuideStepIdOrNoneSchema
  })
  .strict()

const setupGuideClosedSchema = z
  .object({
    source: setupGuideSourceSchema,
    outcome: setupGuideCloseOutcomeSchema,
    initial_completed_count: z.number().int().min(0).max(8),
    final_completed_count: z.number().int().min(0).max(8),
    total_steps: z.literal(8),
    active_step_id: setupGuideStepIdOrNoneSchema
  })
  .refine((payload) => payload.final_completed_count >= payload.initial_completed_count, {
    message: 'final_completed_count must be greater than or equal to initial_completed_count',
    path: ['final_completed_count']
  })
  .strict()

const setupGuideStepCompletedSchema = z
  .object({
    step_id: setupGuideStepIdSchema,
    section_id: z.enum(['parallel-work', 'setup']),
    completed_count: z.number().int().min(1).max(8),
    total_steps: z.literal(8),
    setup_guide_visible: z.boolean()
  })
  .strict()

const terminalPaneSplitSchema = z
  .object({
    source: terminalPaneSplitSourceSchema,
    direction: z.enum(['vertical', 'horizontal'])
  })
  .strict()

// Why: measures the changed-on-disk conflict flow (issue #7265) per transport; deliberately path-free.
const editorExternalChangeConflictShownSchema = z
  .object({
    surface: z.enum(['edit', 'unstaged-diff']),
    transport: z.enum(['local', 'ssh', 'runtime']),
    origin: z.enum(['live', 'restore'])
  })
  .strict()

const editorExternalChangeConflictActionSchema = z
  .object({
    action: z.enum(['reload', 'keep', 'compare', 'undo_reload', 'save_overwrite']),
    surface: z.enum(['edit', 'unstaged-diff']),
    transport: z.enum(['local', 'ssh', 'runtime'])
  })
  .strict()

// ── Event registry: the one record the validator consumes ───────────────
// Versioning: breaking changes (rename/re-mean/remove a key) need a new event name; in-place edits blend pre/post rows unmixably. Additive-optional fields are safe.
export const eventSchemas = {
  app_opened: appOpenedSchema,
  app_starred_orca: appStarredOrcaSchema,
  star_nag_outcome: starNagOutcomeEventSchema,
  feature_interaction_usage_bucket_reached: featureInteractionUsageBucketReachedSchema,

  repo_added: repoAddedSchema,
  add_repo_setup_step_action: addRepoSetupStepActionEventSchema,
  add_repo_existing_workspaces_detected: addRepoExistingWorkspacesDetectedSchema,
  add_repo_default_checkout_handoff: addRepoDefaultCheckoutHandoffSchema,
  add_repo_nested_scan_result: addRepoNestedScanResultSchema,
  add_repo_nested_import_action: addRepoNestedImportActionSchema,
  add_repo_nested_import_result: addRepoNestedImportResultSchema,
  workspace_created: workspaceCreatedSchema,
  workspace_create_failed: workspaceCreateFailedSchema,
  setup_script_prompt_shown: setupScriptPromptShownSchema,
  setup_script_prompt_action: setupScriptPromptActionSchema,

  agent_started: agentStartedSchema,
  agent_prompt_sent: agentPromptSentSchema,
  agent_error: agentErrorSchema,
  agent_hook_install_failed: agentHookInstallFailedSchema,
  agent_hook_unattributed: agentHookUnattributedSchema,

  daemon_start_failed: daemonStartFailedSchema,

  settings_changed: settingsChangedSchema,

  native_chat_toggled: nativeChatToggledSchema,
  native_chat_message_sent: nativeChatMessageSentSchema,
  native_chat_picker_opened: nativeChatPickerOpenedSchema,
  native_chat_picker_item_accepted: nativeChatPickerItemAcceptedSchema,
  native_chat_send_classified: nativeChatSendClassifiedSchema,
  native_chat_skill_discovery: nativeChatSkillDiscoverySchema,

  telemetry_opted_in: telemetryOptedInSchema,
  telemetry_opted_out: telemetryOptedOutSchema,

  orca_cli_feature_tip_shown: orcaCliFeatureTipShownSchema,
  orca_cli_feature_tip_setup_clicked: orcaCliFeatureTipSetupClickedSchema,
  orca_cli_feature_tip_setup_result: orcaCliFeatureTipSetupResultSchema,
  cmd_j_palette_feature_tip_shown: cmdJPaletteFeatureTipShownSchema,
  cmd_j_palette_feature_tip_acknowledged: cmdJPaletteFeatureTipAcknowledgedSchema,

  feature_wall_opened: featureWallOpenedSchema,
  feature_wall_closed: featureWallClosedSchema,
  feature_wall_tile_focused: featureWallTileFocusedSchema,
  feature_wall_tile_clicked: featureWallTileClickedSchema,
  feature_wall_group_selected: featureWallGroupSelectedSchema,
  feature_wall_feature_selected: featureWallFeatureSelectedSchema,
  feature_wall_docs_clicked: featureWallDocsClickedSchema,

  onboarding_started: onboardingStartedSchema,
  onboarding_step_viewed: onboardingStepViewedSchema,
  onboarding_step_completed: onboardingStepCompletedSchema,
  onboarding_step_skipped: onboardingStepSkippedSchema,
  onboarding_tour_outcome: onboardingTourOutcomeEventSchema,
  onboarding_step4_path_clicked: onboardingStep4PathClickedSchema,
  onboarding_step4_path_failed: onboardingStep4PathFailedSchema,
  onboarding_task_sources_snapshot: onboardingTaskSourcesSnapshotSchema,
  onboarding_windows_terminal_snapshot: onboardingWindowsTerminalSnapshotSchema,
  onboarding_completed: onboardingCompletedSchema,
  onboarding_dismissed: onboardingDismissedSchema,
  onboarding_agent_picked: onboardingAgentPickedSchema,
  onboarding_ghostty_discovered: onboardingGhosttyDiscoveredSchema,
  onboarding_ghostty_import_clicked: onboardingGhosttyImportClickedSchema,
  onboarding_ghostty_import_failed: onboardingGhosttyImportFailedSchema,
  onboarding_feature_setup_toggled: onboardingFeatureSetupToggledSchema,
  onboarding_feature_setup_run: onboardingFeatureSetupRunSchema,
  onboarding_feature_setup_terminal_opened: onboardingFeatureSetupTerminalOpenedSchema,
  onboarding_feature_setup_terminal_interacted: onboardingFeatureSetupTerminalInteractedSchema,
  activation_checklist_item_completed: activationChecklistItemCompletedSchema,

  contextual_tour_shown: contextualTourShownSchema,
  contextual_tour_outcome: contextualTourOutcomeSchema,
  setup_guide_opened: setupGuideOpenedSchema,
  setup_guide_closed: setupGuideClosedSchema,
  setup_guide_step_completed: setupGuideStepCompletedSchema,
  terminal_pane_split: terminalPaneSplitSchema,

  editor_external_change_conflict_shown: editorExternalChangeConflictShownSchema,
  editor_external_change_conflict_action: editorExternalChangeConflictActionSchema,

  smart_sort_class_distribution: smartSortClassDistributionSchema,
  smart_sort_class_1_promotion: smartSortClass1PromotionSchema,
  smart_to_recent_switch: smartToRecentSwitchSchema
} as const

export type EventMap = { [N in keyof typeof eventSchemas]: z.infer<(typeof eventSchemas)[N]> }
export type EventName = keyof EventMap
export type EventProps<N extends EventName> = EventMap[N]

// Why: non-`ZodObject` schemas have no `.shape`; return null so `key in undefined` can't throw at module load.
function eventSchemaShape(schema: z.ZodTypeAny): z.ZodRawShape | null {
  if (schema instanceof z.ZodObject) {
    return schema.shape
  }

  const shapeBearingSchema = schema as { shape?: unknown }
  // Why: refined object schemas may expose `.shape` even when refinement breaks `instanceof ZodObject`.
  if (shapeBearingSchema.shape && typeof shapeBearingSchema.shape === 'object') {
    return shapeBearingSchema.shape as z.ZodRawShape
  }
  return null
}

function eventsWithShapeKey(key: string): ReadonlySet<EventName> {
  return new Set(
    (Object.entries(eventSchemas) as [EventName, z.ZodTypeAny][])
      .filter(([, schema]) => {
        const shape = eventSchemaShape(schema)
        return shape !== null && key in shape
      })
      .map(([name]) => name)
  )
}

// Cohort injection is gated on this derived set because `.strict()` schemas drop events that don't declare `nth_repo_added`.
const COHORT_EXTENDED_SET = eventsWithShapeKey('nth_repo_added')
export const COHORT_EXTENDED: readonly EventName[] = Array.from(COHORT_EXTENDED_SET)

// Compile-time roster guarding the runtime injection set against silent schema drift.
type _CohortExtendedRoster =
  | 'app_opened'
  | 'app_starred_orca'
  | 'star_nag_outcome'
  | 'feature_interaction_usage_bucket_reached'
  | 'repo_added'
  | 'add_repo_setup_step_action'
  | 'add_repo_existing_workspaces_detected'
  | 'add_repo_default_checkout_handoff'
  | 'add_repo_nested_scan_result'
  | 'add_repo_nested_import_action'
  | 'add_repo_nested_import_result'
  | 'workspace_created'
  | 'workspace_create_failed'
  | 'setup_script_prompt_shown'
  | 'setup_script_prompt_action'
  | 'agent_started'
  | 'agent_prompt_sent'
  | 'agent_error'
  | 'orca_cli_feature_tip_shown'
  | 'orca_cli_feature_tip_setup_clicked'
  | 'orca_cli_feature_tip_setup_result'
  | 'cmd_j_palette_feature_tip_shown'
  | 'cmd_j_palette_feature_tip_acknowledged'
// Why: strict empty payloads infer a string index signature; ignore index-only keys so they aren't pulled into keyed rosters.
type _KnownPayloadKeys<T> = string extends keyof T ? never : keyof T
type _DerivedCohortExtendedEvents = {
  [N in EventName]: 'nth_repo_added' extends _KnownPayloadKeys<EventMap[N]> ? N : never
}[EventName]
type _CohortExtendedRosterSync = _CohortExtendedRoster extends _DerivedCohortExtendedEvents
  ? _DerivedCohortExtendedEvents extends _CohortExtendedRoster
    ? true
    : never
  : never
const _cohortExtendedRosterSyncCheck: _CohortExtendedRosterSync = true
void _cohortExtendedRosterSyncCheck

export function isCohortExtendedEvent(name: EventName): boolean {
  return COHORT_EXTENDED_SET.has(name)
}

// Events whose schema declares `cohort`: the IPC handler injects cohort only for these — a `.strict()` schema without it would reject the event.
const ONBOARDING_COHORT_SET = eventsWithShapeKey('cohort')
// `NonNullable` strips `undefined` introduced by `cohortSchema`'s `.optional()`.
export type OnboardingCohort = NonNullable<z.infer<typeof cohortSchema>>

// Compile-time roster: dropping `cohort` from any of these fails tsc, rather than silently at runtime (`.optional()` would tolerate that).
type _OnboardingCohortRoster =
  | 'onboarding_started'
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'onboarding_step_skipped'
  | 'onboarding_tour_outcome'
  | 'onboarding_step4_path_clicked'
  | 'onboarding_step4_path_failed'
  | 'onboarding_task_sources_snapshot'
  | 'onboarding_windows_terminal_snapshot'
  | 'onboarding_completed'
  | 'onboarding_dismissed'
  | 'onboarding_agent_picked'
  | 'onboarding_ghostty_discovered'
  | 'onboarding_ghostty_import_clicked'
  | 'onboarding_ghostty_import_failed'
  | 'onboarding_feature_setup_toggled'
  | 'onboarding_feature_setup_run'
  | 'onboarding_feature_setup_terminal_opened'
  | 'onboarding_feature_setup_terminal_interacted'
type _DerivedOnboardingCohortEvents = {
  [N in EventName]: 'cohort' extends _KnownPayloadKeys<EventMap[N]> ? N : never
}[EventName]
type _OnboardingCohortRosterSync = _OnboardingCohortRoster extends _DerivedOnboardingCohortEvents
  ? _DerivedOnboardingCohortEvents extends _OnboardingCohortRoster
    ? true
    : never
  : never
const _onboardingCohortRosterSyncCheck: _OnboardingCohortRosterSync = true
void _onboardingCohortRosterSyncCheck

export function isOnboardingEvent(name: EventName): boolean {
  return ONBOARDING_COHORT_SET.has(name)
}

// No `env` discriminator: every transmitted event is from an official CI build (dev/contributor builds only console-mirror).
// The per-field `.max(64)` is the validator's string-length cap — there is no separate post-parse length check.
export const commonPropsSchema = z
  .object({
    app_version: z.string().max(64),
    platform: z.string().max(64),
    arch: z.string().max(64),
    os_release: z.string().max(64),
    // `.min(1)`: an empty install_id/session_id would collapse unrelated events into one synthetic user/session, corrupting analytics.
    install_id: z.string().min(1).max(64),
    session_id: z.string().min(1).max(64),
    orca_channel: z.enum(['stable', 'rc'])
  })
  .strict()
export type CommonProps = z.infer<typeof commonPropsSchema>
