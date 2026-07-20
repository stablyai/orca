/* eslint-disable max-lines -- Why: this is the single source of truth for every telemetry event schema, enum, and the cohort-injection set predicates. Splitting it would scatter the .strict() / Zod-first doctrine across files and break the EventMap derivation that makes adding an event a one-line change. */
// Single source of truth for telemetry event names, schemas, and enums.
//
// Zod-first: every event schema is declared once and the compile-time
// `EventMap` is `z.infer`-derived from the same record the runtime validator
// consumes. There is no parallel `EVENT_SPEC` / hand-rolled union to drift
// out of sync with. Adding an event means adding a schema to `eventSchemas`;
// `EventMap` picks it up automatically and call sites that reference an
// unknown event name fail `tsc`.
//
// `.strict()` on every object schema is the runtime counterpart to "no extra
// keys." Free-form string fields carry an explicit `.max(N)` cap at the
// schema — the cap and the schema are the same thing; the validator does not
// re-check string length.

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

// Mirrors the shipped `TuiAgent` launch surface, with one deliberate shift:
// `claude` in settings/launch state ↔ `claude-code` here (product, not CLI
// string) so dashboards read cleanly.
//
// `other` remains as a telemetry escape hatch, but project-owned TuiAgents
// should map to concrete values; see `tuiAgentToAgentKind`.
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

// Trimmed to a small set of values Orca's PTY-typed-command launch architecture
// can emit:
//   - `binary_not_found` — `provider.spawn` ENOENT (the *shell* binary is
//     missing). The agent CLI being missing is invisible: Orca spawns a
//     healthy shell and types the command, and bash/zsh's "command not found"
//     surfaces only as terminal output.
//   - `paste_readiness_timeout` — bracketed-paste readiness wait timed out.
//     The agent process spawned but its TUI input box didn't reach a ready
//     state before the watchdog deadline, so the queued draft was dropped.
//   - `unknown` — every other thrown error (env-build failures,
//     unclassifiable shell-spawn errors).
// Provider-side errors (`auth_expired`, `rate_limited`, `network_timeout`,
// `provider_*`) happen inside the agent CLI subprocess and are not observable
// to Orca — see telemetry-plan.md §Decision: Defer per-incident error fields.
// Adding a new value is additive-safe; do it when the call site lands, not in
// anticipation.
export const errorClassSchema = z.enum(['binary_not_found', 'paste_readiness_timeout', 'unknown'])
export type ErrorClass = z.infer<typeof errorClassSchema>

export const repoMethodSchema = z.enum(['folder_picker', 'clone_url', 'drag_drop'])
export type RepoMethod = z.infer<typeof repoMethodSchema>

// Historical setup-step affordances users could pick after `repo_added` fired.
// Current Add Project flows skip that choice screen and auto-open the default
// checkout, but the schema stays for pre-rollout rows and compatibility.
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

// Deliberately a separate enum from `errorClassSchema` (PTY-spawn taxonomy):
// different domain — this one buckets git/filesystem failures thrown by
// `createLocalWorktree` / `createRemoteWorktree`. Merging the two would lock
// both domains to the union forever, which the schema-evolution comment
// below warns against.
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

// `env_var` is deliberately absent — env-var and CI paths override consent at
// runtime only (see consent.ts); they never mutate `optedIn` and therefore
// never fire a `telemetry_opted_in/out` event. If a future path explicitly
// persists an env-var-driven opt-out, add `env_var` back here together with
// the call site.
//
// `first_launch_notice` (new-user disclosure toast) is deliberately absent —
// the new-user cohort has no first-launch surface (see telemetry-plan.md
// §First-launch experience). Opt-outs from new users come through
// `via: 'settings'`.
export const optInViaSchema = z.enum(['first_launch_banner', 'settings'])
export type OptInVia = z.infer<typeof optInViaSchema>

// Whitelist of settings whose `setting_key` may be emitted on
// `settings_changed`. If a setting isn't in this list, we do not emit.
//
// Keys are camelCase to match the actual field names in `GlobalSettings`.
// `orca_channel` is intentionally absent — it is a build-time common
// property baked in from `ORCA_BUILD_IDENTITY`, not a user-togglable setting.
//
// Intentionally does NOT include the telemetry opt-in toggle — that is
// covered by the dedicated `telemetry_opted_in` / `telemetry_opted_out`
// events, which carry `via` context that a plain `settings_changed` could
// not. Listing it here would double-fire.
//
// Kept as an `as const` tuple so the Zod enum below and any call-site usage
// share one array — typo-drift is impossible.
type BooleanGlobalSettingsKey = {
  // Why: new persisted toggles may be optional for legacy-settings compatibility
  // while still being boolean settings once defaults are applied.
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
//
// `.strict()` on every object is what enforces "no extra keys" at runtime —
// the validator does not need a separate extra-key check because zod rejects
// unknown keys at parse time. This is the runtime counterpart to the
// compile-time "unions of string literals, no raw `string`" rule.

// Cohort signal — see docs/onboarding-funnel-cohort-addendum.md. One integer
// shared across the events listed in `COHORT_EXTENDED` below: the count of
// repos the user has at emit time, read from `store.getRepos().length`.
// `.int().nonnegative()` constrains malformed values to the floor;
// `.optional()` lets the classifier's fail-soft fallback (returning
// `undefined`) validate cleanly so a read error never crashes a track call.
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
  // Why: `is_git_repo` is the real git-vs-folder signal, sourced from git
  // detection at the add point. It moved here from `onboarding_completed`
  // once project selection left onboarding (1.4.46). `.optional()` so
  // SSH/remote or any path that genuinely can't determine git-ness validates
  // cleanly instead of crashing the track call — same fail-soft intent as
  // `nthRepoAddedSchema`. Never default-guess `false`; omit instead.
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

// Enum-only by design for both fields. `error_message` and `error_stack` are
// deliberately absent — `.strict()` rejects either key if a call site ever
// tries to attach one, which fails the validator and drops the event. Raw
// error strings carry arbitrary user/workspace/path content; keeping them off
// the wire is the only way to guarantee we never transmit them by accident.
const agentErrorSchema = z
  .object({
    error_class: errorClassSchema,
    agent_kind: agentKindSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

// Why: emitted when the terminal daemon cannot start and terminals fall back to
// the (non-persistent) local provider. Enum-only `error_class` — the raw daemon
// stderr tail stays in local logs and never reaches the wire (paths/usernames).
// A spike in this event is the fleet-wide signal for a daemon outage like
// v1.4.129-rc.1, which was otherwise invisible until users filed bug reports.
const daemonStartFailedSchema = z.object({ error_class: errorClassSchema }).strict()

const settingsChangedSchema = z
  .object({
    setting_key: settingsChangedKeySchema,
    value_kind: z.enum(['bool', 'enum'])
  })
  .strict()

// Native chat view (per-tab terminal⇄chat toggle) adoption signals.
// `agent_kind` reuses the shared closed enum so dashboards can slice adoption
// by agent. The view-mode enum mirrors `Tab.viewMode` in shared/types.ts.
const nativeChatViewModeSchema = z.enum(['terminal', 'chat'])
const nativeChatToggledSchema = z
  .object({
    from_mode: nativeChatViewModeSchema,
    to_mode: nativeChatViewModeSchema,
    agent_kind: agentKindSchema
  })
  .strict()
// `runtime` records whether the agent PTY runs locally or over an SSH/remote
// runtime; `'unknown'` when the owning runtime cannot be resolved at send time.
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

// Why: same enum-only discipline as `agent_error` — `.strict()` rejects raw
// error strings if a future call site tries to attach `error_message` /
// `error_stack`. The classifier in worktrees.ts reads `error.message` to
// bucket into the enum, but those strings never cross the wire.
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
  // Why: cohort injection probes top-level ZodObject shapes; superRefine
  // keeps that path while still rejecting impossible mode/provider pairs.
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
// Why: setup-candidate telemetry is for a retention cohort, not debugging a
// user's repo, so it carries only closed enums and count buckets.
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

// Managed-hook installer per-agent label. Distinct from `AGENT_KIND_VALUES`:
// hook installation only targets the agents in `AGENT_HOOK_TARGETS` and the
// labels here match the `*HookService.install()` call sites in
// `src/main/index.ts`. `claude` (not `claude-code`) is intentional — the
// failure is about Claude Code's `~/.claude/settings.json`, not the broader
// product taxonomy. Sourced from `AGENT_HOOK_TARGETS` so the wire enum and
// the IPC `AgentHookTarget` type cannot drift as new hook-install agents
// are added.
export const hookInstallAgentSchema = z.enum(AGENT_HOOK_TARGETS)
export type HookInstallAgent = z.infer<typeof hookInstallAgentSchema>

// Why: install failures are config-file-shape errors (malformed JSON, missing
// keys, ACL denials on `~/.claude` etc.) — not user content. The 200-char
// cap is the truncation contract; callers must truncate before calling
// `track`, and the validator will drop overlength strings via `.max(200)`.
const agentHookInstallFailedSchema = z
  .object({
    agent: hookInstallAgentSchema,
    error_message: z.string().max(200)
  })
  .strict()

// Why: regression signal for paneKey attribution. A hook event whose paneKey
// does not correspond to any tab in `tabsByWorktree` indicates the renderer
// could not route the event to a pane. Pre-fix this fired routinely for
// CLI-spawned terminals (empty paneKey); post-fix it should be near-zero in
// normal use. The lone `reason` field reflects what the producer can observe
// at emission time: an empty paneKey on the wire (pre-fix CLI shape) vs. any
// non-empty paneKey that fails to resolve to a known tab in `tabsByWorktree`
// (stale tab id, malformed value, or wrong-worktree id all bucket here).
// See docs/cli-terminal-hook-pane-key.md.
const agentHookUnattributedSchema = z
  .object({ reason: z.enum(['empty_pane_key', 'unknown_tab_id']) })
  .strict()

// ── Onboarding ──────────────────────────────────────────────────────────
//
// Closed enums only — no raw paths, repo names, clone URLs, or error
// strings. The funnel exists to measure activation, not to debug specific
// user repos.
// Why: active onboarding now has fewer steps, but these event names already
// carried seven-step payloads. Keep validation backward-compatible for old rows
// unless a future versioned event replaces the historical schema.
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
// `dismissed` from `OnboardingChecklistState` is intentionally excluded —
// it is a UI panel-visibility flag, not an activation event, so it never
// fires `activation_checklist_item_completed`. Keep this list in sync with
// the activation keys of `OnboardingChecklistState` in shared/types.ts.
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
  // Why: Linear ticket setup is a recommended add-on and must not affect
  // onboarding progress metrics.
  const selectedCount =
    (props.browser_use ? 1 : 0) + (props.computer_use ? 1 : 0) + (props.orchestration ? 1 : 0)
  return props.selected_count === selectedCount
}

// Why: compile-time guard that the enum above stays in lockstep with the
// activation keys of OnboardingChecklistState (everything except the UI-only
// `dismissed` flag). Adding/removing a checklist key without updating this
// schema breaks the build here rather than silently dropping telemetry.
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

// Cohort discriminator threaded onto every onboarding-wizard event by the
// IPC `telemetry:track` handler (mirrors `nth_repo_added`). `.optional()` is
// load-bearing: the classifier returns `undefined` when settings can't be
// read, and `.strict()` would otherwise reject the event entirely.
//
// Adding a new onboarding event: include `cohort: cohortSchema` on its
// schema. The injection set in `telemetry:track` is derived from
// `'cohort' in schema.shape`, so there is no parallel hand-maintained list.
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
  // Why: high-cardinality by design, but random and non-persistent. It lets
  // dashboards count scan -> action -> result attempts without path-derived IDs.
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

// `'button' | 'keyboard'` records whether the user advanced via a footer
// button click, Cmd/Ctrl+Enter, or an equivalent keyboard exit like Escape.
// The uniform shape lets keyboard skip/dismiss paths arrive without a
// schema migration.
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

// Why: see docs/agent-on-path-detection.md. Disambiguates `on_path: false`
// rows on dashboard 1562016 — distinguishes shell-hydration failure (where
// `on_path` is misleading because Orca's view of PATH is incomplete) from
// genuinely-not-on-PATH (where the field is reporting accurately). Closed
// enum kept in lockstep with `ShellHydrationFailureReason` via a compile-time
// guard below.
const pathSourceSchema = z.enum(['shell_hydrate', 'sync_seed_only'])
const pathFailureReasonSchema = z.enum(['none', 'no_shell', 'timeout', 'spawn_error', 'empty_path'])

// Compile-time guard: schema enum must match `ShellHydrationFailureReason`.
// Adding a new failure mode in `hydrate-shell-path.ts` without updating both
// the shared alias and this schema breaks the build here. Without the guard,
// a new enum value would ship `failureReason` strings the strict validator
// rejects, dropping the entire `onboarding_agent_picked` event at parse time
// and losing the `agent_kind`/`on_path` data on that pick.
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

// Fired at click time from `setSelectedAgentInteractive` so we capture
// mind-changes within the step rather than just the final pick. `agent_kind`
// uses `tuiAgentToAgentKind` so the wire enum stays closed even when stale
// persisted settings present a string outside `TuiAgent` (the fallback is
// `'other'`).
const onboardingAgentPickedSchema = z
  .object({
    agent_kind: agentKindSchema,
    on_path: z.boolean(),
    detected_count: z.number().int().nonnegative(),
    // `'pending'` when the merged isDetectingAgents/isRefreshingAgents flag
    // is truthy at click time — distinguishes "picked the only detected
    // agent" from "picked before detection finished."
    detection_state: z.enum(['complete', 'pending']),
    // `true` when the selected agent lived under the `<details>` disclosure
    // ("Show N more"). Signals whether users go looking for less-popular
    // agents — input for catalog ordering decisions.
    from_collapsed_section: z.boolean(),
    // Why: instrumentation for the `on_path:false` triage. `.optional()` is
    // load-bearing — events emitted before this deploy validate cleanly under
    // `.strict()`. See docs/agent-on-path-detection.md.
    path_source: pathSourceSchema.optional(),
    path_failure_reason: pathFailureReasonSchema.optional(),
    cohort: cohortSchema
  })
  .strict()

// Mirrors the renderer's DiscoveryState taxonomy in ThemeStep.tsx. `failed`
// is intentionally NOT a discovery state — it is the outcome of an Import
// attempt, reported by `onboarding_ghostty_import_failed`.
const ghosttyDiscoveryStateSchema = z.enum(['found', 'absent', 'imported'])

// Compile-time guard: every member of ghosttyDiscoveryStateSchema must be a
// discovery `status` the renderer can actually emit. Adding a new
// DiscoveryState member in ThemeStep.tsx without updating the schema (or
// vice versa) breaks the build here rather than silently dropping telemetry.
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
    // Bucketed, not raw, count: exact group counts are an environment
    // fingerprint (heavy customizers are uniquely identifiable). Buckets
    // cover the nine possible group labels in `humanFields()` without
    // re-emitting the count itself.
    field_group_count_bucket: z.enum(['0', '1-3', '4-7', '8+']),
    cohort: cohortSchema
  })
  .strict()
const onboardingGhosttyImportClickedSchema = z.object({ cohort: cohortSchema }).strict()

// Why: smart-sort telemetry. The class distribution event tells us whether
// real users have meaningful Class 1/2/3 populations (signal that the
// redesign is doing work) or whether everyone collapses to Class 4 (signal
// that hook coverage is too low). The Class 1 promotion event distinguishes
// hook-driven attention from the title-heuristic fallback so we can tell
// whether Edge case 9 is carrying weight. The smart→recent switch event is
// our regression signal: users abandoning Smart for Recent.
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
// Why a placeholder field instead of `z.object({})`: an empty zod object
// infers as TS `{}` (which in TS means "anything non-null/undefined"). That
// upsets the `keyof EventMap[N]` probes used by COHORT_EXTENDED_SET and
// ONBOARDING_COHORT_SET, breaking their compile-time roster sync checks.
// Carrying a single optional `_v` discriminator dodges the issue and
// preserves room to add future fields without renaming the event.
const smartToRecentSwitchSchema = z.object({ _v: z.literal(1).optional() }).strict()
const onboardingGhosttyImportFailedSchema = z
  .object({
    // `'no_config'` is reserved for a future explicit "preview returned
    // found:false" branch. Today's call sites emit `'empty_diff'` (the
    // import resolved to no changes) or `'unknown'` (caught throw).
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
  // Why: selected_count is derived analytics data; validate the relationship
  // at the untrusted IPC boundary instead of trusting renderer callers.
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

// Why: measures the changed-on-disk conflict flow (issue #7265) — how often
// conflicts surface per transport (false-banner detection on ssh/runtime
// echoes) and which resolution users pick. Deliberately path-free.
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
//
// The validator does `eventSchemas[name].safeParse(props)`. `EventMap` is
// `z.infer`-derived from this record, so there is exactly one source of
// truth for both compile-time types and runtime validation.
//
// Schema-evolution / versioning doctrine:
// Breaking changes (renaming a field, changing an enum's meaning, removing a
// required key) require a new event name (e.g. `agent_started_v2`), not an
// in-place edit. Additive-optional fields (`z.field().optional()`) are safe
// to add in place. This keeps PostHog funnels clean — an in-place breaking
// change silently blends pre- and post-change rows under one event name,
// which cannot be unmixed after the fact.
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

// Why: events whose schemas declare a given property name. Extracted so the
// cast (Object.entries → [EventName, ZodTypeAny]) stays in one place; if the
// schema-registry shape ever changes, only one site needs to update.
// Safely skips non-`ZodObject` schemas (e.g. a future `z.discriminatedUnion`
// or `z.union`) — those have no `.shape`, and probing `key in undefined`
// would throw at module load and take the telemetry module down on import.
function eventSchemaShape(schema: z.ZodTypeAny): z.ZodRawShape | null {
  if (schema instanceof z.ZodObject) {
    return schema.shape
  }

  const shapeBearingSchema = schema as { shape?: unknown }
  // Why: refined object schemas may still expose `.shape` even if a Zod
  // version stops preserving `instanceof ZodObject` through refinement.
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

// Events whose schemas declare `nth_repo_added`. Derived from `eventSchemas`
// at module load by probing each schema's `.shape` — there is no parallel
// hand-maintained list to drift out of sync. The IPC `telemetry:track`
// handler injects the cohort property only when the incoming event name is
// in this set: the schemas are `.strict()`, so injecting `nth_repo_added`
// on an event whose schema does not declare it would fail validation and
// silently drop the entire event.
//
// Schema-additions checklist for adding a new cohort-extended event:
//   add `nth_repo_added: nthRepoAddedSchema` to the event's schema above.
//   That is the *only* step — this set updates automatically.
const COHORT_EXTENDED_SET = eventsWithShapeKey('nth_repo_added')
export const COHORT_EXTENDED: readonly EventName[] = Array.from(COHORT_EXTENDED_SET)

// Compile-time roster of events that must declare `nth_repo_added`. Same
// rationale as `_OnboardingCohortRosterSync` below — guards the runtime
// injection set against silent schema drift.
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
// Why: `z.object({}).strict()` infers a string index signature, which would
// make every key appear present. Ignore index-signature-only keys here so
// strict empty event payloads do not get pulled into keyed telemetry rosters.
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

// Onboarding events — derived the same way as `COHORT_EXTENDED_SET`: probe
// each schema's `.shape` for the `cohort` key. The IPC `telemetry:track`
// handler injects the onboarding cohort property only when the incoming
// event name is in this set; schemas are `.strict()`, so injecting `cohort`
// on an event whose schema does not declare it would fail validation and
// silently drop the entire event.
//
// Adding a new onboarding event: include `cohort: cohortSchema` on its
// schema. This set updates automatically.
const ONBOARDING_COHORT_SET = eventsWithShapeKey('cohort')
// `NonNullable` strips `undefined` introduced by `cohortSchema`'s `.optional()`.
export type OnboardingCohort = NonNullable<z.infer<typeof cohortSchema>>

// Compile-time roster of events that must declare `cohort`. If a schema
// refactor drops the field from one of these, this fails tsc rather than
// silently dropping the event from the runtime injection set above (which
// the `.optional()` schema would tolerate without any test failure).
//
// Adding a new onboarding event: add its name here AND declare
// `cohort: cohortSchema` on its schema. Both are required.
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

// Common props attached by the client — declared here so the validator knows
// which keys to allow on every outgoing event.
//
// No `env: 'prod' | 'dev'` property. Every transmitted event is by
// construction from an official CI build, so a wire discriminator would be
// redundant. Contributor / `pnpm dev` builds do not transmit at all; they
// console-mirror.
//
// Every string field carries the 64-char cap directly — this is what the
// validator's "string-length cap" rule is made of; there is no separate
// post-parse length check to keep in sync with the schema.
export const commonPropsSchema = z
  .object({
    app_version: z.string().max(64),
    platform: z.string().max(64),
    arch: z.string().max(64),
    os_release: z.string().max(64),
    // `install_id` is used as PostHog's `distinctId` and `session_id` is the
    // per-process correlation key — an empty string on either would collapse
    // unrelated events into a single synthetic "user" / "session" and
    // silently corrupt analytics. `.min(1)` rejects that actual observed
    // failure mode without pinning the shape to UUIDs (both ids come from
    // `randomUUID()` today, but forward-compatibility with a future id
    // scheme is cheap to preserve).
    install_id: z.string().min(1).max(64),
    session_id: z.string().min(1).max(64),
    orca_channel: z.enum(['stable', 'rc'])
  })
  .strict()
export type CommonProps = z.infer<typeof commonPropsSchema>
