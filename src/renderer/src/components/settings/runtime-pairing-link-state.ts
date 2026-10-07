import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'

export const RUNTIME_PAIRING_LOOPBACK_ADDRESS = '127.0.0.1'

export type RuntimePairingIntent = 'another' | 'local' | 'custom' | 'relay'

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
  intent: RuntimePairingIntent
  generatedAddress: string | null
  runtimePairingUrl: string | null
  webClientUrl: string | null
  runtimePairingDeviceId: string | null
  /** Set only for a link that carries an Orca Relay invite. */
  relayInviteExpiresAt: number | null
} = {
  selectedAddress: '',
  customAddress: '',
  intent: 'another',
  generatedAddress: null,
  runtimePairingUrl: null,
  webClientUrl: null,
  runtimePairingDeviceId: null,
  relayInviteExpiresAt: null
}

export function clearGeneratedRuntimePairingLink(): void {
  runtimePairingLinkCache.runtimePairingUrl = null
  runtimePairingLinkCache.webClientUrl = null
  runtimePairingLinkCache.runtimePairingDeviceId = null
  runtimePairingLinkCache.generatedAddress = null
  runtimePairingLinkCache.relayInviteExpiresAt = null
}

function cacheGeneratedRuntimePairingLink(args: {
  address: string
  pairingUrl: string
  webClientUrl: string | null
  deviceId: string
  relayInviteExpiresAt: number | null
}): void {
  runtimePairingLinkCache.runtimePairingUrl = args.pairingUrl
  runtimePairingLinkCache.webClientUrl = args.webClientUrl
  runtimePairingLinkCache.runtimePairingDeviceId = args.deviceId
  runtimePairingLinkCache.generatedAddress = args.address
  runtimePairingLinkCache.relayInviteExpiresAt = args.relayInviteExpiresAt
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
      : intent === 'another' || intent === 'relay'
        ? (networkInterfaces[0]?.address ?? '')
        : customAddress
  runtimePairingLinkCache.selectedAddress = selectedAddress
  return selectedAddress
}

export type RuntimePairingLinkResult =
  | {
      available: true
      pairingUrl: string
      webClientUrl: string | null
      deviceId: string
      relayInviteExpiresAt: number | null
    }
  | { available: false; guidance?: string }

/** Mints a fresh link for the chosen intent and remembers it for the next settings visit. */
export async function requestRuntimePairingLink(
  intent: RuntimePairingIntent,
  address: string
): Promise<RuntimePairingLinkResult> {
  const result = await requestRuntimePairingLinkForIntent(intent, address)
  if (result.available) {
    cacheGeneratedRuntimePairingLink({ ...result, address })
  }
  return result
}

async function requestRuntimePairingLinkForIntent(
  intent: RuntimePairingIntent,
  address: string
): Promise<RuntimePairingLinkResult> {
  if (intent === 'relay') {
    // Why: main picks the direct address itself; a Relay link must work without one.
    const result = await window.api.mobile.getRuntimeRelayPairingUrl()
    return result.available
      ? {
          available: true,
          pairingUrl: result.pairingUrl,
          webClientUrl: null,
          deviceId: result.deviceId,
          relayInviteExpiresAt: result.inviteExpiresAt
        }
      : result
  }
  const result = await window.api.mobile.getRuntimePairingUrl({
    address,
    rotate: true,
    // Why: main gates the one-way network widen on this, so the declared choice must travel with the
    // address — the address alone cannot tell "This computer only" from a loopback tunnel front-end.
    reach: runtimePairingReachForIntent(intent)
  })
  return result.available ? { ...result, relayInviteExpiresAt: null } : result
}
