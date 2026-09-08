// Decode an fs:readFile base64 payload into the ArrayBuffer epub.js expects.
export function epubBase64ToArrayBuffer(content: string): ArrayBuffer {
  const cleaned = content.replace(/\s/g, '')
  let binary: string
  try {
    binary = globalThis.atob(cleaned)
  } catch {
    throw new Error('Failed to decode EPUB content')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
