// Why: runtime clients can be CLI, desktop, or future non-Electron shells.
// Keeping the envelope contract here avoids making those clients import each
// other just to validate the shared RPC frame shape.
import { z } from 'zod'

const MetaSuccess = z.object({
  runtimeId: z.string()
})

const MetaFailure = z
  .object({
    runtimeId: z.union([z.string(), z.null()])
  })
  .optional()

const Success = z.object({
  id: z.string(),
  ok: z.literal(true),
  result: z.unknown(),
  _meta: MetaSuccess
})

const Failure = z.object({
  id: z.string(),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    data: z.unknown().optional()
  }),
  _meta: MetaFailure
})

const Keepalive = z.object({
  _keepalive: z.literal(true)
})

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

export type RuntimeRpcKeepaliveFrame = z.infer<typeof Keepalive>

export function isKeepaliveFrame(frame: unknown): frame is RuntimeRpcKeepaliveFrame {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    '_keepalive' in frame &&
    (frame as { _keepalive: unknown })._keepalive === true
  )
}
