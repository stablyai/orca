import { evaluateRuntimeCompat, type RuntimeCompatVerdict } from '../protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../protocol-version'
import type { RuntimeStatus } from '../runtime-types'
import type { ExecutionHostHealth } from './execution-host-health'

export function runtimeCompatibility(
  status: RuntimeStatus | null | undefined
): RuntimeCompatVerdict | null {
  if (!status) {
    return null
  }
  return evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
}

export function runtimeHealth(
  status: RuntimeStatus | null | undefined,
  compatibility: RuntimeCompatVerdict | null,
  remoteControl: RuntimeStatus['remoteControl'] | null | undefined
): ExecutionHostHealth {
  // Without live status, only ready shared control proves server reachability.
  if (!status) {
    return remoteControl?.state === 'ready' ? 'available' : 'disconnected'
  }
  if (!compatibility) {
    return 'available'
  }
  return compatibility.kind === 'blocked' ? 'blocked' : 'available'
}

export function runtimeControlHealth(
  remoteControl: RuntimeStatus['remoteControl'] | null | undefined
): ExecutionHostHealth | null {
  switch (remoteControl?.state) {
    case 'awaiting_authenticated':
    case 'awaiting_ready':
    case 'reconnecting':
      return 'connecting'
    case 'closed':
      return remoteControl.lastError ? 'error' : 'disconnected'
    case 'ready':
      return null
    case undefined:
      return null
  }
}
