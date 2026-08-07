import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { Platform, StepIndex } from './MobileHero'
import type { IosChannel } from './mobile-platform-copy'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'
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
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'
import {
  type MobilePairingAddressChange,
  useMobilePairingAddressPreference
} from './use-mobile-pairing-address-preference'

export default function MobilePage(): React.JSX.Element {
  const [stepIdx, setStepIdx] = useState<StepIndex>(0)

  const [platform, setPlatform] = useState<Platform>('ios')
  // Default iOS users to the preview track — it ships daily, so newcomers land
  // on the freshest build unless they deliberately pick the public release.
  const [iosChannel, setIosChannel] = useState<IosChannel>('preview')

  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairingQrError, setPairingQrError] = useState(false)
  const [relayMintFailure, setRelayMintFailure] = useState<MobileRelayMintFailure | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const signedIn = useAppStore((state) => state.orcaProfileAuthStatus?.state === 'connected')
  const [connectionMode, setConnectionMode] = useMobilePairingConnectionMode()
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const pairingAddressChangeRef = useRef<(change: MobilePairingAddressChange) => void>(() => {})
  const notifyPairingAddressChange = useCallback(
    (change: MobilePairingAddressChange): void => pairingAddressChangeRef.current(change),
    []
  )
  const {
    selectedAddress,
    selectedAddressIsCustom,
    customAddresses,
    selectAddress: handleAddressChange,
    selectCustomAddress: handleCustomAddressSelect,
    removeCustomAddress: handleCustomAddressRemove,
    selectAddressAfterRefresh
  } = useMobilePairingAddressPreference({
    networkInterfaces,
    onSelectionInvalidated: notifyPairingAddressChange
  })
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
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure
  })
  useLayoutEffect(() => {
    pairingAddressChangeRef.current = ({ address, source }) => {
      const pairingContext = { connectionMode, signedIn }
      if (source === 'user') {
        if (canMintMobilePairingOffer(pairingContext)) {
          void generatePairing(true, address ?? '')
        }
        return
      }
      if (source === 'refresh') {
        if (hasGeneratedRef.current && canMintMobilePairingOffer(pairingContext)) {
          void generatePairing(true, address)
        }
        return
      }
      const shouldRegenerate = hasGeneratedRef.current || pairLoading
      pairingRequestIdRef.current += 1
      hasGeneratedRef.current = false
      setPairQrDataUrl(null)
      setPairingUrl(null)
      setPairingQrError(false)
      setRelayMintFailure(null)
      setPairLoading(false)
      if (shouldRegenerate && canMintMobilePairingOffer(pairingContext)) {
        void generatePairing(true, address ?? '')
      }
    }
  }, [connectionMode, generatePairing, pairLoading, signedIn])

  const handleConnectionModeChange = useCallback(
    (nextMode: MobilePairingConnectionMode): void => {
      if (nextMode === connectionMode) {
        return
      }
      // Why: persist the pick and update local state. The QR invalidation +
      // rotate-regenerate is handled centrally by useMobilePairingQrInvalidation
      // (below), which also covers cross-window preference syncs.
      setRelayMintFailure(null)
      setConnectionMode(nextMode)
      void updateSettings({ mobilePairingConnectionMode: nextMode })
    },
    [connectionMode, updateSettings, setConnectionMode]
  )

  const copyRelayDiagnostics = useCallback(async (): Promise<void> => {
    if (relayMintFailure == null) {
      return
    }
    // Why: users share this payload — the selected address would leak a LAN/Tailscale IP or hostname.
    const payload = {
      kind: 'mobile_pairing_relay_failure',
      preferredConnectionMode: connectionMode,
      failure: relayMintFailure,
      at: new Date().toISOString()
    }
    try {
      await window.api.ui.writeClipboardText(JSON.stringify(payload, null, 2))
      if (mountedRef.current) {
        toast.success(
          translate('auto.components.mobile.MobilePage.diagnosticsCopied', 'Diagnostics copied')
        )
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.mobile.MobilePage.diagnosticsCopyFailed',
            'Failed to copy diagnostics'
          )
        )
      }
    }
  }, [connectionMode, mountedRef, relayMintFailure])

  useMobilePairingQrInvalidation({
    connectionMode,
    signedIn,
    pairLoading,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairingUrl,
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure,
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
        selectAddressAfterRefresh(result.interfaces)
      }
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      if (mountedRef.current) {
        setRefreshingNetworkInterfaces(false)
      }
    }
  }, [mountedRef, selectAddressAfterRefresh])

  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    void loadNetworkInterfaces()
  }, [stage, loadNetworkInterfaces])

  const beforeCustomAddressChange = useCallback(
    async (address: string): Promise<boolean> => {
      if (!canMintMobilePairingOffer({ connectionMode, signedIn })) {
        return true
      }
      try {
        const result = await window.api.mobile.getPairingQR({ address, connectionMode })
        return result.available && result.qrDataUrl !== null
      } catch {
        return false
      }
    },
    [connectionMode, signedIn]
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
    // to LAN (both flip canGenerate and re-run this effect) instead.
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
    setPairingQrError(false)
    setRelayMintFailure(null)
    showFirstPairingFlow()
  }

  // Why: from the paired summary, "Pair another device" jumps straight to
  // Step 2 since the app is presumably already installed on the user's phone.
  const pairAnotherDevice = (): void => {
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
    setPairingQrError(false)
    setRelayMintFailure(null)
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
      customAddresses={customAddresses}
      selectedAddressIsCustom={selectedAddressIsCustom}
      onCustomAddressSelect={handleCustomAddressSelect}
      onCustomAddressRemove={handleCustomAddressRemove}
      beforeCustomAddressChange={beforeCustomAddressChange}
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
      pairingQrError={pairingQrError}
      relayMintFailure={
        connectionMode === 'automatic' && pairQrDataUrl == null ? relayMintFailure : null
      }
      onUseLan={() => handleConnectionModeChange('local-only')}
      onRetryRelay={() => void generatePairing(true)}
      onCopyRelayDiagnostics={() => void copyRelayDiagnostics()}
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
