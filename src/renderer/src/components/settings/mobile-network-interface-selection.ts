import { isTailnetIPv4Address } from '../../../../shared/tailnet-address'

export type MobileNetworkInterface = {
  name: string
  address: string
}

export function selectRefreshedNetworkAddress(
  currentAddress: string | undefined,
  interfaces: readonly MobileNetworkInterface[]
): string | undefined {
  if (interfaces.length === 0) {
    return undefined
  }
  if (currentAddress && interfaces.some((iface) => iface.address === currentAddress)) {
    return currentAddress
  }
  return (
    interfaces.find((iface) => isTailnetIPv4Address(iface.address))?.address ??
    interfaces[0]!.address
  )
}

function isNetworkInterfaceAddress(
  address: string | undefined,
  interfaces: readonly MobileNetworkInterface[]
): boolean {
  return Boolean(address && interfaces.some((iface) => iface.address === address))
}

export function selectRefreshedConnectionAddress({
  currentAddress,
  previousInterfaces,
  nextInterfaces
}: {
  currentAddress: string | undefined
  previousInterfaces: readonly MobileNetworkInterface[]
  nextInterfaces: readonly MobileNetworkInterface[]
}): string | undefined {
  const normalizedAddress = currentAddress?.trim()
  // Preserve a user-entered overlay/proxy address even when the OS does not
  // expose it as a network interface.
  if (
    currentAddress &&
    normalizedAddress &&
    !isNetworkInterfaceAddress(normalizedAddress, previousInterfaces) &&
    !isNetworkInterfaceAddress(normalizedAddress, nextInterfaces)
  ) {
    return currentAddress
  }
  return selectRefreshedNetworkAddress(normalizedAddress, nextInterfaces)
}
