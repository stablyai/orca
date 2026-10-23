import { isIP } from 'node:net'

export const ORCAD_LOOPBACK_BIND_HOST = '127.0.0.1'

export class OrcadBindAddressError extends Error {
  readonly code = 'orcad_invalid_bind_address'
}

/**
 * Resolve `--bind`. Literal IPs only.
 *
 * Why not hostnames: `listen()` resolves a name through DNS, so the interface actually
 * bound is decided by resolver configuration this process cannot see. An operator who
 * writes `--bind internal.example` would have no way to know whether the service came up
 * on a private interface or a public one.
 */
export function resolveOrcadBindHost(raw?: string): string {
  if (raw === undefined) {
    return ORCAD_LOOPBACK_BIND_HOST
  }
  const value = raw.trim()
  if (value === '') {
    throw new OrcadBindAddressError('--bind expects an address')
  }
  if (value === 'localhost') {
    return ORCAD_LOOPBACK_BIND_HOST
  }
  if (isIP(value) === 0) {
    throw new OrcadBindAddressError(
      `--bind expects a literal IP address (got '${value}'). Hostnames are refused because ` +
        'DNS decides which interface would be bound. Use 127.0.0.1 for loopback, or ' +
        '0.0.0.0 to expose every interface.'
    )
  }
  return value
}
