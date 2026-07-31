import { isTailnetIPv4Address } from '../../../../shared/tailnet-address'
import { MAX_PAIRING_ENDPOINTS } from '../../../../shared/pairing'

export type MobileNetworkInterface = {
  name: string
  address: string
}

/** Cap for Mobile setup advertise lists — mirrors pairing QR density limit (KTD6). */
export const MAX_MOBILE_ADVERTISE_ADDRESSES = MAX_PAIRING_ENDPOINTS

export function selectRefreshedNetworkAddress(
  currentAddress: string | undefined,
  interfaces: readonly MobileNetworkInterface[],
  // Why: callers that explicitly know the user picked a manual address
  // (not an OS-enumerated one) pass this so the refresh path keeps their
  // selection instead of snapping back to a tailnet/LAN fallback.
  currentAddressIsManual: boolean = false
): string | undefined {
  // Why: an empty refresh result usually means discovery is transiently
  // unavailable, not that the user wants to drop their selection. Keep the
  // manual address so a recovering discovery doesn't clobber it.
  if (interfaces.length === 0) {
    return currentAddressIsManual ? currentAddress : undefined
  }
  if (
    currentAddress &&
    (currentAddressIsManual || interfaces.some((iface) => iface.address === currentAddress))
  ) {
    return currentAddress
  }
  return (
    interfaces.find((iface) => isTailnetIPv4Address(iface.address))?.address ??
    interfaces[0]!.address
  )
}

/** Dedupe (first wins) and cap at KTD6. */
export function capOrderedAdvertiseAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const address of addresses) {
    const trimmed = address.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    ordered.push(trimmed)
    if (ordered.length >= MAX_MOBILE_ADVERTISE_ADDRESSES) {
      break
    }
  }
  return ordered
}

/**
 * Default seed when empty: Tailscale IPv4 if present, then first non-tailnet.
 * Does not dump every discovered iface into the list (KTD5).
 */
export function seedOrderedAdvertiseAddresses(
  interfaces: readonly MobileNetworkInterface[]
): string[] {
  if (interfaces.length === 0) {
    return []
  }
  const tailnet = interfaces.find((iface) => isTailnetIPv4Address(iface.address))
  const nonTailnet = interfaces.find((iface) => !isTailnetIPv4Address(iface.address))
  const seeded: string[] = []
  if (tailnet) {
    seeded.push(tailnet.address)
  }
  if (nonTailnet && nonTailnet.address !== seeded[0]) {
    seeded.push(nonTailnet.address)
  }
  if (seeded.length === 0) {
    seeded.push(interfaces[0]!.address)
  }
  return capOrderedAdvertiseAddresses(seeded)
}

/**
 * Refresh an ordered advertise list (KTD5):
 * - drop vanished discovered addresses
 * - keep addresses that were never in the previous discovery set (customs)
 * - do not auto-append newly discovered interfaces into the user's order
 * - seed when the working list is empty
 */
export function refreshOrderedAdvertiseAddresses(
  current: readonly string[],
  nextInterfaces: readonly MobileNetworkInterface[],
  previousInterfaces: readonly MobileNetworkInterface[] = [],
  options: { customAddresses?: ReadonlySet<string> } = {}
): string[] {
  const nextDiscovered = new Set(nextInterfaces.map((iface) => iface.address))
  const previousDiscovered = new Set(previousInterfaces.map((iface) => iface.address))
  const customAddresses = options.customAddresses

  if (current.length === 0) {
    return seedOrderedAdvertiseAddresses(nextInterfaces)
  }

  const kept = current.filter((address) => {
    if (nextDiscovered.has(address)) {
      return true
    }
    if (customAddresses) {
      // Why: the persisted custom set is authoritative on first refresh, when
      // there is no prior discovery snapshot to identify stale OS addresses.
      return customAddresses.has(address)
    }
    // Not in previous discovery → treated as custom (typed / persisted manual).
    if (!previousDiscovered.has(address)) {
      return true
    }
    // Was discovered before and vanished → drop.
    return false
  })

  if (kept.length === 0) {
    return seedOrderedAdvertiseAddresses(nextInterfaces)
  }
  return capOrderedAdvertiseAddresses(kept)
}

/** Preserve Relay's relative position among direct routes that survive refresh. */
export function reconcileRelayPreferenceIndex(
  currentAddresses: readonly string[],
  nextAddresses: readonly string[],
  currentRelayIndex: number
): number {
  const survivors = new Set(nextAddresses)
  return currentAddresses
    .slice(0, Math.max(0, currentRelayIndex))
    .filter((address) => survivors.has(address)).length
}

export function reorderAdvertiseRoutes(
  addresses: readonly string[],
  relayPreferenceIndex: number | undefined,
  fromIndex: number,
  toIndex: number
): { addresses: string[]; relayPreferenceIndex?: number } {
  const routes: ({ address: string } | { relay: true })[] = addresses.map((address) => ({
    address
  }))
  if (relayPreferenceIndex !== undefined) {
    routes.splice(Math.max(0, Math.min(addresses.length, relayPreferenceIndex)), 0, { relay: true })
  }
  if (
    fromIndex !== toIndex &&
    fromIndex >= 0 &&
    toIndex >= 0 &&
    fromIndex < routes.length &&
    toIndex < routes.length
  ) {
    const [moved] = routes.splice(fromIndex, 1)
    routes.splice(toIndex, 0, moved!)
  }
  const nextAddresses = routes.flatMap((route) => ('address' in route ? [route.address] : []))
  const nextRelayIndex = routes.findIndex((route) => 'relay' in route)
  return {
    addresses: nextAddresses,
    ...(nextRelayIndex >= 0 ? { relayPreferenceIndex: nextRelayIndex } : {})
  }
}

export function orderedAdvertiseAddressesEqual(
  a: readonly string[],
  b: readonly string[]
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Add address at end when under cap; no-op if already present or at cap. */
export function addAdvertiseAddress(current: readonly string[], address: string): string[] {
  const trimmed = address.trim()
  if (!trimmed || current.includes(trimmed)) {
    return [...current]
  }
  if (current.length >= MAX_MOBILE_ADVERTISE_ADDRESSES) {
    return [...current]
  }
  return [...current, trimmed]
}

/** Remove address; refuses to clear below one entry when list is non-empty. */
export function removeAdvertiseAddress(current: readonly string[], address: string): string[] {
  if (current.length <= 1) {
    return [...current]
  }
  return current.filter((value) => value !== address)
}

export function moveAdvertiseAddress(
  current: readonly string[],
  index: number,
  direction: -1 | 1
): string[] {
  return reorderAdvertiseAddresses(current, index, index + direction)
}

/** Reorder by moving `fromIndex` to `toIndex` (used by drag-and-drop). */
export function reorderAdvertiseAddresses(
  current: readonly string[],
  fromIndex: number,
  toIndex: number
): string[] {
  const next = [...current]
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= next.length ||
    toIndex >= next.length
  ) {
    return next
  }
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item!)
  return next
}
