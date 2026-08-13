// Why: previewable binaries cross IPC as base64 text, so a viewer that has to
// look at the bytes (rather than hand them to an <img>) decodes them itself.
export function decodeBase64ToBytes(base64: string): Uint8Array {
  // Why: `atob` rejects the whitespace that line-wrapped base64 carries, and
  // rejects the URL-safe alphabet outright.
  const normalized = base64.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
