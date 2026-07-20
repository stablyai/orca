import {
  describeRuntimeCompatBlock,
  evaluateRuntimeCompat,
  type RuntimeCompatVerdict
} from '../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'

/** Marker on the compat-gate block error. Tagged as a `.code` on a plain Error
 *  (not a subclass) so the gate keeps throwing an `Error` — its other consumer,
 *  the runtime-environment switch flow, reads only `.message` and is unaffected. */
export const RUNTIME_COMPAT_BLOCK_CODE = 'runtime_compat_block'

/** The compat verdict and the blocked server's status, carried on the thrown
 *  block error so the advisor can render detection/versions without re-probing.
 *  The gate stays a plain `Error` with `.code` + `.message`; these are extra
 *  own-properties consumers read only through `getRuntimeCompatBlockDetails`. */
export type RuntimeCompatBlockDetails = {
  verdict: RuntimeCompatVerdict
  status: RuntimeStatus
}

/** True when `error` is the protocol-compat block thrown by
 *  `assertRuntimeStatusCompatible` (vs a transient transport/timeout error). */
export function isRuntimeCompatBlockError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === RUNTIME_COMPAT_BLOCK_CODE
}

/** Reads the verdict + status attached to a compat-block error. Returns null for
 *  any other error, or a block error thrown before this contract existed. */
export function getRuntimeCompatBlockDetails(error: unknown): RuntimeCompatBlockDetails | null {
  if (!isRuntimeCompatBlockError(error)) {
    return null
  }
  const { verdict, status } = error as { verdict?: RuntimeCompatVerdict; status?: RuntimeStatus }
  return verdict && status ? { verdict, status } : null
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
    // distinguish a version block from a transport failure, plus verdict/status
    // so the advisor can render guidance while the environment stays blocked.
    const error = new Error(describeRuntimeCompatBlock(verdict)) as Error &
      Partial<RuntimeCompatBlockDetails> & { code?: string }
    error.code = RUNTIME_COMPAT_BLOCK_CODE
    error.verdict = verdict
    error.status = status
    throw error
  }
}
