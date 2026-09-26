import type { MobilePairingConnectionMode } from './mobile-pairing-connection-mode'
import type { MobileRelayProvider } from './mobile-relay-provider'

/** Desktop picker values; self-hosted offers still use the existing Relay wire format. */
export type MobilePairingPath = MobilePairingConnectionMode | 'self-hosted'

export function mobilePairingPathOptions(path: MobilePairingPath): {
  connectionMode: MobilePairingConnectionMode
  relayProvider?: MobileRelayProvider
} {
  return path === 'self-hosted'
    ? { connectionMode: 'automatic', relayProvider: 'self-hosted' }
    : { connectionMode: path }
}

export function mobilePairingPathSettings(path: MobilePairingPath): {
  mobilePairingConnectionMode: MobilePairingConnectionMode
  mobilePairingRelayProvider?: MobileRelayProvider
} {
  if (path === 'local-only') {
    return { mobilePairingConnectionMode: path }
  }
  return {
    mobilePairingConnectionMode: 'automatic',
    mobilePairingRelayProvider: path === 'self-hosted' ? 'self-hosted' : 'official'
  }
}
