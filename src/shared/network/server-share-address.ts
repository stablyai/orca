import { parseManualNetworkAddress } from './manual-address'

export type ParseServerShareAddressResult = { ok: true; value: string } | { ok: false }

export function parseServerShareAddress(input: string): ParseServerShareAddressResult {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    return { ok: false }
  }
  const result = parseManualNetworkAddress(trimmed)
  return result.ok ? { ok: true, value: result.address } : { ok: false }
}
