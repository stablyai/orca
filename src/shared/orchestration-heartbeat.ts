import type { GlobalSettings } from './global-settings-types'

/** Minutes between worker heartbeats; the stale-worker warning fires after two missed intervals. */
export const ORCHESTRATION_HEARTBEAT_INTERVAL_MINUTES = 5

/** Minutes between heartbeats a dispatched worker is told to send, or null when the user turned heartbeats off. */
export function resolveOrchestrationHeartbeatMinutes(
  settings: Pick<GlobalSettings, 'orchestrationHeartbeatsEnabled'> | null | undefined
): number | null {
  return settings?.orchestrationHeartbeatsEnabled === false
    ? null
    : ORCHESTRATION_HEARTBEAT_INTERVAL_MINUTES
}
