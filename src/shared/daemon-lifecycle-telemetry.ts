// Enums + bucketing for the `daemon_lifecycle` telemetry event (STA-2376).
// The daemon's own retirement cause (pam-rejections/probe-timeouts) lives in the
// subprocess and never crosses into the app, so every reason here is one the app
// itself decides: a startup replace, or an observed death→respawn.

// Startup launcher replaced a still-connectable daemon (each maps 1:1 to a `daemon-init.ts` decision).
export const DAEMON_REPLACE_REASONS = [
  'unhealthy_resolver',
  'stale_bundle',
  'different_app_path',
  'failed_health_check',
  'severed_tcc_attribution'
] as const
export type DaemonReplaceReason = (typeof DAEMON_REPLACE_REASONS)[number]

// Adapter observed the daemon die and forked a replacement.
export const DAEMON_RETIRE_REASONS = ['died_respawn'] as const
export type DaemonRetireReason = (typeof DAEMON_RETIRE_REASONS)[number]

export const DAEMON_LIFECYCLE_TRANSITIONS = ['replaced', 'retired'] as const

export const DAEMON_LIFECYCLE_REASONS = [
  ...DAEMON_REPLACE_REASONS,
  ...DAEMON_RETIRE_REASONS
] as const

// Bucketed, never raw: exact live-session counts could fingerprint heavy users. `unknown` when
// the count couldn't be verified (null) — e.g. a wedged daemon or an already-dead respawn target.
export const DAEMON_LIFECYCLE_SESSION_BUCKETS = ['0', '1', '2-5', '6+', 'unknown'] as const
export type DaemonLifecycleSessionBucket = (typeof DAEMON_LIFECYCLE_SESSION_BUCKETS)[number]

export function bucketDaemonLiveSessionCount(count: number | null): DaemonLifecycleSessionBucket {
  if (count === null) {
    return 'unknown'
  }
  if (count <= 0) {
    return '0'
  }
  if (count === 1) {
    return '1'
  }
  if (count <= 5) {
    return '2-5'
  }
  return '6+'
}
