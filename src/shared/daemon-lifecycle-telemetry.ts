// App-observed replacements/death-respawns only (STA-2376); subprocess retirement causes such as PAM rejection/probe timeout never cross into the app.

// Startup launcher replaced a still-connectable daemon (each maps 1:1 to a `daemon-replacement-preflight.ts` decision).
export const DAEMON_REPLACE_REASONS = [
  'unhealthy_resolver',
  'stale_bundle',
  'different_app_path',
  'failed_health_check',
  'severed_tcc_attribution',
  'severed_host_image'
] as const
export type DaemonReplaceReason = (typeof DAEMON_REPLACE_REASONS)[number]

// Adapter observed the daemon die and forked a replacement.
export const DAEMON_RETIRE_REASONS = ['died_respawn'] as const
export type DaemonRetireReason = (typeof DAEMON_RETIRE_REASONS)[number]

export const DAEMON_LIFECYCLE_TRANSITIONS = ['replaced', 'retired'] as const

// Bucket counts to avoid fingerprinting heavy users; unknown covers unverifiable wedged/dead targets.
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
