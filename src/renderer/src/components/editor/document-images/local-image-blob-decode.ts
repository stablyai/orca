/** Base64 characters decoded per slice: about 3 MB of bytes, a few milliseconds of work each. */
const SLICE_CHARS = 4 * 1024 * 1024

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** Bytes a base64 payload decodes to, without decoding it (whitespace-free input). */
export function decodedBase64Length(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/** Decode a large base64 payload into a Blob in slices, yielding between them, so a photo-sized
 *  image never holds the renderer in one long task. */
export async function base64ToBlobInSlices(
  base64: string,
  mimeType: string,
  sliceChars = SLICE_CHARS
): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let carry = ''
  for (let start = 0; start < base64.length; start += sliceChars) {
    const text = carry + base64.slice(start, start + sliceChars).replace(/\s/g, '')
    const whole =
      start + sliceChars >= base64.length ? text.length : text.length - (text.length % 4)
    carry = text.slice(whole)
    const binary = atob(text.slice(0, whole))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    parts.push(bytes)
    if (start + sliceChars < base64.length) {
      await yieldToEventLoop()
    }
  }
  return new Blob(parts, { type: mimeType })
}
