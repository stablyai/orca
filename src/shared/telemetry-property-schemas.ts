import { z } from 'zod'
import { FEATURE_WALL_EXIT_ACTIONS, FEATURE_WALL_TOUR_DEPTH_STEPS } from './feature-wall-tour-depth'
import { SETUP_SCRIPT_IMPORT_PROVIDERS } from './setup-script-import-providers'
import { WORKSPACE_SOURCE_VALUES, type WorkspaceSource } from './workspace-source'
import type { GlobalSettings } from './global-settings-types'

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
  'prime-agent',
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
  'trae',
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

export const featureWallOpenSourceSchema = z.enum(['help_menu', 'popup', 'onboarding', 'unknown'])
export type FeatureWallOpenSourceTelemetry = z.infer<typeof featureWallOpenSourceSchema>

export const featureWallWorkflowIdSchema = z.enum([
  'tasks',
  'workspaces',
  'agents-orchestration',
  'workbench',
  'review'
])

export const featureWallTourDepthStepSchema = z.enum(FEATURE_WALL_TOUR_DEPTH_STEPS)

export const featureWallExitActionSchema = z.enum(FEATURE_WALL_EXIT_ACTIONS)

// `env_var` absent — env-var/CI paths override consent at runtime only, never firing an opt-in/out event.
// `first_launch_notice` absent — the new-user cohort has no first-launch surface; those opt-outs come via `'settings'`.
export const optInViaSchema = z.enum(['first_launch_banner', 'settings'])
export type OptInVia = z.infer<typeof optInViaSchema>

// Whitelist of settings emittable on `settings_changed`. `orca_channel` (build-time, not user-togglable) is absent.
// The telemetry opt-in toggle is also absent — it fires dedicated `telemetry_opted_in/out` events; listing it would double-fire.
export type BooleanGlobalSettingsKey = {
  // Why: new toggles may be optional for legacy-settings compat but are still boolean once defaulted.
  [Key in keyof GlobalSettings]-?: NonNullable<GlobalSettings[Key]> extends boolean ? Key : never
}[keyof GlobalSettings]
export const SETTINGS_CHANGED_WHITELIST = [
  'editorAutoSave',
  'openLinksInApp',
  'openLinksInAppModifierInverts',
  'terminalLinkActionPopoverEnabled',
  'experimentalMobile',
  'experimentalPet',
  'experimentalNativeChat',
  'experimentalStructuredNativeChat',
  'experimentalActivity',
  'experimentalAgentDashboardPopout',
  'experimentalTerminalAttention',
  'experimentalAgentHibernation',
  'experimentalEphemeralVms',
  'geminiCliOAuthEnabled',
  'openAgentTabsInChatByDefault'
] as const satisfies readonly BooleanGlobalSettingsKey[]
export const settingsChangedKeySchema = z.enum(SETTINGS_CHANGED_WHITELIST)
export type SettingsChangedKey = z.infer<typeof settingsChangedKeySchema>
