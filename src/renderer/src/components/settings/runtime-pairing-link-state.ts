import { normalizeMobilePairingCustomAddress } from '../../../../shared/mobile-pairing-custom-address'
import { selectAutoAdvertisedPairingAddress } from '../../../../shared/pairing-address-auto-selection'
import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'

export const RUNTIME_PAIRING_LOOPBACK_ADDRESS = '127.0.0.1'

export type RuntimePairingIntent = 'another' | 'local' | 'custom'

// Why: only "This computer only" declines off-host reach. Custom is the SSH-tunnel/reverse-proxy field, so
// even a loopback-looking custom address (`127.0.0.1:8443`) needs the listener open behind the tunnel.
export function runtimePairingReachForIntent(intent: RuntimePairingIntent): RuntimePairingReach {
  return intent === 'local' ? 'this-computer' : 'network'
}

export type RuntimePairingUrlGeneratorProps = {
  framed?: boolean
  showHeader?: boolean
  showGeneratorForm?: boolean
}

// Why: pairing tokens remain in the main-process registry, so the last link can
// survive settings navigation without writing credential material to storage.
const ADVERTISED_INTERFACE_NAME_MAX = 128

export type RuntimePairingInterface = {
  name: string
  address: string
}

export type AnotherDevicePairingPreference = {
  preferredInterfaceName: string | null
  preferredAddress: string
}

export function normalizeRuntimePairingAdvertisedInterfaceName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > ADVERTISED_INTERFACE_NAME_MAX) {
    return null
  }
  return trimmed
}

export function normalizeRuntimePairingAdvertisedAddress(value: unknown): string {
  return normalizeMobilePairingCustomAddress(value) ?? ''
}

export const runtimePairingLinkCache: {
  selectedAddress: string
  customAddress: string
  intent: RuntimePairingIntent
  advertisedInterfaceName: string | null
  advertisedAddress: string
  generatedAddress: string | null
  runtimePairingUrl: string | null
  webClientUrl: string | null
  runtimePairingDeviceId: string | null
} = {
  selectedAddress: '',
  customAddress: '',
  intent: 'another',
  advertisedInterfaceName: null,
  advertisedAddress: '',
  generatedAddress: null,
  runtimePairingUrl: null,
  webClientUrl: null,
  runtimePairingDeviceId: null
}

export function clearGeneratedRuntimePairingLink(): void {
  runtimePairingLinkCache.runtimePairingUrl = null
  runtimePairingLinkCache.webClientUrl = null
  runtimePairingLinkCache.runtimePairingDeviceId = null
  runtimePairingLinkCache.generatedAddress = null
}

export function cacheGeneratedRuntimePairingLink(args: {
  address: string
  pairingUrl: string
  webClientUrl: string | null
  deviceId: string
}): void {
  runtimePairingLinkCache.runtimePairingUrl = args.pairingUrl
  runtimePairingLinkCache.webClientUrl = args.webClientUrl
  runtimePairingLinkCache.runtimePairingDeviceId = args.deviceId
  runtimePairingLinkCache.generatedAddress = args.address
}

export function resolveAnotherDevicePairingAddress(args: {
  interfaces: readonly RuntimePairingInterface[]
  selectedAddress: string
  preferredInterfaceName: string | null
  preferredAddress: string
  platform: NodeJS.Platform
}): string {
  if (args.preferredInterfaceName) {
    const onPreferred = args.interfaces.filter(
      (iface) => iface.name === args.preferredInterfaceName
    )
    const selectedOnPreferred = onPreferred.find((iface) => iface.address === args.selectedAddress)
    if (selectedOnPreferred) {
      return selectedOnPreferred.address
    }
    if (onPreferred.length > 0) {
      const remembered = onPreferred.find((iface) => iface.address === args.preferredAddress)
      return (remembered ?? onPreferred[0]).address
    }
    // Why: Thunderbolt drops out of a non-empty interface list while Ethernet remains.
    // Keep the chosen address instead of adopting whichever interface is now first.
    if (args.preferredAddress) {
      return args.preferredAddress
    }
    if (
      args.selectedAddress &&
      !args.interfaces.some((iface) => iface.address === args.selectedAddress)
    ) {
      return args.selectedAddress
    }
    return ''
  }
  if (args.interfaces.some((iface) => iface.address === args.selectedAddress)) {
    return args.selectedAddress
  }
  return (
    selectAutoAdvertisedPairingAddress(args.interfaces, args.platform) ??
    args.interfaces[0]?.address ??
    ''
  )
}

export function selectRuntimePairingIntent(
  intent: RuntimePairingIntent,
  networkInterfaces: readonly RuntimePairingInterface[],
  customAddress: string,
  preference: AnotherDevicePairingPreference = {
    preferredInterfaceName: null,
    preferredAddress: ''
  },
  platform: NodeJS.Platform
): string {
  runtimePairingLinkCache.intent = intent
  const selectedAddress =
    intent === 'local'
      ? RUNTIME_PAIRING_LOOPBACK_ADDRESS
      : intent === 'another'
        ? resolveAnotherDevicePairingAddress({
            interfaces: networkInterfaces,
            selectedAddress: '',
            preferredInterfaceName: preference.preferredInterfaceName,
            preferredAddress: preference.preferredAddress,
            platform
          })
        : customAddress
  runtimePairingLinkCache.selectedAddress = selectedAddress
  return selectedAddress
}
