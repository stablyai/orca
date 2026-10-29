export const PLUGIN_SOURCE_MAX_BYTES = 256 * 1024

export function assertPluginSourceUnderByteCap(fieldName: string, value: unknown): void {
  if (typeof value !== 'string') {
    return
  }
  // Cap UTF-8 wire bytes, not UTF-16 code units; non-ASCII source must not bypass the bound.
  if (Buffer.byteLength(value, 'utf8') > PLUGIN_SOURCE_MAX_BYTES) {
    throw new Error(`${fieldName} exceeds ${PLUGIN_SOURCE_MAX_BYTES} byte cap`)
  }
}
