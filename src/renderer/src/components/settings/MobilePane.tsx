import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getPairedMobileDevicesSnapshot,
  replacePairedMobileDevices,
  usePairedMobileDevices
} from '../mobile/paired-mobile-devices'
import { useMobilePairingDevicePolling } from './mobile-pairing-device-polling'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'
import { MobilePairingQrSection } from './MobilePairingQrSection'
import { MobilePairedDevicesSection } from './MobilePairedDevicesSection'
import { MobileAutoRestoreFitSection } from './MobileAutoRestoreFitSection'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'
import { MobilePairingSetupSection } from './MobilePairingSetupSection'
import { WindowsFirewallNotice } from '../mobile/WindowsFirewallNotice'
import { translate } from '@/i18n/i18n'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'
import { useMobilePairingConnectionMode } from '../mobile/use-mobile-pairing-connection-mode'
export { getMobilePaneSearchEntries } from './mobile-pane-search'

export function MobilePane(): React.JSX.Element {
  const autoRestoreFitMs = useAppStore((s) => s.settings?.mobileAutoRestoreFitMs ?? null)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  // Mode the displayed QR actually encodes; can be 'local-only' under an
  // Anywhere selection when Relay provisioning degraded server-side.
  const [qrEncodedMode, setQrEncodedMode] = useState<MobilePairingConnectionMode | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [qrEnlarged, setQrEnlarged] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [deviceCountAtQr, setDeviceCountAtQr] = useState<number | null>(null)
  const signedIn = useAppStore((state) => state.orcaProfileAuthStatus?.state === 'connected')
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
  // Latest address without stale-closure risk inside loadNetworkInterfaces.
  const selectedAddressRef = useRef<string | undefined>(selectedAddress)
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
    setPairingUrl(null)
    setQrEncodedMode(null)
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
          const nextAddress = selectRefreshedNetworkAddress(
            selectedAddressRef.current,
            result.interfaces
          )
          if (nextAddress !== selectedAddressRef.current) {
            selectedAddressRef.current = nextAddress
            setSelectedAddress(nextAddress)
            // A refresh moved the active interface; invalidate so a shown QR
            // can't keep encoding the previous endpoint.
            invalidatePairing()
          }
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
    [mountedRef, invalidatePairing]
  )

  const generateQR = useCallback(
    async (opts: { rotate?: boolean } = {}) => {
      // Why: refuse signed-out Anywhere rather than degrading to a local-only QR
      // under the Relay label (canMint is the shared honesty gate).
      if (!canMintMobilePairingOffer({ connectionMode, signedIn })) {
        return
      }
      const requestId = ++pairingRequestIdRef.current
      setLoading(true)
      try {
        const result = await window.api.mobile.getPairingQR({
          ...(selectedAddress ? { address: selectedAddress } : {}),
          // canMint already requires sign-in for Anywhere, so the preferred path
          // is the honest encoded mode.
          connectionMode,
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
            setPairingUrl(result.pairingUrl)
            setQrEncodedMode(result.connectionMode)
            setEndpoint(result.endpoint)
            setDeviceCountAtQr(getPairedMobileDevicesSnapshot().length)
            clearCodeCopiedResetTimer()
            setCodeCopied(false)
            setRotateNextQr(false)
            void loadDevices()
          }
        } else {
          if (mountedRef.current) {
            toast.error(
              translate(
                'auto.components.settings.MobilePane.cb9067c1c1',
                'WebSocket transport is not running'
              )
            )
          }
        }
      } catch {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
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
      // A displayed or in-flight code encodes the old connection policy. The
      // main process rotates on the mode mismatch, so don't arm a second rotate.
      invalidatePairing({ armRotate: false })
    },
    [connectionMode, invalidatePairing, updateSettings, setConnectionMode]
  )

  const handleSelectedAddressChange = useCallback(
    (address: string): void => {
      setSelectedAddress(address)
      selectedAddressRef.current = address
      // Switching endpoints: a shown QR now encodes the old address.
      invalidatePairing()
    },
    [invalidatePairing]
  )

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
        connectionPathControl={
          <MobilePairingConnectionOptions value={connectionMode} onChange={changeConnectionMode} />
        }
        networkInterfaces={networkInterfaces}
        selectedAddress={selectedAddress}
        onSelectedAddressChange={handleSelectedAddressChange}
        refreshingNetworkInterfaces={refreshingNetworkInterfaces}
        onRefreshNetworkInterfaces={() => void loadNetworkInterfaces({ notifyOnError: true })}
        loading={loading}
        hasQrCode={qrDataUrl != null}
        onGenerateQr={() => void generateQR({ rotate: qrDataUrl != null })}
      />

      {qrDataUrl != null && connectionMode === 'automatic' && qrEncodedMode === 'local-only' ? (
        // Why: an Anywhere mint can degrade server-side when Relay provisioning
        // fails; say so instead of letting the Relay label overclaim the code.
        <div
          className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3"
          data-testid="relay-degraded-notice"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.MobilePane.relayDegradedNotice',
              'Relay couldn’t be reached — this code only works on your LAN or Tailscale. Regenerate to try again.'
            )}
          </p>
        </div>
      ) : null}

      <MobilePairingQrSection
        qrDataUrl={qrDataUrl}
        pairingUrl={pairingUrl}
        endpoint={endpoint}
        qrEnlarged={qrEnlarged}
        codeCopied={codeCopied}
        onQrEnlargedChange={setQrEnlarged}
        onCodeCopiedChange={setCodeCopied}
        onClearCodeCopiedTimer={clearCodeCopiedResetTimer}
      />

      <WindowsFirewallNotice pairingReady={qrDataUrl != null} address={selectedAddress} />

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
