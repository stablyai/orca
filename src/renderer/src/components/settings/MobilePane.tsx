import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useMobilePairingDevicePolling } from './mobile-pairing-device-polling'
import {
  selectRefreshedConnectionAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'
import { MobileNetworkInterfaceSection } from './MobileNetworkInterfaceSection'
import { MobilePairingQrSection } from './MobilePairingQrSection'
import { MobilePairedDevicesSection, type PairedDevice } from './MobilePairedDevicesSection'
import { MobileAutoRestoreFitSection } from './MobileAutoRestoreFitSection'
import { translate } from '@/i18n/i18n'
export { getMobilePaneSearchEntries } from './mobile-pane-search'

export function MobilePane(): React.JSX.Element {
  const autoRestoreFitMs = useAppStore((s) => s.settings?.mobileAutoRestoreFitMs ?? null)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [qrEnlarged, setQrEnlarged] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [connectionAddress, setConnectionAddress] = useState('')
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [deviceCountAtQr, setDeviceCountAtQr] = useState<number | null>(null)
  const devicesRef = useRef<PairedDevice[]>([])
  const connectionAddressRef = useRef('')
  const networkInterfacesRef = useRef<MobileNetworkInterface[]>([])
  const codeCopiedResetTimerRef = useRef<number | null>(null)
  const pairingRequestIdRef = useRef(0)
  const mountedRef = useMountedRef()

  const clearCodeCopiedResetTimer = useCallback((): void => {
    if (codeCopiedResetTimerRef.current !== null) {
      window.clearTimeout(codeCopiedResetTimerRef.current)
      codeCopiedResetTimerRef.current = null
    }
  }, [])

  const clearPairingOffer = useCallback((): void => {
    pairingRequestIdRef.current += 1
    setQrDataUrl(null)
    setPairingUrl(null)
    setEndpoint(null)
    setLoading(false)
    setDeviceCountAtQr(null)
    clearCodeCopiedResetTimer()
    setCodeCopied(false)
  }, [clearCodeCopiedResetTimer])

  const updateConnectionAddress = useCallback(
    (address: string): void => {
      if (address !== connectionAddressRef.current) {
        clearPairingOffer()
      }
      connectionAddressRef.current = address
      setConnectionAddress(address)
    },
    [clearPairingOffer]
  )

  const loadDevices = useCallback(async () => {
    try {
      const result = await window.api.mobile.listDevices()
      if (mountedRef.current) {
        devicesRef.current = result.devices
        setDevices(result.devices)
      }
    } catch {
      // Silently fail — device list is non-critical
    }
  }, [mountedRef])

  const loadNetworkInterfaces = useCallback(
    async (opts: { notifyOnError?: boolean } = {}) => {
      setRefreshingNetworkInterfaces(true)
      try {
        const result = await window.api.mobile.listNetworkInterfaces()
        const previousInterfaces = networkInterfacesRef.current
        if (mountedRef.current) {
          networkInterfacesRef.current = result.interfaces
          setNetworkInterfaces(result.interfaces)
          updateConnectionAddress(
            selectRefreshedConnectionAddress({
              currentAddress: connectionAddressRef.current,
              previousInterfaces,
              nextInterfaces: result.interfaces
            }) ?? ''
          )
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
    [mountedRef, updateConnectionAddress]
  )

  const generateQR = useCallback(
    async (opts: { rotate?: boolean } = {}) => {
      const requestId = ++pairingRequestIdRef.current
      setLoading(true)
      try {
        const address = connectionAddressRef.current.trim()
        const result = await window.api.mobile.getPairingQR({
          ...(address ? { address } : {}),
          ...(opts.rotate ? { rotate: true } : {})
        })
        if (!mountedRef.current || pairingRequestIdRef.current !== requestId) {
          return
        }
        if (result.available) {
          useAppStore.getState().recordFeatureInteraction('mobile-pairing')
          setQrDataUrl(result.qrDataUrl)
          setPairingUrl(result.pairingUrl)
          setEndpoint(result.endpoint)
          setDeviceCountAtQr(devicesRef.current.length)
          clearCodeCopiedResetTimer()
          setCodeCopied(false)
          void loadDevices()
        } else {
          toast.error(
            translate(
              'auto.components.settings.MobilePane.cb9067c1c1',
              'WebSocket transport is not running'
            )
          )
        }
      } catch {
        if (mountedRef.current && pairingRequestIdRef.current === requestId) {
          toast.error(
            translate(
              'auto.components.settings.MobilePane.e3c427e020',
              'Failed to generate QR code'
            )
          )
        }
      } finally {
        if (mountedRef.current && pairingRequestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    },
    [clearCodeCopiedResetTimer, loadDevices, mountedRef]
  )

  useEffect(() => {
    void loadDevices()
    void loadNetworkInterfaces()
  }, [loadDevices, loadNetworkInterfaces])

  useMobilePairingDevicePolling({
    deviceCountAtQr,
    currentDeviceCount: devices.length,
    loadDevices
  })

  async function revokeDevice(deviceId: string) {
    try {
      await window.api.mobile.revokeDevice({ deviceId })
      if (mountedRef.current) {
        setDevices((prev) => {
          const nextDevices = prev.filter((d) => d.deviceId !== deviceId)
          devicesRef.current = nextDevices
          return nextDevices
        })
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
      <MobileNetworkInterfaceSection
        networkInterfaces={networkInterfaces}
        connectionAddress={connectionAddress}
        onConnectionAddressChange={updateConnectionAddress}
        refreshingNetworkInterfaces={refreshingNetworkInterfaces}
        onRefreshNetworkInterfaces={() => void loadNetworkInterfaces({ notifyOnError: true })}
        loading={loading}
        hasQrCode={qrDataUrl != null}
        onGenerateQr={() => void generateQR({ rotate: qrDataUrl != null })}
      />

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
