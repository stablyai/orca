import { z } from 'zod'
import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from './bridge-limits'

const MethodSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/)

/** Long enough for the slowest host call the page makes, an SSH connect. The shell still applies
 * its own default when the page names none. */
export const MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS = 180_000

export const MobileWebHostRequestPayloadSchema = z
  .object({
    method: MethodSchema,
    workspaceId: z.string().min(1).max(160).optional(),
    params: z.record(z.string(), z.unknown()),
    timeoutMs: z.number().int().min(1).max(MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS).optional()
  })
  .strict()

export const MobileWebHostResultSchema = z.unknown()
export type MobileWebHostRequestPayload = z.infer<typeof MobileWebHostRequestPayloadSchema>

/** The desktop cancel method for a subscribe method: only the trailing segment differs. Anything
 * that is not a subscribe method has no cancel and returns `undefined`, which callers treat as an
 * unsupported capability. */
export function mobileWebHostUnsubscribeMethod(method: string): string | undefined {
  if (method.endsWith('.watch')) {
    return `${method.slice(0, -'.watch'.length)}.unwatch`
  }
  if (method.endsWith('.subscribe')) {
    return `${method.slice(0, -'.subscribe'.length)}.unsubscribe`
  }
  return undefined
}

/** Encoded JSON bytes are the envelope's only domain-independent size limit. */
export function mobileWebHostPayloadByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) {
      return undefined
    }
    const bytes = new TextEncoder().encode(json).byteLength
    return bytes <= MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES ? bytes : undefined
  } catch {
    return undefined
  }
}
