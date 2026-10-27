/** Renderer-only: omitted from the settings-update RPC so workers cannot change their own heartbeat policy. */
export type OrchestrationHeartbeatSettings = {
  /** Tell dispatched workers to send periodic heartbeats; absent means on. */
  orchestrationHeartbeatsEnabled?: boolean
  /** Minutes between heartbeats while they are on (1-60); absent means 5. */
  orchestrationHeartbeatIntervalMinutes?: number
}

/** Minutes between worker heartbeats; the stale-worker warning fires after two missed intervals. */
export const ORCHESTRATION_HEARTBEAT_INTERVAL_MINUTES = 5
export const ORCHESTRATION_HEARTBEAT_INTERVAL_MIN_MINUTES = 1
export const ORCHESTRATION_HEARTBEAT_INTERVAL_MAX_MINUTES = 60

/** Out-of-range or non-integer values fall back to the default so a malformed setting cannot reach a worker's brief. */
export function resolveOrchestrationHeartbeatInterval(
  settings:
    | Pick<OrchestrationHeartbeatSettings, 'orchestrationHeartbeatIntervalMinutes'>
    | null
    | undefined
): number {
  const raw = settings?.orchestrationHeartbeatIntervalMinutes
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < ORCHESTRATION_HEARTBEAT_INTERVAL_MIN_MINUTES ||
    raw > ORCHESTRATION_HEARTBEAT_INTERVAL_MAX_MINUTES
  ) {
    return ORCHESTRATION_HEARTBEAT_INTERVAL_MINUTES
  }
  return raw
}

/** Minutes between heartbeats a dispatched worker is told to send, or null when the user turned heartbeats off. */
export function resolveOrchestrationHeartbeatMinutes(
  settings: OrchestrationHeartbeatSettings | null | undefined
): number | null {
  return settings?.orchestrationHeartbeatsEnabled === false
    ? null
    : resolveOrchestrationHeartbeatInterval(settings)
}
