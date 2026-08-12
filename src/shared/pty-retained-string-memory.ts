export const PTY_RETAINED_RECORD_BYTES = 128

export function chargedPtyRetainedStringBytes(value: string): number {
  return Math.max(Buffer.byteLength(value, 'utf8'), 2 * value.length) + PTY_RETAINED_RECORD_BYTES
}
