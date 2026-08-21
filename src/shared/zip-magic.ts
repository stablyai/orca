// Why: .docx and .xlsx are both ZIP containers; a truncated/non-ZIP payload
// should fail with a clear "not a zip archive" error from both viewers, not
// surface as the generic viewer-specific "corrupt or encrypted" copy.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

export function isZipBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) {
    return false
  }
  const head = new Uint8Array(buffer, 0, 4)
  return (
    head[0] === ZIP_MAGIC[0] &&
    head[1] === ZIP_MAGIC[1] &&
    head[2] === ZIP_MAGIC[2] &&
    head[3] === ZIP_MAGIC[3]
  )
}

// Why: base64 payloads from the IPC/relay/runtime file-read path arrive as
// strings. DocxViewer and XlsxViewer both need raw bytes; hoist one helper
// so a future fix (whitespace tolerance, URL-safe alphabet) lands in one place.
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}