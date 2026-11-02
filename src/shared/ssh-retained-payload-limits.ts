import { measureUtf8ByteLength } from './utf8-byte-limits'

export const SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES = 1024
export const SSH_CONNECTION_ERROR_MAX_UTF8_BYTES = 16 * 1024

export function isSshRetainedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !measureUtf8ByteLength(value, {
      stopAfterBytes: SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES
    }).exceededLimit
  )
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
