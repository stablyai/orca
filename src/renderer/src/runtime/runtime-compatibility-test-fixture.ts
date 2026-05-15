import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

export type RuntimeEnvironmentCallRequest = {
  method: string
}

export function createCompatibleRuntimeStatusResponse(
  runtimeId = 'remote-runtime'
): RuntimeRpcResponse<RuntimeStatus> {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId }
  }
}

export function createCompatibleRuntimeStatusResponseIfNeeded(
  args: RuntimeEnvironmentCallRequest,
  runtimeId?: string
): RuntimeRpcResponse<RuntimeStatus> | null {
  return args.method === 'status.get' ? createCompatibleRuntimeStatusResponse(runtimeId) : null
}
