import { PAIRING_ENDPOINT_MAX_CHARACTERS } from '../mobile-pairing-protocol-limits'
import { isPairingWildcardHostname, normalizePairingUrl } from './pairing-url'

// Why: pairing entry points must accept the same endpoint forms as the main process.
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
const IPV4 = `(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}`
const IPV4_REGEX = new RegExp(`^${IPV4}$`)

// RFC 1123 hostname label: letters/digits/hyphens, 1-63 chars, may not
// start or end with a hyphen. This covers plain LAN hostnames, DDNS domains
// (e.g. `home.example.com`), and Tailscale MagicDNS names (`*.ts.net`) as a
// special case of the same grammar — no separate MagicDNS-only pattern needed.
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME = `(?:${HOSTNAME_LABEL}\\.)*${HOSTNAME_LABEL}`
const HOSTNAME_REGEX = new RegExp(`^${HOSTNAME}$`, 'i')

const HOSTNAME_MAX_LENGTH = 253
const MIN_PORT = 1
const MAX_PORT = 65535
const ERROR_MESSAGE = 'Enter an IPv4/IPv6 address, hostname, or HTTP(S)/WebSocket URL'

export type ParseManualAddressResult = { ok: true; address: string } | { ok: false; error: string }

export function parseManualNetworkAddress(input: string): ParseManualAddressResult {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > PAIRING_ENDPOINT_MAX_CHARACTERS) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (trimmed.includes('://')) {
    return normalizePairingUrl(trimmed)
      ? { ok: true, address: trimmed }
      : { ok: false, error: ERROR_MESSAGE }
  }

  if (isValidIpv6Override(trimmed)) {
    return { ok: true, address: trimmed }
  }

  const { host, port } = splitHostPort(trimmed)
  if (host === '' || host.length > HOSTNAME_MAX_LENGTH) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (port !== null && !isValidPort(port)) {
    return { ok: false, error: ERROR_MESSAGE }
  }

  if (IPV4_REGEX.test(host) && host !== '0.0.0.0') {
    return { ok: true, address: trimmed }
  }
  // Why: reject a host whose last label is numeric — a bare `123`, a dotted
  // `256.0.0.1`, or a hostname with a numeric final label (`foo.123`, `foo.0x1`).
  // The WHATWG URL host parser that `resolvePairingEndpoint` feeds this into
  // treats "ends in a number" as an IPv4 signal and tries to parse the whole
  // host as IPv4. A real IPv4 was already accepted above, so anything reaching
  // here would fail that parse and the main process would silently dial a
  // different host — so treat these as mistyped IPs, not hostnames.
  const lastLabel = host.split('.').at(-1) ?? ''
  if (/^[0-9]+$/.test(lastLabel) || /^0x[0-9a-f]*$/i.test(lastLabel)) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (HOSTNAME_REGEX.test(host)) {
    return { ok: true, address: trimmed }
  }

  return { ok: false, error: ERROR_MESSAGE }
}

// Why: only a single colon can separate a hostname and port; IPv6 is parsed first.
function splitHostPort(value: string): { host: string; port: string | null } {
  const firstColon = value.indexOf(':')
  if (firstColon === -1 || value.includes(':', firstColon + 1)) {
    return { host: value, port: null }
  }
  return { host: value.slice(0, firstColon), port: value.slice(firstColon + 1) }
}

function isValidPort(port: string): boolean {
  // Reject leading zeros: a canonical port has none, and allowing them lets an
  // arbitrarily long zero-padded string (`00…08080`) slip past the range check
  // and inflate the returned address past the hostname length cap.
  if (!/^[1-9][0-9]*$/.test(port)) {
    return false
  }
  const value = Number(port)
  return value >= MIN_PORT && value <= MAX_PORT
}

function isValidIpv6Override(value: string): boolean {
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/)
  const hostname = bracketed?.[1] ?? value
  const port = bracketed?.[2]
  if ((!bracketed && !value.includes(':')) || hostname === '::' || (port && !isValidPort(port))) {
    return false
  }
  try {
    const url = new URL(`ws://[${hostname}]`)
    return url.hostname.includes(':') && !isPairingWildcardHostname(url.hostname)
  } catch {
    return false
  }
}
