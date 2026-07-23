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
  relayPreferenceIndex: number
}

export type MobileAdvertiseAddressState = {
  addresses: string[]
  customAddresses: Set<string>
  relayPreferenceIndex: number
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
        customAddresses: [],
        relayPreferenceIndex: parsed.length
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
      const relayPreferenceIndex = Math.max(
        0,
        Math.min(
          addresses.length,
          Number.isInteger(record.relayPreferenceIndex)
            ? record.relayPreferenceIndex
            : addresses.length
        )
      )
      return { addresses, customAddresses, relayPreferenceIndex }
    }
    return null
  } catch {
    return null
  }
}

export function loadMobileAdvertiseAddressState(): MobileAdvertiseAddressState {
  const stored = loadMobileAdvertiseAddressOrder()
  if (!stored) {
    return { addresses: [], customAddresses: new Set(), relayPreferenceIndex: 0 }
  }
  return {
    addresses: stored.addresses,
    customAddresses: new Set(stored.customAddresses),
    relayPreferenceIndex: stored.relayPreferenceIndex
  }
}

export function saveMobileAdvertiseAddressOrder(
  addresses: readonly string[],
  customAddresses: ReadonlySet<string> | readonly string[] = [],
  relayPreferenceIndex: number = addresses.length
): void {
  const capped = capOrderedAdvertiseAddresses(addresses)
  const customSet = customAddresses instanceof Set ? customAddresses : new Set(customAddresses)
  const stored: MobileAdvertiseAddressOrderStore = {
    addresses: capped,
    customAddresses: capped.filter((address) => customSet.has(address)),
    relayPreferenceIndex: Math.max(0, Math.min(capped.length, relayPreferenceIndex))
  }
  try {
    window.localStorage.setItem(MOBILE_ADVERTISE_ADDRESSES_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Persistence is optional; the current pairing flow still honors the route order.
  }
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
