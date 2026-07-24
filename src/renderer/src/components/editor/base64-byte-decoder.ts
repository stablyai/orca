const BASE64_DECODE_CHUNK_CHARS = 32 * 1024

export function decodeBase64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const normalized = /\s/.test(base64) ? base64.replace(/\s/g, '') : base64
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array(Math.floor((normalized.length * 3) / 4) - padding)
  let targetOffset = 0
  for (let sourceOffset = 0; sourceOffset < normalized.length; ) {
    const sourceEnd = Math.min(sourceOffset + BASE64_DECODE_CHUNK_CHARS, normalized.length)
    const binary = atob(normalized.slice(sourceOffset, sourceEnd))
    for (let index = 0; index < binary.length; index += 1) {
      bytes[targetOffset] = binary.charCodeAt(index)
      targetOffset += 1
    }
    sourceOffset = sourceEnd
  }
  return bytes
}
