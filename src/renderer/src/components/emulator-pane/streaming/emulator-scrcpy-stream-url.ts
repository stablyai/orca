// Android sessions stream H.264 over scrcpy://<serial>; iOS uses an MJPEG http URL.
const SCRCPY_PREFIX = 'scrcpy://'

export function scrcpyDeviceIdFromStreamUrl(streamUrl: string | undefined): string | null {
  return streamUrl?.startsWith(SCRCPY_PREFIX) ? streamUrl.slice(SCRCPY_PREFIX.length) || null : null
}
