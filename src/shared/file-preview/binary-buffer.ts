// A NUL byte in the first chunk is git's own heuristic for "this is binary".
export const BINARY_PROBE_BYTES = 8192

export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_PROBE_BYTES)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}
