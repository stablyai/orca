// Share envelopes across CLI/desktop/non-Electron clients without client-to-client imports.
import { z } from 'zod'
import type { OrchestrationCompatibilityEvidence } from './orchestration-compatibility-evidence'

// Independently updated peers may add envelope fields; strip unknown fields while validating known ones.
const MetaSuccess = z
  .object({
    runtimeId: z.string()
  })
  .strip()

const MetaFailure = z
  .object({
    runtimeId: z.union([z.string(), z.null()])
  })
  .strip()
  .optional()

const Success = z
  .object({
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
    _meta: MetaSuccess
  })
  .strip()

const Failure = z
  .object({
    id: z.string(),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        data: z.unknown().optional()
      })
      .strip(),
    _meta: MetaFailure
  })
  .strip()

const Keepalive = z
  .object({
    _keepalive: z.literal(true)
  })
  .strip()

export const RuntimeRpcEnvelopeSchema = z.union([Success, Failure, Keepalive])

export type RuntimeRpcSuccess<TResult> = {
  id: string
  ok: true
  result: TResult
  _meta: {
    runtimeId: string
  }
}

export type RuntimeRpcFailure = {
  id: string
  ok: false
  error: {
    code: string
    message: string
    data?: unknown
  }
  _meta?: {
    runtimeId: string | null
  }
}

export type RuntimeRpcResponse<TResult> = RuntimeRpcSuccess<TResult> | RuntimeRpcFailure

export type RuntimeOrchestrationEnvelope = {
  orchestrationCapability?: string
  orchestrationContractVersion?: number
  orchestrationRequestId?: string
  compatibilityInvocationId?: string
  orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
}

/** Which runtime a request is meant for; a host that is not that runtime refuses it before any handler. */
export type ExpectedRuntimeSource = {
  /** The launching profile's installation id. */
  sourceId: string
  /** The runtime the client verified for this send. */
  runtimeId: string
}

export type RuntimeRpcKeepaliveFrame = z.infer<typeof Keepalive>

export function isKeepaliveFrame(frame: unknown): frame is RuntimeRpcKeepaliveFrame {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    '_keepalive' in frame &&
    (frame as { _keepalive: unknown })._keepalive === true
  )
}

/** Same-machine IPC observation only; remote hosts own their own monotonic operation budget. */
export type RuntimeRpcDispatchObservation = {
  expiresAt: number
  responseTimeoutMs: number
  responseExpiresAt?: number
}

/** Select request params from the status of the socket that will send them. */
export type RuntimeRequestSelection = {
  paramsForStatus: (status: unknown) => unknown
  onDispatch?: () => void
}
