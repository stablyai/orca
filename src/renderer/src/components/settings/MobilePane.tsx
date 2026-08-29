import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getPairedMobileDevicesSnapshot,
  replacePairedMobileDevices,
  usePairedMobileDevices
} from '../mobile/paired-mobile-devices'
import { useMobilePairingDevicePolling } from './mobile-pairing-device-polling'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
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
  // Why: monotonically bumped per pairing request so a late getPairingQR
  // response cannot paint a stale QR after sign-out, a mode switch, or an
  // address change invalidated the request that produced it.
  const pairingRequestIdRef = useRef(0)
  // Tracks the mode we last acted on so the connectionMode effect can tell a
  // cross-window preference sync apart from our own path change.
  const handledModeRef = useRef(connectionMode)
  // Ref mirrors of QR-visible / loading so invalidatePairing stays stable and
  // cannot make loadNetworkInterfaces re-fetch on every generate.
  const qrDisplayedRef = useRef(false)
  const loadingRef = useRef(false)
  const mountedRef = useMountedRef()
  const {
    devices,
    loaded: devicesLoaded,
    refresh: refreshDevices
  } = usePairedMobileDevices({ refreshOnMount: false })

  useEffect(() => {
    qrDisplayedRef.current = qrDataUrl != null
  }, [qrDataUrl])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  // Why: an offer encodes a specific policy + endpoint. When the selection that
  // produced it changes, drop any displayed QR and invalidate the in-flight
  // request so a late response can't restore it; arm rotation so the next mint
  // issues a fresh credential rather than the discarded pending one.
  const invalidatePairing = useCallback((opts: { armRotate?: boolean } = {}): void => {
    pairingRequestIdRef.current += 1
    const hadPending = qrDisplayedRef.current || loadingRef.current
    setQrDataUrl(null)
    setQrSize(null)
    setPairingUrl(null)
    setQrError(false)
    setRelayMintFailure(null)
    setEndpoint(null)
    // Why: a superseded in-flight generate no longer clears loading in its
    // finally (the epoch bump skips it), so drop the spinner here or Generate
    // stays disabled forever after a mid-flight path/sign-out/address change.
    loadingRef.current = false
    setLoading(false)
    // armRotate:false for path changes — the main process rotates exactly once
    // when the requested mode differs from the pending token's minted mode, so
    // an extra renderer rotate would only race other windows off the new token.
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

  // Why: a Relay QR minted while signed in must not linger on a now-signed-out
  // desktop — Generate is disabled in that state. Invalidate any pending relay
  // mint too, not just a displayed QR, so a late response can't paint a Relay
  // code after sign-out. Anywhere stays selected.
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
      // Silently fail — device list is non-critical
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
      // Why: refuse signed-out Anywhere rather than degrading to a local-only QR
      // under the Relay label (canMint is the shared honesty gate).
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
        // Why: sign-out, a mode switch, or an address change bump the epoch.
        // A response for a superseded request must not paint a QR that no
        // longer matches the current selection.
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
          } else {
            setRelayMintFailure(null)
            // Why: IPC now forwards reason/guidance for all unavailability paths;
            // prefer that copy over a hard-coded WebSocket-only message.
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
      // Why: remember the path so reopening Settings keeps the user's choice
      // instead of snapping back to the default.
      handledModeRef.current = nextMode
      setConnectionMode(nextMode)
      void updateSettings({ mobilePairingConnectionMode: nextMode })
      // Why: after a Relay mint failure, LAN should mint immediately — including
      // when the renderer has not chosen an address yet (main picks the default).
      const shouldRecoverWithLan = relayMintFailure != null && nextMode === 'local-only'
      // A displayed or in-flight code encodes the old connection policy. The
      // main process rotates on the mode mismatch, so don't arm a second rotate.
      invalidatePairing({ armRotate: false })
      // Why: switching to LAN after a Relay failure should mint immediately.
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

  // Why: another window can persist a different path; the shared hook syncs
  // connectionMode here without routing through changeConnectionMode. Treat
  // that external change like a user path change so a QR for the old policy
  // can't linger. No updateSettings call here — avoids a cross-window loop.
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

  // Why: another surface (e.g. the sidebar) may have already populated the
  // shared cache; only fetch on mount when it hasn't loaded yet.
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

  async function revokeDevice(deviceId: string) {
    try {
      const { revoked } = await window.api.mobile.revokeDevice({ deviceId })
      // Why: the backend can resolve revoked=false without removing the device;
      // surface that as an error instead of a false "Device revoked".
      if (!revoked) {
        throw new Error('mobile.revokeDevice returned revoked=false')
      }
      try {
        // Why: the backend may have learned about another phone while Settings
        // was open, so refresh from source-of-truth after mutating it.
        await refreshDevices({ force: true })
      } catch (err) {
        console.error('mobile.listDevices failed after revoke', err)
        const nextDevices = getPairedMobileDevicesSnapshot().filter((d) => d.deviceId !== deviceId)
        replacePairedMobileDevices(nextDevices)
      }
      if (mountedRef.current) {
        toast.success(translate('auto.components.settings.MobilePane.2e3dd0bc29', 'Device revoked'))
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate('auto.components.settings.MobilePane.870e1b5ca5', 'Failed to revoke device')
        )
      }
    }
  }

  return (
    <div className="space-y-6">
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
