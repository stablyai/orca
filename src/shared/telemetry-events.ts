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
//
// See `docs/telemetry-implementation.md` §"The typed event map" for the full
// rationale and invariants this file is expected to preserve.

import { z } from 'zod'

// ── Shared property enums ───────────────────────────────────────────────

// Mirrors the detectable agents in `src/shared/agent-detection.ts`
// (`AGENT_NAMES`), with two deliberate shifts:
//   1. `claude` in AGENT_NAMES ↔ `claude-code` here (product, not CLI string)
//      so dashboards read cleanly.
//   2. `amp` is present here even though it is intentionally absent from
//      AGENT_NAMES title detection — the telemetry enum stays ready for the
//      near-term roadmap without broadening title detection.
// Adding a new agent may require updating both places, but not always.
export const agentKindSchema = z.enum([
  'claude-code',
  'codex',
  'gemini',
  'copilot',
  'cursor',
  'opencode',
  'aider',
  'amp',
  'other'
])
export type AgentKind = z.infer<typeof agentKindSchema>

export const errorClassSchema = z.enum([
  'network_timeout',
  'auth_expired',
  'rate_limited',
  'provider_unavailable',
  'provider_error_generic',
  'binary_not_found',
  'binary_version_mismatch',
  'workspace_gone',
  'user_cancelled',
  'unknown'
])
export type ErrorClass = z.infer<typeof errorClassSchema>

// Closed whitelist of error `name` strings allowed on `agent_error`. This is
// the one free-ish string that can leave the machine on an agent_error event
// — the validator drops anything not in this set.
//
// A regex-shape check (e.g. `/^[A-Z][A-Za-z]{0,32}$/`) would permit
// identifier-shaped leaks like `PaymentFailedForUserAlice` or
// `TimeoutInRepoMyCompanyInternalMonorepo` — context-concatenation bugs
// under deadline pressure. A closed whitelist forces each new error name
// through review. Same pattern as `SETTINGS_CHANGED_WHITELIST`.
export const AGENT_ERROR_NAME_WHITELIST = [
  'NetworkTimeout',
  'AuthExpired',
  'RateLimited',
  'ProviderUnavailable',
  'ProviderErrorGeneric',
  'BinaryNotFound',
  'BinaryVersionMismatch',
  'WorkspaceGone',
  'UserCancelled'
] as const
export const agentErrorNameSchema = z.enum(AGENT_ERROR_NAME_WHITELIST)
export type AgentErrorName = z.infer<typeof agentErrorNameSchema>

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
export const optInViaSchema = z.enum(['first_launch_banner', 'first_launch_notice', 'settings'])
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

// Enum-only by design for `error_class` + `agent_kind`. `error_name` is the
// one free-ish string that can leave the machine on this event, and it is
// drawn from the closed `AGENT_ERROR_NAME_WHITELIST` — adding a new value
// requires a PR to the whitelist, giving review a chance to catch
// context-concatenation patterns.
//
// `error_message` and `error_stack` are deliberately absent from this schema.
// `.strict()` rejects either key if a call site ever tries to attach one,
// which fails the validator and drops the event — the same posture T3 Code
// ships in production. See `docs/telemetry-implementation.md` §"Decision
// record: T3 Code's posture on errors" for the reversal conditions.
const agentErrorSchema = z
  .object({
    error_class: errorClassSchema,
    agent_kind: agentKindSchema,
    error_name: agentErrorNameSchema.optional()
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
// construction from an official CI build (see §Dev/CI handling), so a wire
// discriminator would be redundant. Contributor / `pnpm dev` builds do not
// transmit at all; they console-mirror.
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
    install_id: z.string().max(64),
    session_id: z.string().max(64),
    orca_channel: z.enum(['stable', 'rc'])
  })
  .strict()
export type CommonProps = z.infer<typeof commonPropsSchema>
