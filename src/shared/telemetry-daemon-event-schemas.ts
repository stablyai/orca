import { z } from 'zod'
import { AGENT_HOOK_TARGETS } from './agent-hook-types'
import { ERRNO_CODE_PATTERN } from './errno-code'
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
  DAEMON_CODE_IDENTITY_VALUES,
  DAEMON_PTY_CWD_CLASSES,
  DAEMON_SPAWNER_PATH_CLASSES,
  DAEMON_TCC_ATTRIBUTION_VALUES
} from './daemon-adoption-telemetry'
import { errorClassSchema, settingsChangedKeySchema } from './telemetry-property-schemas'

// Enum-only start-failure signals diagnose fleet outages without sending raw stderr (v1.4.129-rc.1).
export const daemonStartFailedSchema = z.object({ error_class: errorClassSchema }).strict()

export const runtimeRpcStartErrorClassSchema = z.enum([
  'permission_denied',
  'address_in_use',
  'storage_unavailable',
  'invalid_path',
  'unknown'
])
export type RuntimeRpcStartErrorClass = z.infer<typeof runtimeRpcStartErrorClassSchema>

// Discovery errors may contain user paths; send only closed filesystem/socket categories.
export const runtimeRpcStartFailedSchema = z
  .object({ error_class: runtimeRpcStartErrorClassSchema })
  .strict()

// Why: classify session-killing 1013 closures as producer size failures or queue backpressure.
export const remoteOutboundBudgetCloseSchema = z
  .object({ emitter: z.enum(['size', 'queue']) })
  .strict()

// Main deadlocks yield no crash report. self_recovered separates stalls that resolved from those a recovery kill might help;
// keep observed unresponsive_ms raw to calibrate the 45s threshold without assuming every stall needs termination.
export const mainThreadHangDetectedSchema = z
  .object({
    unresponsive_ms: z.number().int().nonnegative(),
    self_recovered: z.boolean()
  })
  .strict()

// Where the daemon came from; `code_identity` is #21826's unlinked-executable theory under measurement.
const daemonOriginProps = {
  app_version_match: z.enum(DAEMON_ADOPTED_APP_VERSION_MATCH),
  spawner_path_class: z.enum(DAEMON_SPAWNER_PATH_CLASSES),
  code_identity: z.enum(DAEMON_CODE_IDENTITY_VALUES)
}

// Once per macOS launch adopting an old-bundle daemon, which replacement lifecycle events miss (#17696); enum-only.
export const daemonAdoptedSchema = z
  .object({
    ...daemonOriginProps,
    tcc_attribution: z.enum(DAEMON_TCC_ATTRIBUTION_VALUES),
    live_session_count_bucket: z.enum(DAEMON_LIFECYCLE_SESSION_BUCKETS)
  })
  .strict()

export const DAEMON_ASYNC_IO_STALL_DURATION_BUCKETS = ['<1m', '1-5m', '5-30m', '30m+'] as const

// Why: measures how often daemon worker-pool stalls start and how long they last before clearing.
const daemonAsyncIoHealthBase = {
  protocol_generation: z.number().int().positive().max(1_000),
  app_version_match: z.enum(DAEMON_ADOPTED_APP_VERSION_MATCH)
}
export const daemonAsyncIoHealthSchema = z.discriminatedUnion('transition', [
  z.object({ transition: z.literal('stalled'), ...daemonAsyncIoHealthBase }).strict(),
  z
    .object({
      transition: z.literal('recovered'),
      ...daemonAsyncIoHealthBase,
      stalled_for_bucket: z.enum(DAEMON_ASYNC_IO_STALL_DURATION_BUCKETS)
    })
    .strict()
])

// Denied means proven app/daemon cwd-access divergence; readable is the TCC-folder-only control (#17696).
export const daemonPtyCwdVerdictSchema = z
  .object({ cwd_class: z.enum(DAEMON_PTY_CWD_CLASSES), ...daemonOriginProps })
  .strict()

// Count notice exposure/action/restart outcome against daemon_pty_cwd_denied incidence (STA-7948).
export const daemonFolderAccessNoticeSchema = z
  .object({
    action: z.enum([
      'shown',
      'fix_opened',
      'settings_opened',
      'restart_clicked',
      'dismissed',
      'restart_outcome_fixed',
      'restart_outcome_still_denied',
      'reset_clicked',
      'reset_outcome_allowed',
      'reset_outcome_still_denied',
      'reset_outcome_unknown'
    ]),
    cwd_class: z.enum(DAEMON_PTY_CWD_CLASSES)
  })
  .strict()

// Diagnose replacement/retirement without requesting daemon.log (#7936). Enum/bucket-only fields exclude paths/raw versions/exact counts;
// the union pins reasons to transitions so death cannot masquerade as replacement.
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

// Measure Codex app-server trust grants instead of computed trusted_hash: fallback/verify_failed detect rollout failures.
// Omit steady ledger skips (launch volume only); lane separates real/managed homes and closed error/verify classes explain failures without raw errors.
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

// Verify profile authority/migration rollout with enums only; never send paths, profile IDs or serialized state.
export const profileStateAuthoritySelectedSchema = z
  .object({
    backend: z.enum(['json', 'sqlite']),
    classification: z.enum(['neither', 'json-only', 'sqlite-only', 'both']),
    authority_mode: z.enum(['legacy', 'sqlite-candidate', 'sqlite-established']),
    runtime: z.enum(['desktop', 'orcad']),
    migrated: z.boolean()
  })
  .strict()

// Managed-hook installer label from `AGENT_HOOK_TARGETS`, distinct from `AGENT_KIND_VALUES`; `claude` (not `claude-code`) is intentional.
export const hookInstallAgentSchema = z.enum(AGENT_HOOK_TARGETS)
export type HookInstallAgent = z.infer<typeof hookInstallAgentSchema>

// Why (#21492): field name kept for dashboards, but it holds an errno code or 'unknown', never the raw message (home-dir paths).
export const agentHookInstallFailedSchema = z
  .object({
    agent: hookInstallAgentSchema,
    error_message: z.union([z.literal('unknown'), z.string().regex(ERRNO_CODE_PATTERN)])
  })
  .strict()

// Measure paneKey routing failures; see docs/cli-terminal-hook-pane-key.md.
export const agentHookUnattributedSchema = z
  .object({ reason: z.enum(['empty_pane_key', 'unknown_tab_id']) })
  .strict()

// Security software resetting loopback hook bodies can kill all runtime status (#11217). Count only;
// truncated bodies contain prompts/tool I/O, so send nothing derived from them.
export const agentHookTransportBlockedSchema = z
  .object({ count: z.number().int().nonnegative() })
  .strict()
