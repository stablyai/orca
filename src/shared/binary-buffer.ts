// A NUL byte in the first chunk is git's own heuristic for "this is binary".
const BINARY_SNIFF_BYTES = 8192

export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}
