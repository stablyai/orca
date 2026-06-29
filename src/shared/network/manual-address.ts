// Why: pure shared helper so the same validation runs in renderer
// today and in any future CLI/main-process caller without duplicating
// the IPv4 + Tailscale MagicDNS grammar.
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
const IPV4 = `(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}`
// MagicDNS hostname: lowercase letters/digits/hyphens, dot-separated, ending in .ts.net.
// Labels may not start or end with a hyphen; max 63 chars per label (DNS limit).
const MAGICDNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const MAGICDNS = `(?:${MAGICDNS_LABEL}\\.)+ts\\.net`

const HOSTNAME_MAX_LENGTH = 253
const ERROR_MESSAGE = 'Enter an IPv4 address or Tailscale MagicDNS hostname'

export type ParseManualAddressResult = { ok: true; address: string } | { ok: false; error: string }

export function parseManualNetworkAddress(input: string): ParseManualAddressResult {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > HOSTNAME_MAX_LENGTH) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: ERROR_MESSAGE }
  }

  const ipv4Regex = new RegExp(`^${IPV4}$`)
  if (ipv4Regex.test(trimmed)) {
    return { ok: true, address: trimmed }
  }

  const magicRegex = new RegExp(`^(?:${MAGICDNS})$`, 'i')
  if (magicRegex.test(trimmed)) {
    return { ok: true, address: trimmed }
  }

  return { ok: false, error: ERROR_MESSAGE }
}
