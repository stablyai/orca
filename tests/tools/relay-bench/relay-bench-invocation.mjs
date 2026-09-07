// Argument parsing and the guards every script in this directory runs before it opens a socket.
// Why: these benches dial real relay infrastructure with real credentials, so nothing here carries
// a production default. The operator names the target and opts in explicitly, which makes an
// accidental or automated run inert rather than live traffic against production. The destination
// guards below exist because a director the operator names also *supplies* URLs (probe origins,
// resolved cell URLs); without them a compromised or spoofed director could aim this harness at
// the operator's own loopback and private networks.
import { lookup as dnsLookup } from 'node:dns/promises'

export const LIVE_ENV_VAR = 'ORCA_RELAY_BENCH_LIVE'
export const DIRECTOR_ENV_VAR = 'ORCA_RELAY_BENCH_DIRECTOR'

export function parseArgs(argv) {
  const flags = new Set()
  const options = new Map()
  const positional = []
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals === -1) {
      flags.add(arg)
    } else {
      options.set(arg.slice(0, equals), arg.slice(equals + 1))
    }
  }
  return { flags, options, positional }
}

/** @returns {never} */
export function refuse(message) {
  console.error(message)
  process.exit(2)
}

export function requireLiveRun(usage) {
  if (process.env[LIVE_ENV_VAR] !== '1') {
    refuse(`refusing to dial the relay: set ${LIVE_ENV_VAR}=1 to opt in. usage: ${usage}`)
  }
}

// ---------- numeric arguments ----------
// Why: a bare Number() cast accepts 'Infinity' (loops forever, unbounded relay traffic), '' and
// 'abc' (NaN, a silent no-op run that still reports success), and negatives.
export function parseBoundedInteger(value, { min, max }) {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return null
  }
  return parsed
}

export function requireBoundedInteger(value, label, usage, { min, max, fallback }) {
  if (value === undefined || value === null) {
    return fallback
  }
  const parsed = parseBoundedInteger(value, { min, max })
  if (parsed === null) {
    refuse(`${label} must be a whole number ${min}-${max}, got ${value}. usage: ${usage}`)
  }
  return parsed
}

/** Rejects '80@attacker.example', which URL parsing would read as userinfo, not a port. */
export function parsePort(value) {
  return parseBoundedInteger(value, { min: 1, max: 65_535 })
}

export function requirePort(value, label, usage) {
  const parsed = parsePort(value)
  if (parsed === null) {
    refuse(`${label} must be a port 1-65535, got ${value}. usage: ${usage}`)
  }
  return parsed
}

// ---------- destinations ----------
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]

function ipv4ToInt(text) {
  const parts = text.split('.')
  if (parts.length !== 4) {
    return null
  }
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }
    const octet = Number(part)
    if (octet > 255) {
      return null
    }
    value = value * 256 + octet
  }
  return value
}

function isPublicIpv4(value) {
  return !BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0
  })
}

function ipv6ToBytes(host) {
  let text = host.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) {
    text = text.slice(0, zone)
  }
  if (!text.includes(':')) {
    return null
  }
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    // ::ffff:127.0.0.1 and ::127.0.0.1 embed a v4 address in the last two groups.
    const embedded = ipv4ToInt(tail)
    if (embedded === null) {
      return null
    }
    const high = ((embedded >>> 16) & 0xffff).toString(16)
    const low = (embedded & 0xffff).toString(16)
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`
  }
  const halves = text.split('::')
  if (halves.length > 2) {
    return null
  }
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (
    missing < 0 ||
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null
  }
  const zeros = Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0')
  const groups = [...head, ...zeros, ...rest]
  const bytes = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null
    }
    const parsed = Number.parseInt(group, 16)
    bytes.push((parsed >> 8) & 0xff, parsed & 0xff)
  }
  return bytes
}

function isPublicIpv6(bytes) {
  const leadingZeros = bytes.slice(0, 10).every((byte) => byte === 0)
  if (leadingZeros && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(
      ((bytes[12] << 24) >>> 0) + (bytes[13] << 16) + (bytes[14] << 8) + bytes[15]
    )
  }
  if (leadingZeros && bytes[10] === 0 && bytes[11] === 0) {
    // Covers :: and ::1 as well as the deprecated v4-compatible form.
    return false
  }
  if ((bytes[0] & 0xfe) === 0xfc || bytes[0] === 0xff) {
    return false
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return false
  }
  return true
}

/** true/false for an IP literal, null when the hostname is a DNS name. */
export function isPublicIpAddress(host) {
  const v4 = ipv4ToInt(host)
  if (v4 !== null) {
    return isPublicIpv4(v4)
  }
  const v6 = ipv6ToBytes(host)
  if (v6 !== null) {
    return isPublicIpv6(v6)
  }
  return null
}

// WHATWG keeps the brackets on an IPv6 hostname, and a trailing dot is the same name.
function normalizeHostname(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

/**
 * Literal-address vetting for a URL this harness is about to fetch. Returns the normalized origin
 * or the reason it is refused. A DNS name still needs resolvesToPublicAddress().
 */
export function classifyPublicHttpsOrigin(value) {
  if (typeof value !== 'string' || !value) {
    return { ok: false, reason: 'missing origin' }
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: `not a URL: ${value}` }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `must be an https origin: ${value}` }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: `must not carry credentials: ${value}` }
  }
  const host = normalizeHostname(parsed.hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: `refusing a loopback destination: ${value}` }
  }
  if (isPublicIpAddress(host) === false) {
    return {
      ok: false,
      reason: `refusing a loopback, link-local, or private destination: ${value}`
    }
  }
  return { ok: true, origin: parsed.origin }
}

/**
 * Second layer for DNS names: a director could hand back a public-looking name that resolves into
 * the operator's network. fetch() resolves again, so this narrows the window rather than closing
 * it; the literal check above is what makes the obvious cases impossible.
 */
export async function resolvesToPublicAddress(origin, { lookup = dnsLookup } = {}) {
  const host = normalizeHostname(new URL(origin).hostname)
  if (isPublicIpAddress(host) !== null) {
    return { ok: true }
  }
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch (err) {
    return { ok: false, reason: `cannot resolve ${host}: ${err.message}` }
  }
  if (!addresses.length) {
    return { ok: false, reason: `cannot resolve ${host}` }
  }
  const blocked = addresses.find((entry) => isPublicIpAddress(entry.address) === false)
  if (blocked) {
    return { ok: false, reason: `${host} resolves to a private address ${blocked.address}` }
  }
  return { ok: true }
}

export function requireOrigin(value, label, usage) {
  if (!value) {
    refuse(`missing ${label}. usage: ${usage}`)
  }
  // https only: these origins carry bench credentials, and http would let an on-path observer
  // read or rewrite them.
  const verdict = classifyPublicHttpsOrigin(value)
  if (!verdict.ok) {
    refuse(`${label} ${verdict.reason}. usage: ${usage}`)
  }
  return verdict.origin
}

export function requireDirector(options, usage) {
  return requireOrigin(
    options.get('--director') ?? process.env[DIRECTOR_ENV_VAR],
    `director origin (--director=<origin> or ${DIRECTOR_ENV_VAR})`,
    usage
  )
}
