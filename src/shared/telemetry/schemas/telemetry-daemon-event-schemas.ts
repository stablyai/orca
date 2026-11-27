import { z } from 'zod'
import {
  DAEMON_LIFECYCLE_SESSION_BUCKETS,
  DAEMON_LIFECYCLE_TRANSITIONS,
  DAEMON_REPLACE_REASONS,
  DAEMON_RETIRE_REASONS
} from '../daemon-lifecycle-telemetry'
import {
  DAEMON_AUDIT_GENERATION_ROLE_VALUES,
  DAEMON_AUDIT_PROCESS_REASON_VALUES,
  DAEMON_AUDIT_REASON_VALUES,
  DAEMON_AUDIT_STATE_VALUES,
  DAEMON_AUDIT_TRIGGER_VALUES,
  DAEMON_EVIDENCE_SOURCE_VALUES
} from '../../terminal/daemon/daemon-audit-eligibility'
import {
  DAEMON_ADOPTED_APP_VERSION_MATCH,
  DAEMON_CODE_IDENTITY_VALUES,
  DAEMON_PTY_CWD_CLASSES,
  DAEMON_SPAWNER_PATH_CLASSES,
  DAEMON_TCC_ATTRIBUTION_VALUES,
  MAC_TCC_FOLDER_CLASSES
} from '../daemon-adoption-telemetry'
import {
  ELAPSED_BUCKETS,
  FOLDER_FLAG_VALUES,
  FORK_FALLBACK_VALUES,
  FULL_DISK_ACCESS_VALUES,
  GOOD_READ_COUNT_BUCKETS,
  HELPER_AGE_BUCKETS,
  HELPER_ORIGIN_VALUES,
  ICLOUD_MANAGED_VALUES,
  REQUIREMENT_FAILURE_VALUES,
  SIGNATURE_CHECK_VALUES,
  TCC_ASKED_VALUES,
  TCC_AUTH_REASONS,
  TCC_AUTH_VALUES,
  TCC_LOG_ACCESS_VALUES,
  TCC_SERVICE_VALUES,
  VOLUME_TYPE_VALUES,
  YES_NO_VALUES
} from '../../terminal/daemon/daemon-tcc-denial-capture'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export {
  daemonStartFailedSchema,
  runtimeRpcStartErrorClassSchema,
  runtimeRpcStartFailedSchema,
  remoteOutboundBudgetCloseSchema,
  mainThreadHangDetectedSchema,
  codexTrustGrantSchema,
  settingsChangedSchema,
  profileStateAuthoritySelectedSchema,
  hookInstallAgentSchema,
  agentHookInstallFailedSchema,
  agentHookUnattributedSchema,
  agentHookTransportBlockedSchema,
  type RuntimeRpcStartErrorClass,
  type HookInstallAgent
} from './telemetry-daemon-runtime-event-schemas'

// Where the daemon came from; `code_identity` is #21826's unlinked-executable theory under measurement.
const createDaemonOriginProps = () => ({
  app_version_match: z.enum(DAEMON_ADOPTED_APP_VERSION_MATCH),
  spawner_path_class: z.enum(DAEMON_SPAWNER_PATH_CLASSES),
  code_identity: z.enum(DAEMON_CODE_IDENTITY_VALUES)
})

// Once per macOS launch adopting an old-bundle daemon, which replacement lifecycle events miss (#17696); enum-only.
export const daemonAdoptedSchema = lazyZodSchema(() =>
  z
    .object({
      ...createDaemonOriginProps(),
      tcc_attribution: z.enum(DAEMON_TCC_ATTRIBUTION_VALUES),
      live_session_count_bucket: z.enum(DAEMON_LIFECYCLE_SESSION_BUCKETS)
    })
    .strict()
)

export const DAEMON_ASYNC_IO_STALL_DURATION_BUCKETS = ['<1m', '1-5m', '5-30m', '30m+'] as const

// Why: measures how often daemon worker-pool stalls start and how long they last before clearing.
const createDaemonAsyncIoHealthBase = () => ({
  protocol_generation: z.number().int().positive().max(1_000),
  app_version_match: z.enum(DAEMON_ADOPTED_APP_VERSION_MATCH)
})
export const daemonAsyncIoHealthSchema = lazyZodSchema(() => {
  const base = createDaemonAsyncIoHealthBase()
  return z.discriminatedUnion('transition', [
    z.object({ transition: z.literal('stalled'), ...base }).strict(),
    z
      .object({
        transition: z.literal('recovered'),
        ...base,
        stalled_for_bucket: z.enum(DAEMON_ASYNC_IO_STALL_DURATION_BUCKETS)
      })
      .strict()
  ])
})

// Denied means proven app/daemon cwd-access divergence; readable is the TCC-folder-only control (#17696).
export const daemonPtyCwdVerdictSchema = lazyZodSchema(() =>
  z.object({ cwd_class: z.enum(DAEMON_PTY_CWD_CLASSES), ...createDaemonOriginProps() }).strict()
)

// macOS's own verdict at a confirmed denial, once per helper and folder class; raw lines stay in a local file.
export const daemonPtyCwdDenialCaptureSchema = lazyZodSchema(() =>
  z
    .object({
      cwd_class: z.enum(MAC_TCC_FOLDER_CLASSES),
      log_access: z.enum(TCC_LOG_ACCESS_VALUES),
      tccd_asked: z.enum(TCC_ASKED_VALUES),
      auth_value: z.enum(TCC_AUTH_VALUES),
      auth_reason: z.enum(TCC_AUTH_REASONS),
      service: z.enum(TCC_SERVICE_VALUES),
      requirement_failure: z.enum(REQUIREMENT_FAILURE_VALUES),
      kernel_deny: z.enum(YES_NO_VALUES),
      live_signature: z.enum(SIGNATURE_CHECK_VALUES),
      disk_copy_signature: z.enum(SIGNATURE_CHECK_VALUES),
      helper_age_bucket: z.enum(HELPER_AGE_BUCKETS),
      helper_origin: z.enum(HELPER_ORIGIN_VALUES),
      good_reads_bucket: z.enum(GOOD_READ_COUNT_BUCKETS),
      since_good_read_bucket: z.enum(ELAPSED_BUCKETS),
      since_resume_bucket: z.enum(ELAPSED_BUCKETS),
      since_unlock_bucket: z.enum(ELAPSED_BUCKETS),
      since_user_active_bucket: z.enum(ELAPSED_BUCKETS),
      full_disk_access: z.enum(FULL_DISK_ACCESS_VALUES),
      fork_fallback: z.enum(FORK_FALLBACK_VALUES),
      folder_dataless: z.enum(FOLDER_FLAG_VALUES),
      folder_icloud: z.enum(ICLOUD_MANAGED_VALUES),
      volume_type: z.enum(VOLUME_TYPE_VALUES)
    })
    .strict()
)

// Count notice exposure/action/restart outcome against daemon_pty_cwd_denied incidence (STA-7948).
export const daemonFolderAccessNoticeSchema = lazyZodSchema(() =>
  z
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
)

// Diagnose replacement/retirement without requesting daemon.log (#7936). Enum/bucket-only fields exclude paths/raw versions/exact counts;
// the union pins reasons to transitions so death cannot masquerade as replacement.
export const daemonLifecycleSchema = lazyZodSchema(() =>
  z.discriminatedUnion('transition', [
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
)

export const daemonAuditEligibilityBaseSchema = lazyZodSchema(() =>
  z.object({
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
    endpoint_state: z.enum(['missing', 'named-pipe', 'non-socket', 'socket', 'unknown']),
    sample_rate: z.literal(0.001).optional()
  })
)

export const daemonAuditEligibilitySchema = lazyZodSchema(() =>
  z.discriminatedUnion('exact_incarnation', [
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
    daemonAuditEligibilityBaseSchema
      .extend({ exact_incarnation: z.literal('unavailable') })
      .strict()
  ])
)
