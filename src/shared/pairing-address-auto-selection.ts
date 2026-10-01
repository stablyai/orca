import { isTailnetIPv4Address } from './tailnet-address'

export type PairingNetworkInterface = {
  name: string
  address: string
  hasDefaultRoute?: boolean
}

// Why: known bridge labels are host-local, while vEthernet needs positive route evidence because
// External Switch management adapters are reachable; subnets overlap real corporate LANs.
// `bridge` still matches Linux bridge names. Apple's Thunderbolt Bridge is exactly `bridge` plus
// digits (`bridge0`) on macOS, so only that platform is excluded before this pattern runs.
const VIRTUAL_BRIDGE_INTERFACE_PATTERN =
  /^(?:docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|VMware Network Adapter|VirtualBox Host-Only/i
const THUNDERBOLT_BRIDGE_INTERFACE_PATTERN = /^bridge\d+$/i
const HYPER_V_INTERFACE_PATTERN = /^vEthernet /i
const HOST_LOCAL_HYPER_V_INTERFACE_PATTERN =
  /^vEthernet \((?:Default Switch|WSL(?: \(Hyper-V firewall\))?)\)$/i

export function isThunderboltBridgeInterface(
  name: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'darwin' && THUNDERBOLT_BRIDGE_INTERFACE_PATTERN.test(name)
}

export function isVirtualBridgeInterface(
  name: string,
  hasDefaultRoute?: boolean,
  platform: NodeJS.Platform = process.platform
): boolean {
  // Why: macOS names the Thunderbolt cable `bridge0`. That is a real link between two Macs,
  // not a container bridge. Linux `bridge0` stays a virtual bridge. `br-`, `docker0`, and a
  // bare `bridge` stay excluded on every platform.
  if (isThunderboltBridgeInterface(name, platform)) {
    return false
  }
  if (HOST_LOCAL_HYPER_V_INTERFACE_PATTERN.test(name)) {
    return true
  }
  if (HYPER_V_INTERFACE_PATTERN.test(name)) {
    return hasDefaultRoute !== true
  }
  return VIRTUAL_BRIDGE_INTERFACE_PATTERN.test(name)
}

// Share QR and picker selection to avoid advertising a different address. Bridges remain manually selectable.
// Undefined omits direct addressing: Relay carries its own invite, while LAN-only pairing refuses.
export function selectAutoAdvertisedPairingAddress(
  interfaces: readonly PairingNetworkInterface[],
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const advertisable = interfaces.filter(
    (iface) => !isVirtualBridgeInterface(iface.name, iface.hasDefaultRoute, platform)
  )
  const tailnet = advertisable.find((iface) => isTailnetIPv4Address(iface.address))
  if (tailnet) {
    return tailnet.address
  }
  // Why: a phone on Wi-Fi cannot reach Thunderbolt Bridge. Auto-advertise uses `bridgeN`
  // only when it is the only direct address, so Ethernet/Wi-Fi still wins when both are up.
  const direct = advertisable.find((iface) => !isThunderboltBridgeInterface(iface.name, platform))
  return direct?.address ?? advertisable[0]?.address
}
