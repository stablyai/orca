import { z } from 'zod'
import { AGENT_HOOK_TARGETS } from './agent-hook-types'
import {
  DAEMON_LIFECYCLE_SESSION_BUCKETS,
  DAEMON_LIFECYCLE_TRANSITIONS,
  DAEMON_REPLACE_REASONS,
  DAEMON_RETIRE_REASONS
} from './daemon-lifecycle-telemetry'
import {
  DAEMON_AUDIT_GENERATION_ROLE_VALUES,
  DAEMON_AUDIT_PROCESS_REASON_VALUES,
  DAEMON_AUDIT_REASON_VALUES,
  DAEMON_AUDIT_STATE_VALUES,
  DAEMON_AUDIT_TRIGGER_VALUES,
  DAEMON_EVIDENCE_SOURCE_VALUES
} from './daemon-audit-eligibility'
import {
  DAEMON_ADOPTED_APP_VERSION_MATCH,
  DAEMON_PTY_CWD_CLASSES,
  DAEMON_SPAWNER_PATH_CLASSES,
  DAEMON_TCC_ATTRIBUTION_VALUES
} from './daemon-adoption-telemetry'
import { errorClassSchema, settingsChangedKeySchema } from './telemetry-property-schemas'

// Why: daemon start-failure signal (fleet-wide outage like v1.4.129-rc.1); enum-only so raw stderr never reaches the wire.
export const daemonStartFailedSchema = z.object({ error_class: errorClassSchema }).strict()

export const runtimeRpcStartErrorClassSchema = z.enum([
  'permission_denied',
  'address_in_use',
  'storage_unavailable',
  'invalid_path',
  'unknown'
])
export type RuntimeRpcStartErrorClass = z.infer<typeof runtimeRpcStartErrorClassSchema>

// Why: runtime discovery failures can contain user paths; keep telemetry to closed filesystem/socket categories.
export const runtimeRpcStartFailedSchema = z
  .object({ error_class: runtimeRpcStartErrorClassSchema })
  .strict()

// Why: classify session-killing 1013 closures as producer size failures or queue backpressure.
export const remoteOutboundBudgetCloseSchema = z
  .object({ emitter: z.enum(['size', 'queue']) })
  .strict()

// Why: a deadlocked main thread never crashes, so it produces no crash report and no user report
// beyond "it froze" — incidence has been unmeasurable. `self_recovered` splits stalls that cleared
// from ones that never did, which is the number that decides whether auto-recovery is ever safe to
// build: every self-recovered stall is a kill that design would have gotten wrong. `unresponsive_ms`
// is the observed silence, kept raw so the 45s threshold can be calibrated against real tails.
export const mainThreadHangDetectedSchema = z
  .object({
    unresponsive_ms: z.number().int().nonnegative(),
    self_recovered: z.boolean()
  })
  .strict()

// Why: #17696 — a macOS app adopting a daemon from an earlier bundle is invisible to
// `daemon_lifecycle` (nothing is replaced). Once per macOS launch that adopts; enum-only.
export const daemonAdoptedSchema = z
  .object({
    app_version_match: z.enum(DAEMON_ADOPTED_APP_VERSION_MATCH),
    spawner_path_class: z.enum(DAEMON_SPAWNER_PATH_CLASSES),
    tcc_attribution: z.enum(DAEMON_TCC_ATTRIBUTION_VALUES),
    live_session_count_bucket: z.enum(DAEMON_LIFECYCLE_SESSION_BUCKETS)
  })
  .strict()

// Why: the #17696 symptom itself — the daemon spawned a terminal into a cwd it cannot read while
// the app can. Emitted only on that proven divergence, so a missing or app-unreadable cwd never counts.
export const daemonPtyCwdDeniedSchema = z
  .object({
    cwd_class: z.enum(DAEMON_PTY_CWD_CLASSES),
    app_version_match: z.enum(DAEMON_ADOPTED_APP_VERSION_MATCH),
    spawner_path_class: z.enum(DAEMON_SPAWNER_PATH_CLASSES)
  })
  .strict()

// Why: daemon replace/retire lifecycle signal — issue #7936 was undiagnosable without asking a user for daemon.log.
// Enum-only + bucketed session count so no paths, raw versions, or exact counts reach the wire.
// The union keeps each reason pinned to its transition, so a death can't be reported as a replace.
export const daemonLifecycleSchema = z.discriminatedUnion('transition', [
  z
    .object({
      transition: z.literal(DAEMON_LIFECYCLE_TRANSITIONS[0]),
      reason: z.enum(DAEMON_REPLACE_REASONS),
      live_session_count_bucket: z.enum(DAEMON_LIFECYCLE_SESSION_BUCKETS)
    })
    .strict(),
  z
    .object({
      transition: z.literal(DAEMON_LIFECYCLE_TRANSITIONS[1]),
      reason: z.enum(DAEMON_RETIRE_REASONS),
      live_session_count_bucket: z.enum(DAEMON_LIFECYCLE_SESSION_BUCKETS)
    })
    .strict()
])

export const daemonAuditEligibilityBaseSchema = z.object({
  state: z.enum(DAEMON_AUDIT_STATE_VALUES),
  reason: z.enum(DAEMON_AUDIT_REASON_VALUES),
  trigger: z.enum(DAEMON_AUDIT_TRIGGER_VALUES),
  evidence_sources: z.array(z.enum(DAEMON_EVIDENCE_SOURCE_VALUES)).min(1).max(12),
  protocol_generation: z.number().int().positive().max(1_000),
  generation_role: z.enum(DAEMON_AUDIT_GENERATION_ROLE_VALUES),
  provider: z.literal('local-daemon'),
  endpoint_kind: z.enum(['unix-socket', 'windows-named-pipe']),
  profile_scope: z.enum(['configured', 'unspecified']),
  reachability: z.enum(['authenticated', 'disconnected', 'unknown']),
  inventory_authority: z.enum(['authoritative', 'unavailable']),
  process_liveness: z.enum(['present', 'gone', 'unknown']),
  process_reason: z.enum(DAEMON_AUDIT_PROCESS_REASON_VALUES).nullable(),
  endpoint_state: z.enum(['missing', 'named-pipe', 'non-socket', 'socket', 'unknown'])
})

export const daemonAuditEligibilitySchema = z.discriminatedUnion('exact_incarnation', [
  daemonAuditEligibilityBaseSchema
    .extend({
      exact_incarnation: z.literal('endpoint-identity'),
      exact_incarnation_correlation: z.string().regex(/^v1:[0-9a-f]{32}$/)
    })
    .strict(),
  daemonAuditEligibilityBaseSchema
    .extend({
      exact_incarnation: z.literal('endpoint-identity-linux-ticks'),
      exact_incarnation_correlation: z.string().regex(/^v1:[0-9a-f]{32}$/)
    })
    .strict(),
  daemonAuditEligibilityBaseSchema.extend({ exact_incarnation: z.literal('unavailable') }).strict()
])

// Rollout signal for granting Codex hook trust via codex app-server RPCs
// instead of Orca's self-computed trusted_hash. `fallback`/`verify_failed`
// spikes mean the RPC lane is not taking; steady-state ledger skips are not
// reported (they would only measure launch volume). `lane` attributes the
// grant surface (real ~/.codex vs managed home); `error_class`/`verify_class`
// are closed classifications so `error` fallbacks are diagnosable in the
// field — e.g. `binary-missing` = codex CLI absent, no rollout impact.
export const codexTrustGrantSchema = z
  .object({
    outcome: z.enum(['granted', 'fallback', 'verify_failed']),
    host_kind: z.enum(['native', 'wsl']),
    lane: z.enum(['real-home', 'managed']),
    fallback_reason: z
      .enum([
        'disabled',
        'no-managed-entries',
        'unsupported',
        'unsupported-cached',
        'verify-failed',
        'retry-cached',
        'error'
      ])
      .optional(),
    error_class: z
      .enum(['binary-missing', 'timeout', 'entry-failed', 'early-exit', 'rpc-failed', 'unexpected'])
      .optional(),
    verify_class: z
      .enum([
        'list-mismatch',
        'post-grant-untrusted',
        'post-grant-mismatch',
        'unexpected-key',
        'duplicate-key',
        'coverage'
      ])
      .optional()
  })
  .strict()

export const settingsChangedSchema = z
  .object({
    setting_key: settingsChangedKeySchema,
    value_kind: z.enum(['bool', 'enum'])
  })
  .strict()

// Managed-hook installer label from `AGENT_HOOK_TARGETS`, distinct from `AGENT_KIND_VALUES`; `claude` (not `claude-code`) is intentional.
export const hookInstallAgentSchema = z.enum(AGENT_HOOK_TARGETS)
export type HookInstallAgent = z.infer<typeof hookInstallAgentSchema>

// Why: config-shape errors (not user content); callers must truncate before `track` — `.max(200)` drops overlength strings.
export const agentHookInstallFailedSchema = z
  .object({
    agent: hookInstallAgentSchema,
    error_message: z.string().max(200)
  })
  .strict()

// Why: regression signal for paneKey attribution — a hook event that can't route to a pane. See docs/cli-terminal-hook-pane-key.md.
export const agentHookUnattributedSchema = z
  .object({ reason: z.enum(['empty_pane_key', 'unknown_tab_id']) })
  .strict()

// Why (#11217): loopback hook POSTs reset mid-body by local security software kill agent status for
// every runtime at once. Count only — the truncated bodies carry user prompts and tool I/O, so
// nothing derived from them may reach the wire.
export const agentHookTransportBlockedSchema = z
  .object({ count: z.number().int().nonnegative() })
  .strict()
