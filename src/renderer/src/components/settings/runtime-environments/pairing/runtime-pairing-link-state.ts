import type { RuntimePairingReach } from '../../../../../../shared/runtime-pairing-reach'

export const RUNTIME_PAIRING_LOOPBACK_ADDRESS = '127.0.0.1'

export type RuntimePairingIntent = 'another' | 'local' | 'custom'

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
  expiresAt: number | null
} = {
  selectedAddress: '',
  customAddress: '',
  intent: 'another',
  generatedAddress: null,
  runtimePairingUrl: null,
  webClientUrl: null,
  runtimePairingDeviceId: null,
  expiresAt: null
}

export function clearGeneratedRuntimePairingLink(): void {
  runtimePairingLinkCache.runtimePairingUrl = null
  runtimePairingLinkCache.webClientUrl = null
  runtimePairingLinkCache.runtimePairingDeviceId = null
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
  runtimePairingLinkCache.generatedAddress = args.address
  runtimePairingLinkCache.expiresAt = args.expiresAt
}

export function selectRuntimePairingIntent(
  intent: RuntimePairingIntent,
  networkInterfaces: { address: string }[],
  customAddress: string
): string {
  runtimePairingLinkCache.intent = intent
  const selectedAddress =
    intent === 'local'
      ? RUNTIME_PAIRING_LOOPBACK_ADDRESS
      : intent === 'another'
        ? (networkInterfaces[0]?.address ?? '')
        : customAddress
  runtimePairingLinkCache.selectedAddress = selectedAddress
  return selectedAddress
}
