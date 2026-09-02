import { describeRuntimeCompatBlock, evaluateRuntimeCompat } from '../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'

/** Marker on the compat-gate block error. Tagged as a `.code` on a plain Error
 *  (not a subclass) so the gate keeps throwing an `Error` — its other consumer,
 *  the runtime-environment switch flow, reads only `.message` and is unaffected. */
export const RUNTIME_COMPAT_BLOCK_CODE = 'runtime_compat_block'

/** True when `error` is the protocol-compat block thrown by
 *  `assertRuntimeStatusCompatible` (vs a transient transport/timeout error). */
export function isRuntimeCompatBlockError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === RUNTIME_COMPAT_BLOCK_CODE
}

export function assertRuntimeStatusCompatible(status: RuntimeStatus): void {
  const verdict = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
  if (verdict.kind === 'blocked') {
    // Preserve the descriptive message; add a `.code` marker so callers can
    // distinguish a version block from a transport failure.
    const error = new Error(describeRuntimeCompatBlock(verdict))
    ;(error as { code?: string }).code = RUNTIME_COMPAT_BLOCK_CODE
    throw error
  }
}
