// Why: link-local addresses (IPv4 169.254.0.0/16 from APIPA or idle virtual adapters, IPv6
// fe80::/10) only reach the same link and need a scope id a URL cannot carry, so a phone can
// never dial one as a direct endpoint. Shared by the desktop advertiser and the phone dialer.
export function isLinkLocalAddress(address: string): boolean {
  const host = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  const mapped = host.match(/^::ffff:(.+)$/)
  if (mapped) {
    return isLinkLocalAddress(mappedIPv4(mapped[1]!))
  }
  if (host.includes(':')) {
    const firstHextet = Number.parseInt(host.split(':')[0] ?? '', 16)
    return Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfe80
  }
  const octets = host.split('.')
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    octets[0] === '169' &&
    octets[1] === '254'
  )
}

/** False for hostnames and unparseable endpoints: only a link-local IP literal is undialable. */
export function isLinkLocalEndpoint(endpoint: string): boolean {
  try {
    return isLinkLocalAddress(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

// WHATWG URLs serialize ::ffff:169.254.1.2 as ::ffff:a9fe:102.
function mappedIPv4(tail: string): string {
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) {
    return tail
  }
  const high = Number.parseInt(hex[1]!, 16)
  const low = Number.parseInt(hex[2]!, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}
