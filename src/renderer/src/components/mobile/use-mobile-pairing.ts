import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'
import { selectRefreshedNetworkAddress } from '../settings/mobile-network-interface-selection'
import type { StepIndex } from './MobileHero'
import type { MobilePageStage as FlowStage } from './mobile-page-stage'
import { translate } from '@/i18n/i18n'

type UseMobilePairingParams = {
  mountedRef: React.RefObject<boolean>
  stage: FlowStage | null
  stepIdx: StepIndex
  setPairingDeviceBaseline: (count: number | null) => void
}

type UseMobilePairingResult = {
  networkInterfaces: MobileNetworkInterface[]
  selectedAddress: string | undefined
  pairQrDataUrl: string | null
  pairingUrl: string | null
  pairLoading: boolean
  refreshingNetworkInterfaces: boolean
  hasGeneratedRef: React.RefObject<boolean>
  generatePairing: (rotate: boolean, addressOverride?: string) => Promise<void>
  loadNetworkInterfaces: () => Promise<void>
  handleAddressChange: (address: string) => void
  copyPairingCode: () => Promise<void>
  resetPairingState: () => void
}

export function useMobilePairing(params: UseMobilePairingParams): UseMobilePairingResult {
  const { mountedRef, stage, stepIdx, setPairingDeviceBaseline } = params

  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const hasGeneratedRef = useRef(false)

  const generatePairing = useCallback(
    async (rotate: boolean, addressOverride?: string) => {
      if (mountedRef.current) {
        setPairLoading(true)
      }
      try {
        const address = addressOverride ?? selectedAddress
        const result = await window.api.mobile.getPairingQR({
          ...(address ? { address } : {}),
          ...(rotate ? { rotate: true } : {})
        })
        if (result.available) {
          if (mountedRef.current) {
            setPairQrDataUrl(result.qrDataUrl)
            setPairingUrl(result.pairingUrl)
          }
          hasGeneratedRef.current = true
        } else {
          if (mountedRef.current) {
            toast.error(
              translate(
                'auto.components.mobile.MobilePage.b353e18de1',
                'WebSocket transport is not running'
              )
            )
          }
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
    [mountedRef, selectedAddress]
  )

  const loadNetworkInterfaces = useCallback(async () => {
    if (mountedRef.current) {
      setRefreshingNetworkInterfaces(true)
    }
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      if (mountedRef.current) {
        setNetworkInterfaces(result.interfaces)
      }
      // Resolve the new address before committing it so we can detect a real
      // change and remint the QR — otherwise the QR keeps encoding the stale
      // endpoint after a network refresh swaps the active interface.
      const newAddress = selectRefreshedNetworkAddress(selectedAddress, result.interfaces)
      if (mountedRef.current) {
        setSelectedAddress(newAddress)
      }
      if (newAddress !== selectedAddress && hasGeneratedRef.current && mountedRef.current) {
        void generatePairing(true, newAddress)
      }
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      if (mountedRef.current) {
        setRefreshingNetworkInterfaces(false)
      }
    }
  }, [selectedAddress, generatePairing, mountedRef])

  const handleAddressChange = useCallback(
    (address: string) => {
      setSelectedAddress(address)
      // Switching network must remint so the QR encodes the new endpoint.
      void generatePairing(true, address)
    },
    [generatePairing]
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

  const resetPairingState = useCallback((): void => {
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
  }, [])

  // Why: render install QRs lazily — only after the user enters the flow.
  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    void loadNetworkInterfaces()
  }, [stage, loadNetworkInterfaces])

  // Why: when Step 2 first becomes visible, mint a pairing offer so the
  // user sees a real QR immediately. Subsequent visits keep the existing
  // token unless they hit Regenerate.
  useEffect(() => {
    if (stage !== 'flow' || stepIdx !== 1 || hasGeneratedRef.current) {
      return
    }
    void generatePairing(false)
  }, [stage, stepIdx, generatePairing])

  return {
    networkInterfaces,
    selectedAddress,
    pairQrDataUrl,
    pairingUrl,
    pairLoading,
    refreshingNetworkInterfaces,
    hasGeneratedRef,
    generatePairing,
    loadNetworkInterfaces,
    handleAddressChange,
    copyPairingCode,
    resetPairingState
  }
}
