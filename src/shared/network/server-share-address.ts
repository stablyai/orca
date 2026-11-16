import { parseManualNetworkAddress } from './manual-address'
import { normalizePairingUrl } from './pairing-url'

export type ParseServerShareAddressResult = { ok: true; value: string } | { ok: false }

export function parseServerShareAddress(input: string): ParseServerShareAddressResult {
  const trimmed = input.trim()
  if (/^http:\/\//i.test(trimmed)) {
    return { ok: false }
  }
  const result = parseManualNetworkAddress(trimmed)
  if (!result.ok) {
    return { ok: false }
  }
  const value = /^https:\/\//i.test(result.address)
    ? normalizePairingUrl(result.address)
    : result.address
  return value ? { ok: true, value } : { ok: false }
}
