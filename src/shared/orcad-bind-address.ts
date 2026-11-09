// SSH forwarding needs only loopback; network exposure must be an explicit operator choice.
import { BlockList, isIP } from 'node:net'

export const ORCAD_LOOPBACK_BIND_HOST = '127.0.0.1'
const ALL_INTERFACES_V4 = '0.0.0.0'
const ALL_INTERFACES_V6 = '::'
const ALL_INTERFACES_ADDRESSES = new BlockList()
ALL_INTERFACES_ADDRESSES.addAddress(ALL_INTERFACES_V4, 'ipv4')
ALL_INTERFACES_ADDRESSES.addAddress(ALL_INTERFACES_V6, 'ipv6')

export class OrcadBindAddressError extends Error {
  readonly code = 'orcad_invalid_bind_address'
}

/** Require literal IPs so DNS cannot silently choose a public/private bind interface. */
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
  if (value.includes('%')) {
    throw new OrcadBindAddressError(
      `--bind does not support scoped IPv6 addresses (got '${value}'). Use an unscoped literal IPv6 address.`
    )
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

const LOOPBACK_ADDRESSES = new BlockList()
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6')

/** BlockList canonicalizes literals, so expanded IPv6 and IPv4-mapped spellings of loopback match too. */
export function isLoopbackBindHost(host: string): boolean {
  // orcad validates the raw flag before resolveOrcadBindHost maps 'localhost' to 127.0.0.1.
  const value = host.trim()
  if (value.toLowerCase() === 'localhost') {
    return true
  }
  const family = isIP(value)
  return family !== 0 && LOOPBACK_ADDRESSES.check(value, family === 6 ? 'ipv6' : 'ipv4')
}

export function isAllInterfacesBindHost(host: string): boolean {
  const value = host.trim()
  const family = isIP(value)
  return family !== 0 && ALL_INTERFACES_ADDRESSES.check(value, family === 6 ? 'ipv6' : 'ipv4')
}

export function bindHostIsNetworkExposed(host: string): boolean {
  return isAllInterfacesBindHost(host) || !isLoopbackBindHost(host)
}

export function describeOrcadBindExposure(host: string): string {
  return bindHostIsNetworkExposed(host)
    ? `orcad is bound to ${host} and is reachable from the network. Anything that can reach ` +
        'this port can attempt pairing.'
    : `orcad is bound to ${host} (local only). Reach it from another machine with an SSH ` +
        'local port-forward, or re-launch with --bind to expose it.'
}
