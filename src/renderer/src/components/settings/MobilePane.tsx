import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getPairedMobileDevicesSnapshot,
  usePairedMobileDevices
} from '../mobile/paired-mobile-devices'
import { useMobilePairingDevicePolling } from './mobile-pairing-device-polling'
import { useMobilePairedDeviceRevocation } from './use-mobile-paired-device-revocation'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import { MachineNameField } from './MachineNameField'
import { MobilePairingQrSection } from './MobilePairingQrSection'
import { MobilePairedDevicesSection } from './MobilePairedDevicesSection'
import { MobileAutoRestoreFitSection } from './MobileAutoRestoreFitSection'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'
import { MobilePairingSetupSection } from './MobilePairingSetupSection'
import { MobileRelayMintFailureNotice } from '../mobile/mobile-relay-mint-failure-notice'
import { WindowsFirewallNotice } from '../mobile/WindowsFirewallNotice'
import { translate } from '@/i18n/i18n'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'
import { useMobilePairingConnectionMode } from '../mobile/use-mobile-pairing-connection-mode'
import { useMobilePairingAddressPreference } from '../mobile/use-mobile-pairing-address-preference'
import { shouldOpenMobilePairingAddress } from './mobile-pane-search'
export { getMobilePaneSearchEntries } from './mobile-pane-search'

export function MobilePane(): React.JSX.Element {
  const autoRestoreFitMs = useAppStore((s) => s.settings?.mobileAutoRestoreFitMs ?? null)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrSize, setQrSize] = useState<number | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)
  const [relayMintFailure, setRelayMintFailure] = useState<MobileRelayMintFailure | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [qrEnlarged, setQrEnlarged] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [deviceCountAtQr, setDeviceCountAtQr] = useState<number | null>(null)
  const signedIn = useAppStore((state) => state.orcaProfileAuthStatus?.state === 'connected')
  const settingsSearchQuery = useAppStore((state) => state.settingsSearchQuery)
  const [connectionMode, setConnectionMode] = useMobilePairingConnectionMode()
  const [rotateNextQr, setRotateNextQr] = useState(false)
  const codeCopiedResetTimerRef = useRef<number | null>(null)
  const wasSignedInRef = useRef(signedIn)
  // Invalidate late pairing responses after sign-out, mode or address changes.
  const pairingRequestIdRef = useRef(0)
  // Distinguish cross-window mode sync from this window’s own changes.
  const handledModeRef = useRef(connectionMode)
  // Keep invalidatePairing stable so QR/loading changes cannot refetch network interfaces.
  const qrDisplayedRef = useRef(false)
  const loadingRef = useRef(false)
  const mountedRef = useMountedRef()
  const {
    devices,
    loaded: devicesLoaded,
    refresh: refreshDevices
  } = usePairedMobileDevices({ refreshOnMount: false })
  const revokeDevice = useMobilePairedDeviceRevocation(refreshDevices)

  useEffect(() => {
    qrDisplayedRef.current = qrDataUrl != null
  }, [qrDataUrl])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  // Policy/endpoint changes invalidate displayed and pending offers; rotate the next credential instead of reusing the discarded one.
  const invalidatePairing = useCallback((opts: { armRotate?: boolean } = {}): void => {
    pairingRequestIdRef.current += 1
    const hadPending = qrDisplayedRef.current || loadingRef.current
    setQrDataUrl(null)
    setQrSize(null)
    setPairingUrl(null)
    setQrError(false)
    setRelayMintFailure(null)
    setEndpoint(null)
    // Superseded finally handlers skip loading cleanup; release the spinner here so Generate cannot remain disabled.
    loadingRef.current = false
    setLoading(false)
    // Main rotates on mode mismatch; extra renderer rotation would race other windows off the fresh token.
    if (hadPending && opts.armRotate !== false) {
      setRotateNextQr(true)
    }
  }, [])
  const invalidatePairingAddress = useCallback(() => invalidatePairing(), [invalidatePairing])
  const {
    selectedAddress,
    selectedAddressIsCustom,
    customAddresses,
    selectAddress: handleSelectedAddressChange,
    selectCustomAddress: handleCustomAddressSelect,
    removeCustomAddress: handleCustomAddressRemove,
    selectAddressAfterRefresh
  } = useMobilePairingAddressPreference({
    networkInterfaces,
    onSelectionInvalidated: invalidatePairingAddress
  })

  // Invalidate displayed/pending Relay codes after sign-out while retaining Anywhere selection.
  useEffect(() => {
    const wasSignedIn = wasSignedInRef.current
    wasSignedInRef.current = signedIn
    if (wasSignedIn && !signedIn && connectionMode === 'automatic') {
      invalidatePairing()
    }
  }, [signedIn, connectionMode, invalidatePairing])

  const clearCodeCopiedResetTimer = useCallback((): void => {
    if (codeCopiedResetTimerRef.current !== null) {
      window.clearTimeout(codeCopiedResetTimerRef.current)
      codeCopiedResetTimerRef.current = null
    }
  }, [])

  const loadDevices = useCallback(async () => {
    try {
      await refreshDevices()
    } catch {
      // Device-list failure must not block pairing.
    }
  }, [refreshDevices])

  const loadNetworkInterfaces = useCallback(
    async (opts: { notifyOnError?: boolean } = {}) => {
      setRefreshingNetworkInterfaces(true)
      try {
        const result = await window.api.mobile.listNetworkInterfaces()
        if (mountedRef.current) {
          setNetworkInterfaces(result.interfaces)
          selectAddressAfterRefresh(result.interfaces)
        }
      } catch {
        if (opts.notifyOnError && mountedRef.current) {
          toast.error(
            translate(
              'auto.components.settings.MobilePane.d714614dbf',
              'Failed to refresh network interfaces'
            )
          )
        }
      } finally {
        if (mountedRef.current) {
          setRefreshingNetworkInterfaces(false)
        }
      }
    },
    [mountedRef, selectAddressAfterRefresh]
  )

  const generateQR = useCallback(
    async (
      opts: {
        rotate?: boolean
        connectionModeOverride?: MobilePairingConnectionMode
      } = {}
    ) => {
      const preferredMode = opts.connectionModeOverride ?? connectionMode
      // Refuse signed-out Anywhere; never disguise a LAN-only QR under the Relay label.
      if (!canMintMobilePairingOffer({ connectionMode: preferredMode, signedIn })) {
        return
      }
      const requestId = ++pairingRequestIdRef.current
      setLoading(true)
      setQrError(false)
      try {
        const result = await window.api.mobile.getPairingQR({
          ...(selectedAddress ? { address: selectedAddress } : {}),
          connectionMode: preferredMode,
          ...(opts.rotate || rotateNextQr ? { rotate: true } : {})
        })
        // Ignore superseded responses whose policy/address selection is no longer current.
        if (requestId !== pairingRequestIdRef.current) {
          return
        }
        if (result.available) {
          useAppStore.getState().recordFeatureInteraction('mobile-pairing')
          if (mountedRef.current) {
            setQrDataUrl(result.qrDataUrl)
            setQrSize(result.qrSize)
            setPairingUrl(result.pairingUrl)
            setQrError(result.qrDataUrl === null)
            setRelayMintFailure(null)
            setEndpoint(result.endpoint)
            setDeviceCountAtQr(getPairedMobileDevicesSnapshot().length)
            clearCodeCopiedResetTimer()
            setCodeCopied(false)
            setRotateNextQr(false)
            void loadDevices()
          }
        } else if (mountedRef.current) {
          setQrDataUrl(null)
          setQrSize(null)
          setPairingUrl(null)
          setQrError(false)
          setEndpoint(null)
          if (result.reason === 'relay_mint_failed' && result.relayFailure) {
            setRelayMintFailure(result.relayFailure)
            // Reread likely revoked auth so guidance can offer sign-in rather than futile retries.
            void useAppStore.getState().fetchOrcaProfileAuthStatus()
          } else {
            setRelayMintFailure(null)
            // Prefer host-provided guidance across all unavailable paths.
            toast.error(
              result.guidance ??
                translate(
                  'auto.components.settings.MobilePane.cb9067c1c1',
                  'WebSocket transport is not running'
                )
            )
          }
        }
      } catch {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          setRelayMintFailure(null)
          toast.error(
            translate(
              'auto.components.settings.MobilePane.e3c427e020',
              'Failed to generate QR code'
            )
          )
        }
      } finally {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [
      clearCodeCopiedResetTimer,
      connectionMode,
      loadDevices,
      mountedRef,
      rotateNextQr,
      selectedAddress,
      signedIn
    ]
  )

  const changeConnectionMode = useCallback(
    (nextMode: MobilePairingConnectionMode) => {
      if (nextMode === connectionMode) {
        return
      }
      handledModeRef.current = nextMode
      setConnectionMode(nextMode)
      void updateSettings({ mobilePairingConnectionMode: nextMode })
      // Recover Relay failures through immediate LAN minting; main can choose the default address.
      const shouldRecoverWithLan = relayMintFailure != null && nextMode === 'local-only'
      // Main rotates old-policy codes on mode mismatch; avoid arming a duplicate rotate.
      invalidatePairing({ armRotate: false })
      if (
        shouldRecoverWithLan &&
        canMintMobilePairingOffer({ connectionMode: nextMode, signedIn })
      ) {
        void generateQR({ rotate: false, connectionModeOverride: 'local-only' })
      }
    },
    [
      connectionMode,
      generateQR,
      invalidatePairing,
      relayMintFailure,
      signedIn,
      updateSettings,
      setConnectionMode
    ]
  )

  const copyRelayDiagnostics = useCallback(async (): Promise<void> => {
    if (relayMintFailure == null) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(
        JSON.stringify(
          {
            kind: 'mobile_pairing_relay_failure',
            preferredConnectionMode: connectionMode,
            failure: relayMintFailure,
            selectedAddress: selectedAddress ?? null,
            at: new Date().toISOString()
          },
          null,
          2
        )
      )
      if (mountedRef.current) {
        toast.success(
          translate('auto.components.settings.MobilePane.diagnosticsCopied', 'Diagnostics copied')
        )
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.settings.MobilePane.diagnosticsCopyFailed',
            'Failed to copy diagnostics'
          )
        )
      }
    }
  }, [connectionMode, mountedRef, relayMintFailure, selectedAddress])

  // Invalidate cross-window mode changes without writing settings back and creating a sync loop.
  useEffect(() => {
    if (connectionMode === handledModeRef.current) {
      return
    }
    handledModeRef.current = connectionMode
    invalidatePairing({ armRotate: false })
  }, [connectionMode, invalidatePairing])

  useEffect(() => {
    void loadNetworkInterfaces()
  }, [loadNetworkInterfaces])

  // Other surfaces share the device cache; fetch only when it has not loaded.
  useEffect(() => {
    if (!devicesLoaded) {
      void loadDevices()
    }
  }, [devicesLoaded, loadDevices])

  useMobilePairingDevicePolling({
    deviceCountAtQr,
    currentDeviceCount: devices.length,
    loadDevices
  })

  return (
    <div className="space-y-6">
      <MachineNameField id="mobile-machine-name" />

      <MobilePairingSetupSection
        connectionMode={connectionMode}
        canGenerate={canMintMobilePairingOffer({ connectionMode, signedIn })}
        addressDisclosureForcedOpen={shouldOpenMobilePairingAddress(settingsSearchQuery)}
        connectionPathControl={
          <MobilePairingConnectionOptions
            value={connectionMode}
            onChange={changeConnectionMode}
            relayMintFailed={relayMintFailure != null && connectionMode === 'automatic'}
            relayMintRetrying={
              relayMintFailure != null && connectionMode === 'automatic' && loading
            }
          />
        }
        networkInterfaces={networkInterfaces}
        customAddresses={customAddresses}
        selectedAddress={selectedAddress}
        selectedAddressIsCustom={selectedAddressIsCustom}
        onSelectedAddressChange={handleSelectedAddressChange}
        onCustomAddressSelect={handleCustomAddressSelect}
        onCustomAddressRemove={handleCustomAddressRemove}
        refreshingNetworkInterfaces={refreshingNetworkInterfaces}
        onRefreshNetworkInterfaces={() => void loadNetworkInterfaces({ notifyOnError: true })}
        loading={loading}
        hasQrCode={qrDataUrl != null}
        showGenerateAction={relayMintFailure == null}
        onGenerateQr={() => void generateQR({ rotate: qrDataUrl != null })}
      />

      {relayMintFailure != null && connectionMode === 'automatic' ? (
        <MobileRelayMintFailureNotice
          failure={relayMintFailure}
          onUseLan={() => changeConnectionMode('local-only')}
          onRetry={() => void generateQR({ rotate: true })}
          onCopyDiagnostics={() => void copyRelayDiagnostics()}
          busy={loading}
        />
      ) : null}

      <span className="sr-only" role="status" aria-live="polite">
        {pairingUrl != null && !loading
          ? translate('auto.components.settings.MobilePane.pairingCodeReady', 'Pairing code ready')
          : ''}
      </span>

      <MobilePairingQrSection
        qrDataUrl={qrDataUrl}
        qrSize={qrSize}
        qrError={qrError}
        pairingUrl={pairingUrl}
        endpoint={endpoint}
        qrEnlarged={qrEnlarged}
        codeCopied={codeCopied}
        onQrEnlargedChange={setQrEnlarged}
        onCodeCopiedChange={setCodeCopied}
        onClearCodeCopiedTimer={clearCodeCopiedResetTimer}
      />

      <WindowsFirewallNotice
        pairingReady={pairingUrl != null}
        address={selectedAddress}
        usingRelay={connectionMode === 'automatic'}
      />

      <MobilePairedDevicesSection
        devices={devices}
        hasQrCode={qrDataUrl != null}
        onRevokeDevice={(deviceId) => void revokeDevice(deviceId)}
      />

      <MobileAutoRestoreFitSection
        autoRestoreFitMs={autoRestoreFitMs}
        onAutoRestoreFitChange={(ms) => void updateSettings({ mobileAutoRestoreFitMs: ms })}
      />
    </div>
  )
}
