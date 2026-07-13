import {
  capOrderedAdvertiseAddresses,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'

// Why: regenerating the pairing QR should keep the user's advertise priority
// across sessions (KTD5), not only for the current Mobile page visit.
export const MOBILE_ADVERTISE_ADDRESSES_STORAGE_KEY = 'orca:mobile-advertise-addresses'

export type MobileAdvertiseAddressOrderStore = {
  addresses: string[]
  customAddresses: string[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function loadMobileAdvertiseAddressOrder(): MobileAdvertiseAddressOrderStore | null {
  try {
    const raw = window.localStorage.getItem(MOBILE_ADVERTISE_ADDRESSES_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (isStringArray(parsed)) {
      // Legacy shape: plain string[] — treat none as custom until refresh.
      return {
        addresses: capOrderedAdvertiseAddresses(parsed),
        customAddresses: []
      }
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      isStringArray((parsed as MobileAdvertiseAddressOrderStore).addresses)
    ) {
      const record = parsed as MobileAdvertiseAddressOrderStore
      const addresses = capOrderedAdvertiseAddresses(record.addresses)
      const customAddresses = isStringArray(record.customAddresses)
        ? record.customAddresses.filter((address) => addresses.includes(address))
        : []
      return { addresses, customAddresses }
    }
    return null
  } catch {
    return null
  }
}

export function saveMobileAdvertiseAddressOrder(
  addresses: readonly string[],
  customAddresses: ReadonlySet<string> | readonly string[] = []
): void {
  const capped = capOrderedAdvertiseAddresses(addresses)
  const customSet = customAddresses instanceof Set ? customAddresses : new Set(customAddresses)
  const stored: MobileAdvertiseAddressOrderStore = {
    addresses: capped,
    customAddresses: capped.filter((address) => customSet.has(address))
  }
  window.localStorage.setItem(MOBILE_ADVERTISE_ADDRESSES_STORAGE_KEY, JSON.stringify(stored))
}

/** Derive which selected addresses are customs given the current discovery set. */
export function deriveCustomAdvertiseAddresses(
  selectedAddresses: readonly string[],
  networkInterfaces: readonly MobileNetworkInterface[],
  knownCustoms: ReadonlySet<string> = new Set()
): Set<string> {
  const discovered = new Set(networkInterfaces.map((iface) => iface.address))
  return new Set(
    selectedAddresses.filter((address) => knownCustoms.has(address) || !discovered.has(address))
  )
}
