import {
  mobilePairingPathOptions,
  mobilePairingPathSettings,
  type MobilePairingPath
} from '../../../../shared/mobile-pairing-path'
import { useMobileRelayAuthorization } from './use-mobile-relay-status'
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
import { canMintMobilePairingOffer } from '../../../../shared/mobile-pairing-connection-mode'
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
  const [pairQrSize, setPairQrSize] = useState<number | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairingQrError, setPairingQrError] = useState(false)
  const [relayMintFailure, setRelayMintFailure] = useState<MobileRelayMintFailure | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const refreshAuthStatus = useAppStore((state) => state.fetchOrcaProfileAuthStatus)
  const [connectionMode, setConnectionMode] = useMobilePairingConnectionMode()
  const { relayAuthorized, configurationId } = useMobileRelayAuthorization(connectionMode)
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
  // Why: each flow entry starts its own address lookup. Gating the Step 2 mint on
  // "has this visit's lookup settled" is false until it answers, where "is a lookup
  // running" cannot tell overlapping lookups apart and clears on the first to land.
  const [pairingFlowVisit, setPairingFlowVisit] = useState(0)
  const [addressedFlowVisit, setAddressedFlowVisit] = useState<number | null>(null)
  const pairingAddressSettled = addressedFlowVisit === pairingFlowVisit
  const networkInterfacesRequestIdRef = useRef(0)
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
  const { copyInstallUrl, openAndroidInstallGuide, openInstallUrl } = useMobileInstallActions(
    platform,
    iosChannel
  )

  const { generatePairing } = useMobilePairingGeneration({
    connectionMode,
    relayAuthorized,
    selectedAddress,
    mountedRef,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairQrSize,
    setPairingUrl,
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure,
    refreshAuthStatus
  })
  useLayoutEffect(() => {
    pairingAddressChangeRef.current = ({ address, source }) => {
      const pairingContext = { connectionMode, relayAuthorized }
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
      setPairQrSize(null)
      setPairingUrl(null)
      setPairingQrError(false)
      setRelayMintFailure(null)
      setPairLoading(false)
      if (shouldRegenerate && canMintMobilePairingOffer(pairingContext)) {
        void generatePairing(true, address ?? '')
      }
    }
  }, [connectionMode, generatePairing, pairLoading, relayAuthorized])

  const handleConnectionModeChange = useCallback(
    (nextMode: MobilePairingPath): void => {
      if (nextMode === connectionMode) {
        return
      }
      // Why: persist the pick and update local state. The QR invalidation +
      // rotate-regenerate is handled centrally by useMobilePairingQrInvalidation
      // (below), which also covers cross-window preference syncs.
      setRelayMintFailure(null)
      setConnectionMode(nextMode)
      void updateSettings(mobilePairingPathSettings(nextMode))
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
    configurationId,
    relayAuthorized,
    pairLoading,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairQrSize,
    setPairingUrl,
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure,
    regenerate: (mode, opts) => void generatePairing(opts.rotate, undefined, mode)
  })

  const loadNetworkInterfaces = useCallback(async () => {
    const requestId = ++networkInterfacesRequestIdRef.current
    const visit = pairingFlowVisit
    if (mountedRef.current) {
      setRefreshingNetworkInterfaces(true)
    }
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      // Why: a superseded lookup must not move the selection a newer one already
      // resolved — that address change remints over the offer just advertised.
      if (mountedRef.current && requestId === networkInterfacesRequestIdRef.current) {
        setNetworkInterfaces(result.interfaces)
        selectAddressAfterRefresh(result.interfaces)
      }
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      // Why: only the newest lookup may report a completion — a superseded one
      // marking its visit addressed releases the mint against an address its own
      // replacement is about to change. Plain assignment is safe because entering
      // a flow bumps the visit and starts its own lookup, so the newest request
      // always carries the highest visit.
      if (mountedRef.current && requestId === networkInterfacesRequestIdRef.current) {
        setAddressedFlowVisit(visit)
        setRefreshingNetworkInterfaces(false)
      }
    }
  }, [mountedRef, pairingFlowVisit, selectAddressAfterRefresh])

  useEffect(() => {
    if (stage !== 'flow') {
      return
    }
    void loadNetworkInterfaces()
  }, [stage, loadNetworkInterfaces])

  const beforeCustomAddressChange = useCallback(
    async (address: string): Promise<boolean> => {
      if (!canMintMobilePairingOffer({ connectionMode, relayAuthorized })) {
        return true
      }
      try {
        const result = await window.api.mobile.getPairingQR({
          address,
          ...mobilePairingPathOptions(connectionMode)
        })
        return result.available && result.qrDataUrl !== null
      } catch {
        return false
      }
    },
    [connectionMode, relayAuthorized]
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
  const canGenerate = canMintMobilePairingOffer({ connectionMode, relayAuthorized })
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
    // Why: entering Step 2 also starts this visit's address lookup, and minting
    // before it settles advertises an address the lookup is about to replace — the
    // replacement then rotates away the credential this mint just created, so one
    // Continue runs two overlapping offers through main for one pending token.
    if (!pairingAddressSettled) {
      return
    }
    void generatePairing(false)
  }, [stage, stepIdx, canGenerate, generatePairing, pairingAddressSettled])

  // Why: entering the flow must mint a fresh pairing token — clear stale QR
  // state so we never flash an expired code from a previous session.
  const beginPairingVisit = (): void => {
    pairingRequestIdRef.current += 1
    setPairLoading(false)
    setPairingFlowVisit((visit) => visit + 1)
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairQrSize(null)
    setPairingUrl(null)
    setPairingQrError(false)
    setRelayMintFailure(null)
  }

  const enterFlow = (): void => {
    beginPairingVisit()
    showFirstPairingFlow()
  }

  // Why: from the paired summary, "Pair another device" jumps straight to
  // Step 2 since the app is presumably already installed on the user's phone.
  const pairAnotherDevice = (): void => {
    beginPairingVisit()
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

  // Why: while the deferred first mint waits on the address, Step 2 would
  // otherwise read "Generate a pairing code to continue" — a prompt for work it
  // is already about to do on the user's behalf. Kept separate from pairLoading:
  // that one feeds the invalidation hook's shouldRegenerate, so folding this into
  // it would let a mode switch mint before the address settles.
  const awaitingPairingAddress =
    stage === 'flow' && stepIdx === 1 && canGenerate && !pairingAddressSettled

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
      openAndroidInstallGuide={openAndroidInstallGuide}
      openInstallUrl={openInstallUrl}
      pairAnotherDevice={pairAnotherDevice}
      pairLoading={pairLoading || awaitingPairingAddress}
      connectionMode={connectionMode}
      handleConnectionModeChange={handleConnectionModeChange}
      pairQrDataUrl={pairQrDataUrl}
      pairQrSize={pairQrSize}
      pairingUrl={pairingUrl}
      pairingQrError={pairingQrError}
      relayMintFailure={
        connectionMode !== 'local-only' && pairQrDataUrl == null ? relayMintFailure : null
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
