import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { type PairedDevice, type Platform, type StepIndex } from './MobileHero'
import { PLATFORM_COPY } from './mobile-platform-copy'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import { useMobilePairingDevicePolling } from '../settings/mobile-pairing-device-polling'
import {
  shouldShowPairedAfterDeviceRefresh,
  type MobilePageStage as FlowStage
} from './mobile-page-stage'
import { translate } from '@/i18n/i18n'
import { useMobilePageEscape } from './use-mobile-page-escape'
import { MobilePageContent } from './MobilePageContent'
import { useMobileInstallQr } from './use-mobile-install-qr'

export default function MobilePage(): React.JSX.Element {
  // Why: stage starts unresolved so we don't flash the intro before we know
  // whether any devices are already paired.
  const [stage, setStage] = useState<FlowStage | null>(null)
  const [stepIdx, setStepIdx] = useState<StepIndex>(0)

  const [platform, setPlatform] = useState<Platform>('ios')

  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [revokingDeviceIds, setRevokingDeviceIds] = useState<string[]>([])
  const [deviceCountAtPairStart, setDeviceCountAtPairStart] = useState<number | null>(null)
  const hasGeneratedRef = useRef(false)
  const mountedRef = useMountedRef()
  const stageRef = useRef<FlowStage | null>(null)
  const deviceCountAtPairStartRef = useRef<number | null>(null)
  const closeMobilePage = useAppStore((s) => s.closeMobilePage)
  const showMobileButton = useAppStore((s) => s.settings?.showMobileButton !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const installQrUrl = useMobileInstallQr(stage, platform)

  const setPairingDeviceBaseline = useCallback(
    (count: number | null): void => {
      deviceCountAtPairStartRef.current = count
      if (mountedRef.current) {
        setDeviceCountAtPairStart(count)
      }
    },
    [mountedRef]
  )

  const showStage = useCallback(
    (nextStage: FlowStage | null): void => {
      stageRef.current = nextStage
      if (mountedRef.current) {
        setStage(nextStage)
      }
    },
    [mountedRef]
  )

  const showPairedDevices = useCallback(
    (deviceCount: number): void => {
      // Why: paired-view polling uses this baseline; setting it with the
      // transition avoids the render-plus-Effect gap where polling stops.
      setPairingDeviceBaseline(deviceCount)
      showStage('paired')
    },
    [setPairingDeviceBaseline, showStage]
  )

  const loadDevices = useCallback(async (): Promise<PairedDevice[]> => {
    try {
      const result = await window.api.mobile.listDevices()
      if (mountedRef.current) {
        setDevices(result.devices)
        if (
          shouldShowPairedAfterDeviceRefresh({
            stage: stageRef.current,
            deviceCountAtPairStart: deviceCountAtPairStartRef.current,
            nextDeviceCount: result.devices.length
          })
        ) {
          showPairedDevices(result.devices.length)
        }
      }
      return result.devices
    } catch (err) {
      // Log so a transient IPC failure (which routes the user to 'intro') is
      // observable; keep returning [] so callers' behavior is unchanged.
      console.error('mobile.listDevices failed', err)
      return []
    }
  }, [mountedRef, showPairedDevices])

  // Why: pick the initial stage based on whether any devices are already
  // paired so returning users don't see the marketing intro every time.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const initialDevices = await loadDevices()
      if (cancelled) {
        return
      }
      if (initialDevices.length > 0) {
        showPairedDevices(initialDevices.length)
      } else {
        showStage('intro')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadDevices, showPairedDevices, showStage])

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      // Dedupe rapid double-clicks: if a revoke for this id is already in
      // flight, bail before issuing a second IPC call.
      let alreadyRevoking = false
      setRevokingDeviceIds((prev) => {
        if (prev.includes(deviceId)) {
          alreadyRevoking = true
          return prev
        }
        return [...prev, deviceId]
      })
      if (alreadyRevoking) {
        return
      }
      try {
        await window.api.mobile.revokeDevice({ deviceId })
        const remaining = await loadDevices()
        if (mountedRef.current) {
          toast.success(translate('auto.components.mobile.MobilePage.255372e6e8', 'Device revoked'))
        }
        if (remaining.length === 0 && mountedRef.current) {
          showStage('intro')
        }
      } catch {
        if (mountedRef.current) {
          toast.error(
            translate('auto.components.mobile.MobilePage.4e1eb5d55c', 'Failed to revoke device')
          )
        }
      } finally {
        if (mountedRef.current) {
          setRevokingDeviceIds((prev) => prev.filter((id) => id !== deviceId))
        }
      }
    },
    [loadDevices, mountedRef, showStage]
  )

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

  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    void loadNetworkInterfaces()
  }, [stage, loadNetworkInterfaces])

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

  // Why: when Step 2 first becomes visible, mint a pairing offer so the
  // user sees a real QR immediately. Subsequent visits keep the existing
  // token unless they hit Regenerate.
  useEffect(() => {
    if (stage !== 'flow' || stepIdx !== 1 || hasGeneratedRef.current) {
      return
    }
    void generatePairing(false)
  }, [stage, stepIdx, generatePairing])

  // Why: poll for new pairings while the user is on Step 2 so we can
  // auto-transition to the paired summary the moment their phone connects.
  const polledLoadDevices = useCallback(async () => {
    await loadDevices()
  }, [loadDevices])

  // Why: poll for new pairings on Step 2 (waiting for the first pair) and
  // also on the paired view (so additional phones that finish pairing while
  // the user is reading the list show up without a manual refresh).
  useMobilePairingDevicePolling({
    deviceCountAtQr:
      (stage === 'flow' && stepIdx === 1) || stage === 'paired' ? deviceCountAtPairStart : null,
    currentDeviceCount: devices.length,
    loadDevices: polledLoadDevices
  })

  const enterFlow = (): void => {
    setStepIdx(0)
    setPairingDeviceBaseline(devices.length)
    // Force the auto-generate effect to mint a fresh pairing token on next
    // entry into Step 2, and clear stale QR state so we never flash an
    // expired code from a previous session.
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
    showStage('flow')
  }

  // Why: from the paired summary, "Pair another device" jumps straight to
  // Step 2 since the app is presumably already installed on the user's phone.
  const pairAnotherDevice = (): void => {
    setStepIdx(1)
    setPairingDeviceBaseline(devices.length)
    // Same reset as enterFlow — re-entering must mint a fresh pairing offer.
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
    showStage('flow')
  }

  const handleBack = (): void => {
    if (stepIdx === 1) {
      setStepIdx(0)
    } else {
      showStage('intro')
    }
  }

  const handleContinue = (): void => {
    if (stepIdx === 0) {
      setStepIdx(1)
    }
  }

  const openInstallUrl = (): void => {
    void window.api.shell.openUrl(PLATFORM_COPY[platform].url)
  }

  const copyInstallUrl = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(PLATFORM_COPY[platform].url)
      if (mountedRef.current) {
        toast.success(
          translate('auto.components.mobile.MobilePage.fad833de8d', 'Install link copied')
        )
      }
    } catch (err) {
      console.error('writeClipboardText failed', err)
      if (mountedRef.current) {
        toast.error(
          translate('auto.components.mobile.MobilePage.baea63c445', 'Failed to copy link')
        )
      }
    }
  }

  const toggleMobileSidebarButton = useCallback(() => {
    void updateSettings({ showMobileButton: !showMobileButton })
  }, [showMobileButton, updateSettings])

  useMobilePageEscape(closeMobilePage)

  return (
    <MobilePageContent
      closeMobilePage={closeMobilePage}
      copyInstallUrl={() => void copyInstallUrl()}
      copyPairingCode={() => void copyPairingCode()}
      devices={devices}
      enterFlow={enterFlow}
      generatePairing={(rotate) => void generatePairing(rotate)}
      handleAddressChange={handleAddressChange}
      handleBack={handleBack}
      handleContinue={handleContinue}
      installQrUrl={installQrUrl}
      loadNetworkInterfaces={() => void loadNetworkInterfaces()}
      networkInterfaces={networkInterfaces}
      openInstallUrl={openInstallUrl}
      pairAnotherDevice={pairAnotherDevice}
      pairLoading={pairLoading}
      pairQrDataUrl={pairQrDataUrl}
      pairingUrl={pairingUrl}
      platform={platform}
      refreshingNetworkInterfaces={refreshingNetworkInterfaces}
      revokeDevice={(id) => void revokeDevice(id)}
      revokingDeviceIds={revokingDeviceIds}
      selectedAddress={selectedAddress}
      setPlatform={setPlatform}
      showMobileButton={showMobileButton}
      showPairedDevices={showPairedDevices}
      stage={stage}
      stepIdx={stepIdx}
      toggleMobileSidebarButton={toggleMobileSidebarButton}
    />
  )
}
