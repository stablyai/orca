import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { Platform, StepIndex } from './MobileHero'
import type { IosChannel } from './mobile-platform-copy'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import { translate } from '@/i18n/i18n'
import { useMobilePageEscape } from './use-mobile-page-escape'
import { MobilePageContent } from './MobilePageContent'
import { useMobileInstallQr } from './use-mobile-install-qr'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'
import { useMobilePairingConnectionMode } from './use-mobile-pairing-connection-mode'
import { useMobilePairingGeneration } from './use-mobile-pairing-generation'
import { useMobilePairingQrInvalidation } from './use-mobile-pairing-qr-invalidation'
import { useMobileInstallActions } from './use-mobile-install-actions'
import { useMobilePagePairedDevices } from './use-mobile-page-paired-devices'

export default function MobilePage(): React.JSX.Element {
  const [stepIdx, setStepIdx] = useState<StepIndex>(0)

  const [platform, setPlatform] = useState<Platform>('ios')
  // Default iOS users to the preview track — it ships daily, so newcomers land
  // on the freshest build unless they deliberately pick the public release.
  const [iosChannel, setIosChannel] = useState<IosChannel>('preview')

  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  // Mode the displayed QR actually encodes; can be 'local-only' under an
  // Anywhere selection when Relay provisioning degraded server-side.
  const [encodedConnectionMode, setEncodedConnectionMode] =
    useState<MobilePairingConnectionMode | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const signedIn = useAppStore((state) => state.orcaProfileAuthStatus?.state === 'connected')
  const [connectionMode, setConnectionMode] = useMobilePairingConnectionMode()
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  // Why: tracks whether `selectedAddress` came from the user typing a
  // manual value rather than from an OS-enumerated interface, so the
  // refresh path can keep their choice instead of snapping back to LAN.
  const [addressIsManual, setAddressIsManual] = useState(false)
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const hasGeneratedRef = useRef(false)
  const pairingRequestIdRef = useRef(0)
  const mountedRef = useMountedRef()
  const closeMobilePage = useAppStore((s) => s.closeMobilePage)
  const showMobileButton = useAppStore((s) => s.settings?.showMobileButton !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const {
    devices,
    enterFlow: showFirstPairingFlow,
    handleBack,
    pairAnotherDevice: showPairAnotherDeviceFlow,
    revokeDevice,
    revokingDeviceIds,
    showPairedDevices,
    stage
  } = useMobilePagePairedDevices({ stepIdx, setStepIdx })
  const installQrUrl = useMobileInstallQr(stage, platform, iosChannel)
  const { copyInstallUrl, openInstallUrl } = useMobileInstallActions(platform, iosChannel)

  const { generatePairing } = useMobilePairingGeneration({
    connectionMode,
    signedIn,
    selectedAddress,
    mountedRef,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairingUrl,
    setPairLoading,
    setEncodedConnectionMode
  })

  const handleConnectionModeChange = useCallback(
    (nextMode: MobilePairingConnectionMode): void => {
      if (nextMode === connectionMode) {
        return
      }
      // Why: persist the pick and update local state. The QR invalidation +
      // rotate-regenerate is handled centrally by useMobilePairingQrInvalidation
      // (below), which also covers cross-window preference syncs.
      setConnectionMode(nextMode)
      void updateSettings({ mobilePairingConnectionMode: nextMode })
    },
    [connectionMode, updateSettings, setConnectionMode]
  )

  useMobilePairingQrInvalidation({
    connectionMode,
    signedIn,
    pairLoading,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairingUrl,
    setPairLoading,
    regenerate: (mode, opts) => void generatePairing(opts.rotate, undefined, mode)
  })

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
      const newAddress = selectRefreshedNetworkAddress(
        selectedAddress,
        result.interfaces,
        addressIsManual
      )
      if (mountedRef.current) {
        // Why: selectRefreshedNetworkAddress can rewrite selectedAddress
        // (e.g. when a refresh surfaces a tailnet interface and the user
        // had been on LAN). Re-derive `addressIsManual` from the new
        // value so the next refresh doesn't snap the user back to LAN
        // just because they once picked a non-tailnet interface.
        setSelectedAddress(newAddress)
        const nextIsManual =
          newAddress !== undefined &&
          !result.interfaces.some((iface) => iface.address === newAddress)
        setAddressIsManual(nextIsManual)
      }
      if (
        newAddress !== selectedAddress &&
        hasGeneratedRef.current &&
        canMintMobilePairingOffer({ connectionMode, signedIn }) &&
        mountedRef.current
      ) {
        void generatePairing(true, newAddress)
      }
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      if (mountedRef.current) {
        setRefreshingNetworkInterfaces(false)
      }
    }
  }, [selectedAddress, generatePairing, mountedRef, addressIsManual, connectionMode, signedIn])

  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    void loadNetworkInterfaces()
  }, [stage, loadNetworkInterfaces])

  const handleAddressChange = useCallback(
    (address: string) => {
      setSelectedAddress(address)
      // Why: if the picked address is not in the OS-enumerated list, it is
      // a user-typed manual entry — remember that so the next refresh does
      // not snap it back to a tailnet/LAN fallback.
      const isManual = !networkInterfaces.some((iface) => iface.address === address)
      setAddressIsManual(isManual)
      // Switching network must remint so the QR encodes the new endpoint —
      // but only when the selected path may honestly mint (not signed-out Anywhere).
      if (canMintMobilePairingOffer({ connectionMode, signedIn })) {
        void generatePairing(true, address)
      }
    },
    [generatePairing, networkInterfaces, connectionMode, signedIn]
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
  const canGenerate = canMintMobilePairingOffer({ connectionMode, signedIn })
  useEffect(() => {
    if (stage !== 'flow' || stepIdx !== 1 || hasGeneratedRef.current) {
      return
    }
    // Why: signed-out Anywhere cannot serve Relay; auto-minting here would show a
    // scannable local-only QR under the Relay label. Wait for sign-in or a switch
    // to Local network (both flip canGenerate and re-run this effect) instead.
    if (!canGenerate) {
      return
    }
    void generatePairing(false)
  }, [stage, stepIdx, canGenerate, generatePairing])

  // Why: entering the flow must mint a fresh pairing token — clear stale QR
  // state so we never flash an expired code from a previous session.
  const enterFlow = (): void => {
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
    setEncodedConnectionMode(null)
    showFirstPairingFlow()
  }

  // Why: from the paired summary, "Pair another device" jumps straight to
  // Step 2 since the app is presumably already installed on the user's phone.
  const pairAnotherDevice = (): void => {
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
    setEncodedConnectionMode(null)
    showPairAnotherDeviceFlow()
  }

  const handleContinue = (): void => {
    if (stepIdx === 0) {
      setStepIdx(1)
    }
  }

  const toggleMobileSidebarButton = useCallback(() => {
    const nextShowMobileButton = !showMobileButton
    void updateSettings({ showMobileButton: nextShowMobileButton })
    if (!nextShowMobileButton) {
      toast.message(
        translate(
          'auto.components.mobile.MobilePageToolbar.e1c7b4a92d',
          'Configure in Settings > Mobile.'
        )
      )
    }
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
      canGeneratePairing={canGenerate}
      handleAddressChange={handleAddressChange}
      handleBack={handleBack}
      handleContinue={handleContinue}
      installQrUrl={installQrUrl}
      iosChannel={iosChannel}
      setIosChannel={setIosChannel}
      loadNetworkInterfaces={() => void loadNetworkInterfaces()}
      networkInterfaces={networkInterfaces}
      openInstallUrl={openInstallUrl}
      pairAnotherDevice={pairAnotherDevice}
      pairLoading={pairLoading}
      connectionMode={connectionMode}
      handleConnectionModeChange={handleConnectionModeChange}
      pairQrDataUrl={pairQrDataUrl}
      pairingUrl={pairingUrl}
      relayDegraded={
        pairQrDataUrl != null &&
        connectionMode === 'automatic' &&
        encodedConnectionMode === 'local-only'
      }
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
