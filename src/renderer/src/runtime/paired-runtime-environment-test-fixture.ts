import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'

/** A paired environment catalog row; the fields a test names override these defaults. */
export function publicRuntimeEnvironment(
  fields: Pick<PublicKnownRuntimeEnvironment, 'id'> & Partial<PublicKnownRuntimeEnvironment>
): PublicKnownRuntimeEnvironment {
  return {
    name: fields.id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://server' }],
    preferredEndpointId: 'ws-1',
    ...fields
  }
}

/** The status of a host that answered on the given connection. */
export function connectedRuntimeStatus(
  runtimeId: string,
  connectionGeneration: number
): RuntimeEnvironmentStatus {
  return {
    status: {
      runtimeId,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    },
    checkedAt: 1,
    connectionGeneration
  }
}
