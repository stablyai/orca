// Why: pure shared helper so the same validation runs in renderer
// today and in any future CLI/main-process caller without duplicating
// the IPv4 + hostname + optional-port grammar.
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
const ERROR_MESSAGE = 'Enter an IPv4 address or hostname, optionally with a :port suffix'

export type ParseManualAddressResult = { ok: true; address: string } | { ok: false; error: string }

export function parseManualNetworkAddress(input: string): ParseManualAddressResult {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: ERROR_MESSAGE }
  }

  const { host, port } = splitHostPort(trimmed)
  if (host === '' || host.length > HOSTNAME_MAX_LENGTH) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (port !== null && !isValidPort(port)) {
    return { ok: false, error: ERROR_MESSAGE }
  }

  if (IPV4_REGEX.test(host)) {
    return { ok: true, address: trimmed }
  }
  // Why: reject any all-numeric host (bare `123` or dotted `256.0.0.1`) as a
  // mistyped IP rather than a hostname. Although bare numeric labels are
  // technically legal per RFC 1123, they are ambiguous with an IPv4 address:
  // the WHATWG URL host parser that `resolvePairingEndpoint` feeds this into
  // reinterprets a numeric host as IPv4 (`123` becomes `0.0.0.123`), so
  // accepting one here would let the UI "validate" an address that the main
  // process then silently dials as a different host.
  if (/^[0-9]+(?:\.[0-9]+)*$/.test(host)) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (HOSTNAME_REGEX.test(host)) {
    return { ok: true, address: trimmed }
  }

  return { ok: false, error: ERROR_MESSAGE }
}

// Why: mirrors `parsePairingAddressOverride` in src/main/runtime/runtime-rpc.ts
// so the UI only accepts what the main process's pairing endpoint resolution
// can already handle. IPv6 stays out of scope (same as that function), so a
// second colon is left in `host` and fails the grammar checks below instead
// of being misparsed as a port.
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
