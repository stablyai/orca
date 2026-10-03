// Why: kept free of pairing-code parsing (zod, Buffer) so the dependency-free
// remote-runtime hint, which mobile and the web client import, can reuse it.
import { isTailnetIPv4Address } from './tailnet-address'

export type RemotePairingEndpointKind = 'loopback' | 'tailscale' | 'lan' | 'public' | 'custom'

const LOOPBACK_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'localhost6',
  'localhost6.localdomain6',
  'ip6-localhost',
  'ip6-loopback',
  '127.0.0.1',
  '::1'
])

function isPrivateIPv4Address(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

function isPrivateIPv6Address(hostname: string): boolean {
  // Why: a hextet only means anything inside an IPv6 literal. Without the shape gate a
  // four-hex-character *hostname* such as `fdab` reads as a ULA and is reported as a LAN
  // address, which is how a plain host ended up being told its address is local-only.
  const [firstLabel, ...rest] = hostname.split(':')
  if (rest.length === 0 || !/^[0-9a-f]{1,4}$/i.test(firstLabel ?? '')) {
    return false
  }
  const firstHextet = Number.parseInt(firstLabel ?? '', 16)
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80
}

export function getEmbeddedIPv4Address(hostname: string): string | null {
  const match = hostname.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (!match) {
    return null
  }
  const high = Number.parseInt(match[1]!, 16)
  const low = Number.parseInt(match[2]!, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

export function classifyRemotePairingHostname(hostname: string): RemotePairingEndpointKind {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  const embeddedIPv4 = getEmbeddedIPv4Address(normalized)
  if (embeddedIPv4) {
    return classifyRemotePairingHostname(embeddedIPv4)
  }
  if (
    LOOPBACK_HOSTS.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.startsWith('127.')
  ) {
    return 'loopback'
  }
  if (isTailnetIPv4Address(normalized)) {
    return 'tailscale'
  }
  if (isPrivateIPv4Address(normalized) || isPrivateIPv6Address(normalized)) {
    return 'lan'
  }
  return normalized.includes('.') || normalized.includes(':') ? 'public' : 'custom'
}

/**
 * A hostname or IP literal, optionally with a port. Deliberately excludes `_` and anything
 * else WHATWG URL tolerates in a host: consumers still substring-match error messages for
 * tokens such as `terminal_gone`, so an endpoint carrying one would turn loss of contact into
 * a terminal-gone verdict — the one conclusion `ssh-execution-boundary.md` forbids.
 */
const DISPLAYABLE_ENDPOINT_HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i

/**
 * Why: the endpoint comes from a pasted pairing code, which is only length-capped and can
 * carry userinfo. Show scheme and host and nothing else, and only when the host cannot smuggle
 * a token another consumer reads as a verdict. `null` means "nothing safe to show" so callers
 * that can omit the address entirely do, instead of printing a placeholder that says nothing.
 */
export function displayableEndpoint(endpoint: string): string | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (!DISPLAYABLE_ENDPOINT_HOST_RE.test(url.host)) {
    return null
  }
  // Why: WHATWG URL recompresses `[::ffff:100.64.0.5]` to `[::ffff:6440:5]`, which no user
  // recognises as the address they pasted. Render the dotted quad the classifier already reads.
  const embeddedIPv4 = getEmbeddedIPv4Address(url.hostname.replace(/^\[|\]$/g, ''))
  if (embeddedIPv4) {
    return `${url.protocol}//${embeddedIPv4}${url.port ? `:${url.port}` : ''}`
  }
  return `${url.protocol}//${url.host}`
}

/** The same sanitizer for callers whose sentence needs a noun where the address would go. */
export function endpointForDisplay(endpoint: string): string {
  return displayableEndpoint(endpoint) ?? 'the paired endpoint'
}
