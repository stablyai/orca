import {
  evaluateRuntimeCompat,
  type RuntimeCompatVerdict
} from '../../../../../shared/protocol-compat'
import { describeRuntimeCompatBlock } from '@/runtime/hosts/display/runtime-host-copy'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'

/** Marker on the compat-gate block error. Tagged as a `.code` on a plain Error
 *  (not a subclass) so the gate keeps throwing an `Error` — its other consumer,
 *  the runtime-environment switch flow, reads only `.message` and is unaffected. */
export const RUNTIME_COMPAT_BLOCK_CODE = 'runtime_compat_block'

/** True when `error` is the protocol-compat block thrown by
 *  `assertRuntimeStatusCompatible` (vs a transient transport/timeout error). */
export function isRuntimeCompatBlockError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === RUNTIME_COMPAT_BLOCK_CODE
}

export type RuntimeStatusCompatInput = Pick<
  RuntimeStatus,
  | 'runtimeProtocolVersion'
  | 'minCompatibleRuntimeClientVersion'
  | 'protocolVersion'
  | 'minCompatibleMobileVersion'
>

/** The one mapping from a host's status to the protocol verdict; the gate and cloud skew notice share it. */
export function evaluateRuntimeStatusCompat(
  status: RuntimeStatusCompatInput,
  client: { protocolVersion: number; minCompatibleServerProtocolVersion: number } = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
  }
): RuntimeCompatVerdict {
  return evaluateRuntimeCompat({
    clientProtocolVersion: client.protocolVersion,
    minCompatibleServerProtocolVersion: client.minCompatibleServerProtocolVersion,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
}

export function assertRuntimeStatusCompatible(status: RuntimeStatus): void {
  const verdict = evaluateRuntimeStatusCompat(status)
  if (verdict.kind === 'blocked') {
    // Keep Error message while tagging code so callers distinguish protocol blocks from transient transport failures.
    const error = new Error(describeRuntimeCompatBlock(verdict))
    ;(error as { code?: string }).code = RUNTIME_COMPAT_BLOCK_CODE
    throw error
  }
}

export function isRuntimeStatusCompatible(status: RuntimeStatus): boolean {
  try {
    assertRuntimeStatusCompatible(status)
    return true
  } catch {
    return false
  }
}
