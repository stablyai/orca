export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  // Why the pathname guard: `window` can exist without a usable `location`
  // (partial test doubles, and any embedder that stubs the global), and this
  // runs on the launch-routing path where a throw is swallowed and silently
  // turns into a failed launch rather than a visible error.
  const pathname = (window as { location?: { pathname?: unknown } }).location?.pathname
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    (typeof pathname === 'string' && pathname.endsWith('/web-index.html'))
  )
}
