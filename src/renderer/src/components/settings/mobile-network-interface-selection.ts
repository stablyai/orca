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
    if (customAddresses?.has(address)) {
      return true
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
  const next = [...current]
  const target = index + direction
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
    return next
  }
  const tmp = next[index]!
  next[index] = next[target]!
  next[target] = tmp
  return next
}
