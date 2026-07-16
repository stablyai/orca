export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  if ((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) {
    return true
  }
  try {
    return window.location.pathname.endsWith('/web-index.html')
  } catch {
    return false
  }
}
