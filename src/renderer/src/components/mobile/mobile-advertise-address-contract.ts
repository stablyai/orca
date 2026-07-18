import type { MutableRefObject } from 'react'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'

export type UseMobileAdvertiseAddressesArgs = {
  mountedRef: MutableRefObject<boolean>
  interfacesActive: boolean
  shouldAutoGenerate: boolean
  connectionMode: MobilePairingConnectionMode
  advancedConnectionOrderEnabled: boolean
}

export type UseMobileAdvertiseAddressesResult = {
  networkInterfaces: MobileNetworkInterface[]
  selectedAddresses: string[]
  relayPreferenceIndex: number
  refreshingNetworkInterfaces: boolean
  pairQrDataUrl: string | null
  pairingUrl: string | null
  pairLoading: boolean
  loadNetworkInterfaces: () => Promise<void>
  handleAddressesChange: (addresses: string[]) => void
  handlePrimaryAddressChange: (address: string) => void
  handleRouteOrderChange: (addresses: string[], relayIndex: number) => void
  generatePairing: (
    rotate: boolean,
    addressesOverride?: readonly string[],
    relayIndexOverride?: number
  ) => Promise<void>
  copyPairingCode: () => Promise<void>
  resetPairingOffer: () => void
}
