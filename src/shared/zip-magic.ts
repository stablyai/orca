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