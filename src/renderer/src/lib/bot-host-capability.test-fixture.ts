import type { RuntimeEnvironmentStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** Verified paired servers by environment id, each with or without the given capabilities. */
export function pairedHostStatuses(
  capabilitiesByEnvironment: Record<string, string[]>
): Map<string, RuntimeEnvironmentStatus> {
  return new Map(
    Object.entries(capabilitiesByEnvironment).map(([environmentId, capabilities]) => {
      const status: RuntimeStatus = {
        runtimeId: environmentId,
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities
      }
      return [environmentId, { status, checkedAt: 1 }]
    })
  )
}
