import { describeRuntimeCompatBlock, evaluateRuntimeCompat } from '../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'

export function assertRuntimeStatusCompatible(status: RuntimeStatus): void {
  const verdict = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
  if (verdict.kind === 'blocked') {
    throw new Error(describeRuntimeCompatBlock(verdict))
  }
}
