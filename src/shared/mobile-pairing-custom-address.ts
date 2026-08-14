import { parseManualNetworkAddress } from './network/manual-address'

export const MAX_MOBILE_PAIRING_CUSTOM_ADDRESSES = 50

export function normalizeMobilePairingCustomAddress(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = parseManualNetworkAddress(value)
  return parsed.ok ? parsed.address : null
}

export function normalizeMobilePairingCustomAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const normalized: string[] = []
  for (const candidate of value) {
    const address = normalizeMobilePairingCustomAddress(candidate)
    if (address && !normalized.includes(address)) {
      normalized.push(address)
    }
    if (normalized.length === MAX_MOBILE_PAIRING_CUSTOM_ADDRESSES) {
      break
    }
  }
  return normalized
}

export function addMobilePairingCustomAddress(
  addresses: readonly string[],
  value: string
): string[] {
  const address = normalizeMobilePairingCustomAddress(value)
  if (!address) {
    return normalizeMobilePairingCustomAddresses(addresses)
  }
  const normalized = normalizeMobilePairingCustomAddresses(addresses)
  if (normalized.includes(address)) {
    return normalized
  }
  return [...normalized, address].slice(-MAX_MOBILE_PAIRING_CUSTOM_ADDRESSES)
}

export function removeMobilePairingCustomAddress(
  addresses: readonly string[],
  value: string
): string[] {
  const address = normalizeMobilePairingCustomAddress(value)
  return normalizeMobilePairingCustomAddresses(addresses).filter(
    (candidate) => candidate !== address
  )
}
