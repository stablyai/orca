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

import { AGENT_HOOK_TARGETS } from './agent-hook-types'
import { ONBOARDING_FINAL_STEP } from './constants'
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
  'codex',
  'autohand',
  'opencode',
  'pi',
  'gemini',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'cline',
  'codebuff',
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

// Five Setup-step affordances the user can pick after `repo_added` fires (see
// AddRepoSetupStep). One enum because every value lives on the same screen and
// the funnel question is "which one did they pick" — adding a sixth value
// later is additive-safe per the schema-evolution doctrine below.
export const addRepoSetupStepActionSchema = z.enum([
  'create_worktree',
  'configure',
  'skip',
  'open_existing',
  'back'
])
export type AddRepoSetupStepAction = z.infer<typeof addRepoSetupStepActionSchema>

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

export const workspaceSourceSchema = z.enum([
  'command_palette',
  'sidebar',
  'shortcut',
  'drag_drop',
  'onboarding',
  'unknown'
])
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>

export const launchSourceSchema = z.enum([
  'command_palette',
  'sidebar',
  'tab_bar_quick_launch',
  'task_page',
  'new_workspace_composer',
  'workspace_jump_palette',
  'shortcut',
  'onboarding',
  'diff_notes_send',
  'notes_send',
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

export const featureWallOpenSourceSchema = z.enum(['help_menu', 'popup', 'unknown'])
export type FeatureWallOpenSourceTelemetry = z.infer<typeof featureWallOpenSourceSchema>

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
  [Key in keyof GlobalSettings]-?: GlobalSettings[Key] extends boolean ? Key : never
}[keyof GlobalSettings]
export const SETTINGS_CHANGED_WHITELIST = [
  'editorAutoSave',
  'openLinksInApp',
  'experimentalMobile',
  'experimentalPet',
  'experimentalWorktreeSymlinks',
  'geminiCliOAuthEnabled'
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

const repoAddedSchema = z
  .object({ method: repoMethodSchema, nth_repo_added: nthRepoAddedSchema })
  .strict()

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

const settingsChangedSchema = z
  .object({
    setting_key: settingsChangedKeySchema,
    value_kind: z.enum(['bool', 'enum'])
  })
  .strict()

const telemetryOptedInSchema = z.object({ via: optInViaSchema }).strict()
const telemetryOptedOutSchema = z.object({ via: optInViaSchema }).strict()

const featureWallOpenedSchema = z
  .object({
    source: featureWallOpenSourceSchema
  })
  .strict()
const featureWallClosedSchema = z
  .object({
    dwell_ms: z.number().int().min(0).max(FEATURE_WALL_MAX_DWELL_MS)
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

const addRepoSetupStepActionEventSchema = z
  .object({ action: addRepoSetupStepActionSchema, nth_repo_added: nthRepoAddedSchema })
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
// Why: bound is derived from ONBOARDING_FINAL_STEP so adding a wizard step
// only requires bumping the constant. Zod can't build a literal-union from a
// numeric constant without runtime gymnastics, so we use a clamped int range.
const onboardingStepSchema = z.number().int().min(1).max(ONBOARDING_FINAL_STEP)
const onboardingPathSchema = z.enum(['open_folder', 'clone_url'])
const onboardingFailureReasonSchema = z.enum([
  'invalid_path',
  'clone_failed',
  'cancelled',
  'unknown'
])
const onboardingValueKindSchema = z.enum(['agent', 'theme', 'notifications', 'repo'])
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
const onboardingFeatureSetupFeatureSchema = z.enum(['browser_use', 'computer_use', 'orchestration'])
const onboardingFeatureSetupSelectionSchema = {
  browser_use: z.boolean(),
  computer_use: z.boolean(),
  orchestration: z.boolean(),
  selected_count: z.number().int().min(0).max(3)
} as const
type OnboardingFeatureSetupSelectionTelemetry = {
  browser_use: boolean
  computer_use: boolean
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

// `'button' | 'keyboard'` records whether the user advanced via a footer
// button click or via Cmd/Ctrl+Enter. Skip and dismiss don't have a keyboard
// path today (the field will only ever be `'button'` for those events) but
// the uniform shape lets a future keyboard skip arrive without a schema
// migration.
const advancedViaSchema = z.enum(['button', 'keyboard']).optional()

const onboardingStartedSchema = z
  .object({ resumed_from_step: onboardingStepSchema.optional(), cohort: cohortSchema })
  .strict()
const onboardingStepViewedSchema = z
  .object({ step: onboardingStepSchema, cohort: cohortSchema })
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
    duration_ms: z.number().int().nonnegative().optional(),
    advanced_via: advancedViaSchema,
    cohort: cohortSchema
  })
  .strict()
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
const onboardingCompletedSchema = z
  .object({
    path: onboardingPathSchema,
    is_git_repo: z.boolean(),
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

  repo_added: repoAddedSchema,
  add_repo_setup_step_action: addRepoSetupStepActionEventSchema,
  workspace_created: workspaceCreatedSchema,
  workspace_create_failed: workspaceCreateFailedSchema,

  agent_started: agentStartedSchema,
  agent_error: agentErrorSchema,
  agent_hook_install_failed: agentHookInstallFailedSchema,
  agent_hook_unattributed: agentHookUnattributedSchema,

  settings_changed: settingsChangedSchema,

  telemetry_opted_in: telemetryOptedInSchema,
  telemetry_opted_out: telemetryOptedOutSchema,

  feature_wall_opened: featureWallOpenedSchema,
  feature_wall_closed: featureWallClosedSchema,
  feature_wall_tile_focused: featureWallTileFocusedSchema,
  feature_wall_tile_clicked: featureWallTileClickedSchema,

  onboarding_started: onboardingStartedSchema,
  onboarding_step_viewed: onboardingStepViewedSchema,
  onboarding_step_completed: onboardingStepCompletedSchema,
  onboarding_step_skipped: onboardingStepSkippedSchema,
  onboarding_step4_path_clicked: onboardingStep4PathClickedSchema,
  onboarding_step4_path_failed: onboardingStep4PathFailedSchema,
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
function eventsWithShapeKey(key: string): ReadonlySet<EventName> {
  return new Set(
    (Object.entries(eventSchemas) as [EventName, z.ZodTypeAny][])
      .filter(([, schema]) => schema instanceof z.ZodObject && key in schema.shape)
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
  | 'repo_added'
  | 'add_repo_setup_step_action'
  | 'workspace_created'
  | 'workspace_create_failed'
  | 'agent_started'
  | 'agent_error'
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
  | 'onboarding_step4_path_clicked'
  | 'onboarding_step4_path_failed'
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
