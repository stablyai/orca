export const PLUGIN_SOURCE_MAX_BYTES = 256 * 1024

export function assertPluginSourceUnderByteCap(fieldName: string, value: unknown): void {
  if (typeof value !== 'string') {
    return
  }
  // Why: the relay receives JSON strings over the wire; cap actual UTF-8
  // bytes instead of UTF-16 code units so non-ASCII source cannot bypass it.
  if (Buffer.byteLength(value, 'utf8') > PLUGIN_SOURCE_MAX_BYTES) {
    throw new Error(`${fieldName} exceeds ${PLUGIN_SOURCE_MAX_BYTES} byte cap`)
  }
}
