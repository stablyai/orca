/**
 * `browser.downloadCopyStream`: the host sends a saved download as binary frames on the stream's
 * own socket, and the desktop acks each frame once it is on disk. The host sends at most a window
 * ahead of the acks, so neither side holds more than the window whatever the file's size.
 */
export const BROWSER_DOWNLOAD_COPY_FRAME_BYTES = 256 * 1024
export const BROWSER_DOWNLOAD_COPY_WINDOW_BYTES = 8 * BROWSER_DOWNLOAD_COPY_FRAME_BYTES

/** JSON events around the binary frames: the size first, then `end` once every byte is acked. */
export type BrowserDownloadCopyStreamEvent = { type: 'start'; size: number } | { type: 'end' }

const ACK_BYTES = 8

/** The desktop's ack: how many bytes it has written so far. */
export function encodeBrowserDownloadCopyAck(writtenBytes: number): Uint8Array {
  const frame = new Uint8Array(ACK_BYTES)
  new DataView(frame.buffer).setFloat64(0, writtenBytes, true)
  return frame
}

/** Null for anything that isn't an ack. */
export function decodeBrowserDownloadCopyAck(frame: Uint8Array): number | null {
  if (frame.byteLength !== ACK_BYTES) {
    return null
  }
  const written = new DataView(frame.buffer, frame.byteOffset, ACK_BYTES).getFloat64(0, true)
  return Number.isSafeInteger(written) && written >= 0 ? written : null
}

export function readBrowserDownloadCopyStreamEvent(
  value: unknown
): BrowserDownloadCopyStreamEvent | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null
  }
  if (value.type === 'end') {
    return { type: 'end' }
  }
  if (value.type === 'start' && 'size' in value) {
    const { size } = value
    return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
      ? { type: 'start', size }
      : null
  }
  return null
}
