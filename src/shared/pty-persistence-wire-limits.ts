import { measureUtf8ByteLength } from './utf8-byte-limits'

export const MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES = 64 * 1024

export function isRelayPtyPersistenceFieldWithinLimit(
  value: string,
  maxBytes = MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES
): boolean {
  return !measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
}

export function assertRelayPtyPersistenceFieldWithinLimit(field: string, value: string): void {
  if (!isRelayPtyPersistenceFieldWithinLimit(value)) {
    throw new Error(
      `PTY persistence field "${field}" exceeds ${MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES} bytes`
    )
  }
}
