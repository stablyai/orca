import { randomBytes } from 'node:crypto'

const RETRY_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const RETRY_REQUEST_ID_GUIDANCE =
  '--retry-request must be the UUID Orca reported for the original request; pass it exactly as printed, or omit the flag to start a new request.'

export const VALUELESS_RETRY_REQUEST_GUIDANCE =
  '--retry-request requires a value; it was passed with none.'

/** The CLI and the SSH relay shim parse argv separately; both gate replay identity on this shape. */
export function isOrchestrationRetryRequestId(value: unknown): value is string {
  return typeof value === 'string' && RETRY_REQUEST_ID_PATTERN.test(value)
}

export const ORCHESTRATION_RETRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export function createOrchestrationRetryRequestId(issuedAtMs = Date.now()): string {
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 || issuedAtMs > 0xffffffffffff) {
    throw new RangeError('Request issue time must fit in a UUIDv7 timestamp')
  }
  const bytes = randomBytes(16)
  bytes.writeUIntBE(issuedAtMs, 0, 6)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function orchestrationRetryRequestIssuedAtMs(requestId: string): number | null {
  if (
    !isOrchestrationRetryRequestId(requestId) ||
    !/^7[0-9a-f]{3}-[89ab]/i.test(requestId.slice(14))
  ) {
    return null
  }
  return Number.parseInt(requestId.slice(0, 13).replace('-', ''), 16)
}
