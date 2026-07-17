import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

type MobilePairingQrRequest = NonNullable<Parameters<typeof window.api.mobile.getPairingQR>[0]>

export function createMobilePairingQrRequest(args: {
  addresses: readonly string[]
  connectionMode: MobilePairingConnectionMode
  orderedRoutes: boolean
  relayPreferenceIndex: number
  rotate: boolean
}): MobilePairingQrRequest {
  return {
    ...(args.orderedRoutes
      ? args.addresses.length > 0
        ? { addresses: [...args.addresses], orderedRoutes: true }
        : { orderedRoutes: true }
      : args.addresses[0]
        ? { address: args.addresses[0] }
        : {}),
    connectionMode: args.connectionMode,
    ...(args.orderedRoutes && args.connectionMode === 'automatic'
      ? { relayPreferenceIndex: args.relayPreferenceIndex }
      : {}),
    ...(args.rotate ? { rotate: true } : {})
  }
}
