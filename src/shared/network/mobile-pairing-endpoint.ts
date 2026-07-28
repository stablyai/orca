import { parseManualNetworkAddress } from './manual-address'

const ERROR_MESSAGE = 'Enter an IP address, hostname, or ws(s):// endpoint, optionally with a port'
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i
const WEBSOCKET_SCHEME_PREFIX = /^wss?:\/\//i

export type ParseMobilePairingEndpointResult =
  | { ok: true; endpoint: string }
  | { ok: false; error: string }

export function parseMobilePairingEndpoint(input: string): ParseMobilePairingEndpointResult {
  const trimmed = input.trim()
  if (!SCHEME_PREFIX.test(trimmed)) {
    const parsed = parseManualNetworkAddress(trimmed)
    return parsed.ok ? { ok: true, endpoint: parsed.address } : { ok: false, error: ERROR_MESSAGE }
  }

  if (!WEBSOCKET_SCHEME_PREFIX.test(trimmed) || /\s/.test(trimmed)) {
    return { ok: false, error: ERROR_MESSAGE }
  }

  const authorityAndSuffix = trimmed.replace(WEBSOCKET_SCHEME_PREFIX, '')
  const suffixIndex = authorityAndSuffix.search(/[/?#]/)
  const authority =
    suffixIndex === -1 ? authorityAndSuffix : authorityAndSuffix.slice(0, suffixIndex)
  const suffix = suffixIndex === -1 ? '' : authorityAndSuffix.slice(suffixIndex)

  // Why: Mobile host editing persists origin-only endpoints. Keep pairing on
  // the same grammar so a tunnel endpoint remains editable after it is saved.
  if (authority.includes('@') || (suffix !== '' && suffix !== '/')) {
    return { ok: false, error: ERROR_MESSAGE }
  }
  if (!parseManualNetworkAddress(authority).ok) {
    return { ok: false, error: ERROR_MESSAGE }
  }

  try {
    const url = new URL(trimmed)
    if (
      (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== '' ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return { ok: false, error: ERROR_MESSAGE }
    }
  } catch {
    return { ok: false, error: ERROR_MESSAGE }
  }

  return { ok: true, endpoint: suffix === '/' ? trimmed.slice(0, -1) : trimmed }
}
