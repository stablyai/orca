const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The port of an OAuth authorize URL's loopback `redirect_uri` (RFC 8252 native-app flow), else null.
 * Only http loopback redirects with an explicit unprivileged port qualify. */
export function loopbackOAuthRedirectPort(url: string): number | null {
  let authorize: URL
  try {
    authorize = new URL(url)
  } catch {
    return null
  }
  const params = authorize.searchParams
  const redirect = params.get('redirect_uri')
  if (
    (authorize.protocol !== 'https:' && authorize.protocol !== 'http:') ||
    !redirect ||
    (!params.has('client_id') && params.get('response_type') !== 'code')
  ) {
    return null
  }
  try {
    const target = new URL(redirect)
    const port = Number(target.port)
    return target.protocol === 'http:' &&
      LOOPBACK.has(target.hostname.toLowerCase()) &&
      Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65_535
      ? port
      : null
  } catch {
    return null
  }
}
