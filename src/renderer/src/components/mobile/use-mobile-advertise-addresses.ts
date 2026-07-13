import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { MutableRefObject } from 'react'
import { translate } from '@/i18n/i18n'
import {
  orderedAdvertiseAddressesEqual,
  refreshOrderedAdvertiseAddresses,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import {
  deriveCustomAdvertiseAddresses,
  loadMobileAdvertiseAddressOrder,
  saveMobileAdvertiseAddressOrder
} from '../settings/mobile-advertise-address-order-store'

function readInitialAdvertiseOrder(): {
  addresses: string[]
  customAddresses: Set<string>
} {
  const stored = loadMobileAdvertiseAddressOrder()
  if (!stored) {
    return { addresses: [], customAddresses: new Set() }
  }
  return {
    addresses: stored.addresses,
    customAddresses: new Set(stored.customAddresses)
  }
}

export type UseMobileAdvertiseAddressesArgs = {
  mountedRef: MutableRefObject<boolean>
  /** When true, load/refresh interfaces (Mobile flow stage active). */
  interfacesActive: boolean
  /** When true and no QR yet, auto-mint a pairing offer. */
  shouldAutoGenerate: boolean
}

export type UseMobileAdvertiseAddressesResult = {
  networkInterfaces: MobileNetworkInterface[]
  selectedAddresses: string[]
  refreshingNetworkInterfaces: boolean
  pairQrDataUrl: string | null
  pairingUrl: string | null
  pairLoading: boolean
  loadNetworkInterfaces: () => Promise<void>
  handleAddressesChange: (addresses: string[]) => void
  generatePairing: (rotate: boolean, addressesOverride?: readonly string[]) => Promise<void>
  copyPairingCode: () => Promise<void>
  /** Clear QR state and allow the auto-generate effect to mint again. */
  resetPairingOffer: () => void
}

export function useMobileAdvertiseAddresses({
  mountedRef,
  interfacesActive,
  shouldAutoGenerate
}: UseMobileAdvertiseAddressesArgs): UseMobileAdvertiseAddressesResult {
  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>(
    () => readInitialAdvertiseOrder().addresses
  )
  // Why: remember which selections are user-typed customs so refresh can keep
  // them when discovery is empty / interfaces churn (KTD5).
  const [customAddresses, setCustomAddresses] = useState<Set<string>>(
    () => readInitialAdvertiseOrder().customAddresses
  )
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const hasGeneratedRef = useRef(false)
  const networkInterfacesRef = useRef<MobileNetworkInterface[]>([])

  const persistAdvertiseOrder = useCallback((addresses: string[], customs: ReadonlySet<string>) => {
    saveMobileAdvertiseAddressOrder(addresses, customs)
  }, [])

  const generatePairing = useCallback(
    async (rotate: boolean, addressesOverride?: readonly string[]) => {
      if (mountedRef.current) {
        setPairLoading(true)
      }
      try {
        const addresses = [...(addressesOverride ?? selectedAddresses)]
        const result = await window.api.mobile.getPairingQR({
          ...(addresses.length > 0 ? { addresses } : {}),
          ...(rotate ? { rotate: true } : {})
        })
        if (result.available) {
          if (mountedRef.current) {
            setPairQrDataUrl(result.qrDataUrl)
            setPairingUrl(result.pairingUrl)
          }
          hasGeneratedRef.current = true
        } else if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.mobile.MobilePage.b353e18de1',
              'WebSocket transport is not running'
            )
          )
        }
      } catch {
        if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.mobile.MobilePage.4c8bd11c1a',
              'Failed to generate pairing code'
            )
          )
        }
      } finally {
        if (mountedRef.current) {
          setPairLoading(false)
        }
      }
    },
    [mountedRef, selectedAddresses]
  )

  const loadNetworkInterfaces = useCallback(async () => {
    if (mountedRef.current) {
      setRefreshingNetworkInterfaces(true)
    }
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      const previousInterfaces = networkInterfacesRef.current
      const nextAddresses = refreshOrderedAdvertiseAddresses(
        selectedAddresses,
        result.interfaces,
        previousInterfaces,
        { customAddresses }
      )
      const nextCustoms = deriveCustomAdvertiseAddresses(
        nextAddresses,
        result.interfaces,
        customAddresses
      )
      const addressesChanged = !orderedAdvertiseAddressesEqual(nextAddresses, selectedAddresses)
      if (mountedRef.current) {
        networkInterfacesRef.current = result.interfaces
        setNetworkInterfaces(result.interfaces)
        if (addressesChanged) {
          setSelectedAddresses(nextAddresses)
          setCustomAddresses(nextCustoms)
          persistAdvertiseOrder(nextAddresses, nextCustoms)
        }
      }
      // Remint when the ordered set changes — same rotate semantics as today's
      // single-address change path.
      if (addressesChanged && hasGeneratedRef.current && mountedRef.current) {
        void generatePairing(true, nextAddresses)
      }
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      if (mountedRef.current) {
        setRefreshingNetworkInterfaces(false)
      }
    }
  }, [selectedAddresses, customAddresses, generatePairing, mountedRef, persistAdvertiseOrder])

  useEffect(() => {
    if (!interfacesActive) {
      return
    }
    void loadNetworkInterfaces()
  }, [interfacesActive, loadNetworkInterfaces])

  const handleAddressesChange = useCallback(
    (addresses: string[]) => {
      const nextCustoms = deriveCustomAdvertiseAddresses(
        addresses,
        networkInterfacesRef.current,
        customAddresses
      )
      setSelectedAddresses(addresses)
      setCustomAddresses(nextCustoms)
      persistAdvertiseOrder(addresses, nextCustoms)
      // Switching advertise order must remint so the QR encodes the new list.
      void generatePairing(true, addresses)
    },
    [customAddresses, generatePairing, persistAdvertiseOrder]
  )

  const copyPairingCode = useCallback(async () => {
    if (!pairingUrl) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(pairingUrl)
      if (mountedRef.current) {
        toast.success(
          translate('auto.components.mobile.MobilePage.3c1f7168bb', 'Pairing code copied')
        )
      }
    } catch (err) {
      console.error('writeClipboardText failed', err)
      if (mountedRef.current) {
        toast.error(
          translate('auto.components.mobile.MobilePage.6a66e38943', 'Failed to copy pairing code')
        )
      }
    }
  }, [mountedRef, pairingUrl])

  // Why: when Step 2 first becomes visible, mint a pairing offer so the
  // user sees a real QR immediately. Subsequent visits keep the existing
  // token unless they hit Regenerate.
  useEffect(() => {
    if (!shouldAutoGenerate || hasGeneratedRef.current) {
      return
    }
    void generatePairing(false)
  }, [shouldAutoGenerate, generatePairing])

  const resetPairingOffer = useCallback(() => {
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
  }, [])

  return {
    networkInterfaces,
    selectedAddresses,
    refreshingNetworkInterfaces,
    pairQrDataUrl,
    pairingUrl,
    pairLoading,
    loadNetworkInterfaces,
    handleAddressesChange,
    generatePairing,
    copyPairingCode,
    resetPairingOffer
  }
}
