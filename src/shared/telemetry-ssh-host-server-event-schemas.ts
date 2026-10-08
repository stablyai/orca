import { z } from 'zod'
import { SSH_RUNTIME_DURATION_BUCKETS } from './telemetry-ssh-runtime-event-schemas'

// Why enum-only: these rows size how many hosts still need the relay before it can retire. A
// hostname, user, path, log line or raw error would identify a machine, so none may appear.

export const SSH_HOST_SERVER_OUTCOME_VALUES = ['managed', 'deployed', 'converted', 'relay'] as const

/** Why orcad can't run on a host; mirrors main's OrcadHostUnavailableReason. */
const UNAVAILABLE_REASONS = [
  // The host refuses port forwarding and can't run the stdio bridge either.
  'ssh_tunnel_unavailable',
  'unsupported_host',
  'artifacts_unavailable',
  'libc_unidentified',
  'runtime_self_test',
  'security_software',
  'native_preflight'
] as const

export const SSH_HOST_SERVER_REASON_VALUES = [
  'connected',
  // A managed host's update on connect (ssh-host-server-update-on-connect.ts).
  'updated',
  'update_deferred',
  'update_failed',
  'update_host_newer',
  'update_rolled_back',
  'update_check_failed',
  'deployed',
  'converted',
  'source_changed',
  'relay_terminals_live',
  'relay_terminals_unverifiable',
  ...UNAVAILABLE_REASONS,
  'refused',
  'deferred',
  'failed',
  'other'
] as const

/** A conversion refusal's code without its `orcad_migration_` prefix. */
export const SSH_HOST_SERVER_REFUSAL_VALUES = [
  'none',
  'already_managed',
  'terminals',
  'target_not_found',
  'in_progress',
  'direct_ssh_connected',
  'preflight_blocked',
  'owned_by_deploy',
  'fenced_unverifiable',
  'stale_journal',
  'other'
] as const

/** A deploy's deferral code without its `orcad_` prefix, or why orcad can't run on the host. */
export const SSH_HOST_SERVER_FAILURE_VALUES = [
  ...UNAVAILABLE_REASONS,
  'activation_recovery_required',
  'candidate_preflight_failed',
  'candidate_launch_failed',
  'incumbent_identity_unverifiable',
  'outgoing_stop_incomplete',
  'activation_build_mismatch',
  'activation_daemon_absent',
  'activation_daemon_degraded',
  'activation_no_health',
  'activation_no_persistent_terminals',
  'activation_no_readiness',
  'activation_not_listening',
  'activation_pty_self_test_failed',
  'update_daemon_protocol_unverifiable',
  'update_ends_in_process_terminals',
  'update_strands_live_terminals',
  'update_terminal_census_unavailable',
  'update_terminals_running',
  'windows_launch_refused',
  'windows_command_line_unsafe',
  'other'
] as const

const hostFields = {
  host_os: z.enum(['linux', 'darwin', 'win32', 'unknown']),
  host_arch: z.enum(['x64', 'arm64', 'unknown']),
  // `unknown` when this session has not yet probed the host; the decision itself never probes.
  host_libc: z.enum(['glibc', 'musl', 'none', 'unknown'])
}

/** How the client reached a managed server; `none` when the host stayed on the relay. */
export const SSH_HOST_SERVER_TRANSPORT_VALUES = [
  'tcp_forward',
  'stdio_bridge',
  'none',
  'unknown'
] as const

export const SSH_HOST_SERVER_MOVE_OUTCOME_VALUES = [
  'offered',
  'moved',
  'stayed',
  'refused_live',
  'refused_unverifiable',
  'failed'
] as const

export const sshHostServerDecidedSchema = z
  .object({
    outcome: z.enum(SSH_HOST_SERVER_OUTCOME_VALUES),
    transport: z.enum(SSH_HOST_SERVER_TRANSPORT_VALUES),
    reason: z.enum(SSH_HOST_SERVER_REASON_VALUES),
    refusal: z.enum(SSH_HOST_SERVER_REFUSAL_VALUES),
    // True when a recorded "orcad can't run here" sent the host to the relay without a try.
    recorded: z.boolean(),
    ...hostFields,
    duration_bucket: z.enum(SSH_RUNTIME_DURATION_BUCKETS)
  })
  .strict()

export const sshHostServerConversionSchema = z
  .object({
    phase: z.enum(['started', 'committed', 'failed']),
    failure: z.enum(['none', 'deferred', 'refused', 'error']),
    refusal: z.enum(SSH_HOST_SERVER_REFUSAL_VALUES),
    failure_code: z.enum(['none', ...SSH_HOST_SERVER_FAILURE_VALUES]),
    ...hostFields,
    duration_bucket: z.enum(SSH_RUNTIME_DURATION_BUCKETS)
  })
  .strict()

export const sshHostServerDeployFailedSchema = z
  .object({
    // Whether the deploy ran for an empty host or inside a conversion.
    context: z.enum(['deploy', 'conversion']),
    failure: z.enum(['deferred', 'error']),
    failure_code: z.enum(SSH_HOST_SERVER_FAILURE_VALUES),
    ...hostFields,
    duration_bucket: z.enum(SSH_RUNTIME_DURATION_BUCKETS)
  })
  .strict()

/** The per-host offer to move a host whose open terminals keep it on the relay, and its result. */
export const sshHostServerMoveSchema = z
  .object({
    outcome: z.enum(SSH_HOST_SERVER_MOVE_OUTCOME_VALUES),
    ...hostFields
  })
  .strict()
