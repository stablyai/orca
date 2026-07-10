import { isTailnetIPv4Address } from '../../../../shared/tailnet-address'

export type MobileNetworkInterface = {
  name: string
  address: string
}

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
