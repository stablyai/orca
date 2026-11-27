import type { RuntimePairingReach } from '../../../../../../shared/remote-runtime/pairing/runtime-pairing-reach'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'

export const RUNTIME_PAIRING_LOOPBACK_ADDRESS = '127.0.0.1'

export type RuntimePairingIntent = 'another' | 'local' | 'custom'

export type RuntimePairingInterface = NonNullable<GlobalSettings['runtimePairingInterface']>

// Returns the stored object itself so store selectors stay referentially stable.
export function readRuntimePairingInterface(
  saved: GlobalSettings['runtimePairingInterface']
): RuntimePairingInterface | null {
  return typeof saved?.name === 'string' && typeof saved.address === 'string' && saved.address
    ? saved
    : null
}

export function resolveAnotherDeviceAddress(
  interfaces: readonly RuntimePairingInterface[],
  selectedAddress: string,
  chosen: RuntimePairingInterface | null
): string {
  if (interfaces.some((iface) => iface.address === selectedAddress)) {
    return selectedAddress
  }
  if (!chosen || interfaces.length === 0) {
    return interfaces[0]?.address ?? ''
  }
  if (interfaces.some((iface) => iface.address === chosen.address)) {
    return chosen.address
  }
  // Why: follow the chosen interface by name when its IPv4 changed; while it is absent (Thunderbolt Bridge
  // dropout), hold its address so new links are not silently pointed at the top-ranked interface instead.
  return interfaces.find((iface) => iface.name === chosen.name)?.address ?? chosen.address
}

// The chosen interface at its new address when `address` is where the resolver followed it, so callers can persist it.
export function followedRuntimePairingInterface(
  interfaces: readonly RuntimePairingInterface[],
  address: string,
  chosen: RuntimePairingInterface | null
): RuntimePairingInterface | null {
  if (!chosen || address === chosen.address) {
    return null
  }
  return interfaces.some((iface) => iface.name === chosen.name && iface.address === address)
    ? { name: chosen.name, address }
    : null
}

// Only explicit local intent forbids network reach; custom loopback addresses may front SSH/reverse-proxy tunnels.
export function runtimePairingReachForIntent(intent: RuntimePairingIntent): RuntimePairingReach {
  return intent === 'local' ? 'this-computer' : 'network'
}

// Main retains pairing tokens; cache navigation state without persisting credential material.
export const runtimePairingLinkCache: {
  selectedAddress: string
  customAddress: string
  intent: RuntimePairingIntent
  generatedAddress: string | null
  runtimePairingUrl: string | null
  webClientUrl: string | null
  runtimePairingDeviceId: string | null
  grantStatus: 'unknown' | 'unused' | 'used' | 'removed'
  expiresAt: number | null
} = {
  selectedAddress: '',
  customAddress: '',
  intent: 'another',
  generatedAddress: null,
  runtimePairingUrl: null,
  webClientUrl: null,
  runtimePairingDeviceId: null,
  grantStatus: 'unknown',
  expiresAt: null
}

export function clearGeneratedRuntimePairingLink(): void {
  runtimePairingLinkCache.runtimePairingUrl = null
  runtimePairingLinkCache.webClientUrl = null
  runtimePairingLinkCache.runtimePairingDeviceId = null
  runtimePairingLinkCache.grantStatus = 'unknown'
  runtimePairingLinkCache.generatedAddress = null
  runtimePairingLinkCache.expiresAt = null
}

export function cacheGeneratedRuntimePairingLink(args: {
  address: string
  pairingUrl: string
  webClientUrl: string | null
  deviceId: string
  expiresAt: number | null
}): void {
  runtimePairingLinkCache.runtimePairingUrl = args.pairingUrl
  runtimePairingLinkCache.webClientUrl = args.webClientUrl
  runtimePairingLinkCache.runtimePairingDeviceId = args.deviceId
  runtimePairingLinkCache.grantStatus = 'unknown'
  runtimePairingLinkCache.generatedAddress = args.address
  runtimePairingLinkCache.expiresAt = args.expiresAt
}

export function selectRuntimePairingIntent(
  intent: RuntimePairingIntent,
  networkInterfaces: readonly RuntimePairingInterface[],
  customAddress: string,
  chosenInterface: RuntimePairingInterface | null
): string {
  runtimePairingLinkCache.intent = intent
  const selectedAddress =
    intent === 'local'
      ? RUNTIME_PAIRING_LOOPBACK_ADDRESS
      : intent === 'another'
        ? resolveAnotherDeviceAddress(networkInterfaces, '', chosenInterface)
        : customAddress
  runtimePairingLinkCache.selectedAddress = selectedAddress
  return selectedAddress
}
