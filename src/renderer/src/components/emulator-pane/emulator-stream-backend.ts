// The pane infers its backend from the preview URL: Android sessions publish a
// scrcpy pseudo-URL, iOS sessions an MJPEG endpoint.
export const SCRCPY_STREAM_PREFIX = 'scrcpy://'

export function androidDeviceIdFromStreamUrl(previewUrl?: string): string | null {
  return previewUrl?.startsWith(SCRCPY_STREAM_PREFIX)
    ? previewUrl.slice(SCRCPY_STREAM_PREFIX.length)
    : null
}

export function isIosStreamUrl(previewUrl?: string): boolean {
  return Boolean(previewUrl) && !previewUrl?.startsWith(SCRCPY_STREAM_PREFIX)
}
