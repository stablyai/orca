export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  if ((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) {
    return true
  }
  // Why: window may exist without a location (some test/embedding contexts),
  // so guard the pathname read instead of assuming window.location is present.
  return Boolean(window.location?.pathname?.endsWith('/web-index.html'))
}
