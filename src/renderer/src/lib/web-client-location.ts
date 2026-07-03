export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    window.location.pathname.endsWith('/web-index.html')
  )
}
