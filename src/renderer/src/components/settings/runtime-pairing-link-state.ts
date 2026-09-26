import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'

export const RUNTIME_PAIRING_LOOPBACK_ADDRESS = '127.0.0.1'

export type RuntimePairingIntent = 'another' | 'local' | 'custom' | 'cloudflare'

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
export const runtimePairingLinkCache: {
  selectedAddress: string
  customAddress: string
  // Why kept apart from customAddress: the two fields validate differently, so switching intents
  // back and forth must not carry a rejected value into the other field.
  cloudflareAddress: string
  intent: RuntimePairingIntent
  generatedAddress: string | null
  runtimePairingUrl: string | null
  webClientUrl: string | null
  runtimePairingDeviceId: string | null
} = {
  selectedAddress: '',
  customAddress: '',
  cloudflareAddress: '',
  intent: 'another',
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

export function selectRuntimePairingIntent(
  intent: RuntimePairingIntent,
  networkInterfaces: { address: string }[],
  addresses: { customAddress: string; cloudflareAddress: string }
): string {
  runtimePairingLinkCache.intent = intent
  const selectedAddress = addressForIntent(intent, networkInterfaces, addresses)
  runtimePairingLinkCache.selectedAddress = selectedAddress
  return selectedAddress
}

function addressForIntent(
  intent: RuntimePairingIntent,
  networkInterfaces: { address: string }[],
  addresses: { customAddress: string; cloudflareAddress: string }
): string {
  switch (intent) {
    case 'local':
      return RUNTIME_PAIRING_LOOPBACK_ADDRESS
    case 'another':
      return networkInterfaces[0]?.address ?? ''
    case 'cloudflare':
      return addresses.cloudflareAddress
    case 'custom':
      return addresses.customAddress
  }
}

export function rememberIntentAddress(intent: RuntimePairingIntent, address: string): void {
  if (intent === 'cloudflare') {
    runtimePairingLinkCache.cloudflareAddress = address
    return
  }
  if (intent === 'custom') {
    runtimePairingLinkCache.customAddress = address
  }
}
