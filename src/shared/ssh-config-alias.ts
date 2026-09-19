/**
 * Canonical form for an SSH config alias. OpenSSH matches Host patterns
 * case-insensitively, so the picker, import reconciliation, delete tombstones
 * and the save-time duplicate check must all compare aliases through this.
 */
export function normalizeSshConfigAlias(alias: string | null | undefined): string {
  return alias ? alias.trim().toLowerCase() : ''
}

/** The machine a target actually reaches: hostname, port and user, normalized.
 *  Empty when the host is unknown, so an unresolved alias never collides. */
export function sshEndpointIdentity(target: {
  host?: string | null
  port?: number | null
  username?: string | null
}): string {
  const host = target.host?.trim().toLowerCase() ?? ''
  if (!host) {
    return ''
  }
  const port =
    typeof target.port === 'number' &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65_535
      ? target.port
      : 22
  return `${host}\u0000${port}\u0000${target.username?.trim().toLowerCase() ?? ''}`
}
