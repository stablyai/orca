export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  const pathname = window.location?.pathname
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    Boolean(pathname?.endsWith('/web-index.html'))
  )
}
