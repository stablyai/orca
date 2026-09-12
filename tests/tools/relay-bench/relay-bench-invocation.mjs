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

// ---------- untrusted text ----------
// Anything a peer, the desktop, or a stored file chose and that lands in the operator's terminal
// goes through here: printable ASCII only, bounded, everything else named by count. Bidi and
// C1 controls are outside the allow-list, so a hostile reason cannot repaint the screen.
const UNTRUSTED_TEXT = /^[\x20-\x7e]{1,120}$/
export function describeUntrustedText(value) {
  if (typeof value !== 'string') {
    return value === undefined ? 'unknown' : `non-string (${typeof value})`
  }
  if (!value) {
    return 'empty'
  }
  if (UNTRUSTED_TEXT.test(value)) {
    return value
  }
  return `unprintable (${value.length} chars)`
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

function v4At(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  )
}

function isPublicIpv6(bytes) {
  const leadingZeros = bytes.slice(0, 10).every((byte) => byte === 0)
  if (leadingZeros && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(v4At(bytes, 12))
  }
  if (leadingZeros && bytes[10] === 0 && bytes[11] === 0) {
    // Covers :: and ::1 as well as the deprecated v4-compatible form.
    return false
  }
  // Transition prefixes that reach an embedded v4 address: judge that address.
  // NAT64 64:ff9b::/96 puts the v4 in the last 32 bits; 6to4 2002::/16 in bits 16-47.
  // 64:ff9b:1::/48 (NAT64 local) embeds it at a position set by the deployment's prefix
  // length, which this harness cannot know, so it is refused. Teredo 2001:0::/32 embeds the
  // client v4 inverted, so it is refused too.
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
  if (nat64 && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return isPublicIpv4(v4At(bytes, 12))
  }
  if (nat64 && bytes[4] === 0 && bytes[5] === 1) {
    return false
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPublicIpv4(v4At(bytes, 2))
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
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
    return { ok: false, reason: `not a URL: ${describeUntrustedText(value)}` }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `must be an https origin: ${describeUntrustedText(value)}` }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: `must not carry credentials: ${describeUntrustedText(value)}` }
  }
  const host = normalizeHostname(parsed.hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: `refusing a loopback destination: ${describeUntrustedText(value)}` }
  }
  if (isPublicIpAddress(host) === false) {
    return {
      ok: false,
      reason: `refusing a loopback, link-local, or private destination: ${describeUntrustedText(value)}`
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
    return {
      ok: false,
      reason: `cannot resolve ${describeUntrustedText(host)}: ${err.code ?? 'lookup failed'}`
    }
  }
  if (!addresses.length) {
    return { ok: false, reason: `cannot resolve ${describeUntrustedText(host)}` }
  }
  const blocked = addresses.find((entry) => isPublicIpAddress(entry.address) === false)
  if (blocked) {
    return {
      ok: false,
      reason: `${describeUntrustedText(host)} resolves to a private address ${describeUntrustedText(blocked.address)}`
    }
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
