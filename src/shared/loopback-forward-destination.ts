// Why a purpose-built check rather than reusing classifyRemotePairingHostname: that
// helper answers a display question and accepts anything starting with `127.`, which
// as a string test also admits `127.evil.example.com`. This one gates which sockets a
// paired client may reach on the host, so it is a strict allowlist of literal loopback
// forms and fails closed on anything it does not recognise.

const IPV4_MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/
const IPV6_LOOPBACK = new Set(['::1', '0:0:0:0:0:0:0:1'])
// Why leading zeros are refused rather than read as decimal: getaddrinfo reads `010` as
// octal 8 and refuses `08` outright, then falls back to resolving the whole string as a
// name. Either way the socket would reach an address this check never agreed to.
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/

function loopbackIPv4(value: string): string | null {
  const parts = value.split('.')
  if (parts.length !== 4) {
    return null
  }
  for (const part of parts) {
    if (!IPV4_OCTET.test(part) || Number(part) > 255) {
      return null
    }
  }
  // Why the whole /8: dev servers and OAuth callbacks bind across 127.0.0.0/8,
  // not only 127.0.0.1.
  return parts[0] === '127' ? parts.join('.') : null
}

/**
 * The literal to dial for a requested destination, or null when it is not loopback.
 *
 * Always an IP literal, never a name, and never the caller's own string: `net.connect`
 * skips the resolver for a literal, so what this admits is exactly what the socket
 * reaches. Handing the raw string to `getaddrinfo` instead would put inputs like
 * `127.0.0.08` or `[127.0.0.1]` — which it treats as hostnames — in front of a resolver
 * that a search domain or wildcard record can answer off-host.
 *
 * `0.0.0.0` is deliberately rejected: as a connect target its meaning is
 * platform-dependent, and a wildcard-bound listener is reachable directly and so
 * never needs a forward. Subdomains of `localhost` are rejected too — RFC 6761
 * points them at loopback but resolver behaviour varies, and a wrong answer here
 * opens a hole rather than merely failing.
 */
export function resolveLoopbackForwardHost(host: string): string | null {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (normalized === 'localhost') {
    // Pinned to a literal because the name itself is whatever /etc/hosts says it is.
    return '127.0.0.1'
  }
  if (IPV6_LOOPBACK.has(normalized)) {
    return '::1'
  }
  const mapped = IPV4_MAPPED_PREFIX.exec(normalized)
  if (mapped) {
    const ipv4 = loopbackIPv4(mapped[1])
    return ipv4 ? `::ffff:${ipv4}` : null
  }
  return loopbackIPv4(normalized)
}

export function isForwardablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}
