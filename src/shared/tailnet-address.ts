export function isTailnetIPv4Address(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) {
    return false
  }

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN
    }
    return Number(part)
  })

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }

  // Why: Tailnet IPv4 addresses live in 100.64.0.0/10. Prefer them for
  // phone pairing because LAN addresses stop working once devices split networks.
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}
