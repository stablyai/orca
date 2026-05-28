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
  return interfaces[0]!.address
}
