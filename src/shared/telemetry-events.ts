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

// ── Shared property enums ───────────────────────────────────────────────

// Mirrors the detectable agents in `src/shared/agent-detection.ts`
// (`AGENT_NAMES`), with one deliberate shift: `claude` in AGENT_NAMES ↔
// `claude-code` here (product, not CLI string) so dashboards read cleanly.
//
// Enum values are limited to agents that have a real emit path today. Adding
// a new agent is additive-safe — extend this enum when the call site that
// would emit it lands, not in anticipation.
export const agentKindSchema = z.enum([
  'claude-code',
  'codex',
  'gemini',
  'copilot',
  'cursor',
  'opencode',
  'aider',
  'other'
])
export type AgentKind = z.infer<typeof agentKindSchema>

// Trimmed to the two values Orca's PTY-typed-command launch architecture can
// actually emit:
//   - `binary_not_found` — `provider.spawn` ENOENT (the *shell* binary is
//     missing). The agent CLI being missing is invisible: Orca spawns a
//     healthy shell and types the command, and bash/zsh's "command not found"
//     surfaces only as terminal output.
//   - `unknown` — every other thrown error (paste-readiness timeout, env-build
//     failures, unclassifiable shell-spawn errors).
// Provider-side errors (`auth_expired`, `rate_limited`, `network_timeout`,
// `provider_*`) happen inside the agent CLI subprocess and are not observable
// to Orca — see telemetry-plan.md §Decision: Defer per-incident error fields.
// Adding a new value is additive-safe; do it when the call site lands, not in
// anticipation.
export const errorClassSchema = z.enum(['binary_not_found', 'unknown'])
export type ErrorClass = z.infer<typeof errorClassSchema>

export const repoMethodSchema = z.enum(['folder_picker', 'clone_url', 'drag_drop'])
export type RepoMethod = z.infer<typeof repoMethodSchema>

export const workspaceSourceSchema = z.enum([
  'command_palette',
  'sidebar',
  'shortcut',
  'drag_drop',
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
  'unknown'
])
export type LaunchSource = z.infer<typeof launchSourceSchema>

export const requestKindSchema = z.enum(['new', 'resume', 'followup'])
export type RequestKind = z.infer<typeof requestKindSchema>

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
export const SETTINGS_CHANGED_WHITELIST = [
  'editorAutoSave',
  'openLinksInApp',
  'experimentalTerminalDaemon',
  'experimentalAgentDashboard'
] as const
export const settingsChangedKeySchema = z.enum(SETTINGS_CHANGED_WHITELIST)
export type SettingsChangedKey = z.infer<typeof settingsChangedKeySchema>

// ── Per-event schemas ───────────────────────────────────────────────────
//
// `.strict()` on every object is what enforces "no extra keys" at runtime —
// the validator does not need a separate extra-key check because zod rejects
// unknown keys at parse time. This is the runtime counterpart to the
// compile-time "unions of string literals, no raw `string`" rule.

const emptySchema = z.object({}).strict()

const repoAddedSchema = z.object({ method: repoMethodSchema }).strict()

const workspaceCreatedSchema = z
  .object({
    source: workspaceSourceSchema,
    from_existing_branch: z.boolean()
  })
  .strict()

const agentStartedSchema = z
  .object({
    agent_kind: agentKindSchema,
    launch_source: launchSourceSchema,
    request_kind: requestKindSchema
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
    agent_kind: agentKindSchema
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
  app_opened: emptySchema,

  repo_added: repoAddedSchema,
  workspace_created: workspaceCreatedSchema,

  agent_started: agentStartedSchema,
  agent_error: agentErrorSchema,

  settings_changed: settingsChangedSchema,

  telemetry_opted_in: telemetryOptedInSchema,
  telemetry_opted_out: telemetryOptedOutSchema
} as const

export type EventMap = { [N in keyof typeof eventSchemas]: z.infer<(typeof eventSchemas)[N]> }
export type EventName = keyof EventMap
export type EventProps<N extends EventName> = EventMap[N]

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
