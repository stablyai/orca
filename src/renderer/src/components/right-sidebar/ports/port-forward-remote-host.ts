// Loopback and wildcard binds are all reachable as localhost from the SSH host.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])

export function portForwardRemoteHost(host: string | undefined): string {
  if (!host || LOOPBACK_HOSTS.has(host)) {
    return 'localhost'
  }
  return host
}

/** Matches a detected listener to an existing forward across loopback aliases. */
export function portForwardKey(host: string | undefined, port: number): string {
  return `${portForwardRemoteHost(host)}:${port}`
}
