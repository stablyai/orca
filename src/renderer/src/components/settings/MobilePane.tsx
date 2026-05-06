import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, Maximize2, RefreshCw, Trash2, Wifi } from 'lucide-react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { SettingsSearchEntry } from './settings-search'

export const MOBILE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Mobile Pairing',
    description: 'Pair a mobile device by scanning a QR code.',
    keywords: ['mobile', 'qr', 'code', 'pair', 'phone', 'scan']
  },
  {
    title: 'Connected Devices',
    description: 'Manage paired mobile devices.',
    keywords: ['mobile', 'devices', 'revoke', 'paired', 'connected']
  },
  {
    title: 'Network Interface',
    description: 'Choose which network address to use for mobile pairing.',
    keywords: ['network', 'interface', 'tailscale', 'vpn', 'overlay', 'ip', 'address', 'wifi']
  }
]

type PairedDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

type NetworkInterface = {
  name: string
  address: string
}

export function MobilePane(): React.JSX.Element {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [qrEnlarged, setQrEnlarged] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<NetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(undefined)
  const [codeCopied, setCodeCopied] = useState(false)

  const loadDevices = useCallback(async () => {
    try {
      const result = await window.api.mobile.listDevices()
      setDevices(result.devices)
    } catch {
      // Silently fail — device list is non-critical
    }
  }, [])

  const loadNetworkInterfaces = useCallback(async () => {
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      setNetworkInterfaces(result.interfaces)
      if (result.interfaces.length > 0 && !selectedAddress) {
        setSelectedAddress(result.interfaces[0]!.address)
      }
    } catch {
      // Silently fail
    }
  }, [selectedAddress])

  const generateQR = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.mobile.getPairingQR(
        selectedAddress ? { address: selectedAddress } : undefined
      )
      if (result.available) {
        setQrDataUrl(result.qrDataUrl)
        setPairingUrl(result.pairingUrl)
        setEndpoint(result.endpoint)
        setCodeCopied(false)
        void loadDevices()
      } else {
        toast.error('WebSocket transport is not running')
      }
    } catch {
      toast.error('Failed to generate QR code')
    } finally {
      setLoading(false)
    }
  }, [loadDevices, selectedAddress])

  useEffect(() => {
    void loadDevices()
    void loadNetworkInterfaces()
  }, [loadDevices, loadNetworkInterfaces])

  // Why: after generating a QR code the device only appears once the phone
  // actually connects (lastSeenAt > 0). Poll until a new device shows up.
  const [deviceCountAtQr, setDeviceCountAtQr] = useState<number | null>(null)
  useEffect(() => {
    if (!qrDataUrl) {
      setDeviceCountAtQr(null)
      return
    }
    setDeviceCountAtQr(devices.length)
  }, [qrDataUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (deviceCountAtQr === null || devices.length > deviceCountAtQr) {
      return
    }
    const interval = setInterval(() => void loadDevices(), 3000)
    return () => clearInterval(interval)
  }, [deviceCountAtQr, devices.length, loadDevices])

  async function copyPairingCode() {
    if (!pairingUrl) {
      return
    }
    try {
      // Why: Electron renderer's navigator.clipboard fails in some contexts
      // (no transient activation, non-secure context). Use the main-process
      // IPC clipboard which the rest of the app uses everywhere.
      await window.api.ui.writeClipboardText(pairingUrl)
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 2000)
    } catch {
      toast.error('Failed to copy pairing code')
    }
  }

  async function revokeDevice(deviceId: string) {
    try {
      await window.api.mobile.revokeDevice({ deviceId })
      setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId))
      toast.success('Device revoked')
    } catch {
      toast.error('Failed to revoke device')
    }
  }

  function formatInterfaceLabel(iface: NetworkInterface): string {
    return `${iface.address} (${iface.name})`
  }

  return (
    <div className="space-y-6">
      {/* Network interface selector + generate */}
      <div className="rounded-lg border border-border/60 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Wifi className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Network Interface</span>
        </div>
        <p className="text-muted-foreground mb-3 text-xs">
          Choose which network address to advertise in the QR code. Use your LAN address for
          same-network pairing, or an overlay network address (Tailscale, ZeroTier) for
          cross-network access.
        </p>
        <div className="flex items-center gap-3">
          <Select value={selectedAddress} onValueChange={setSelectedAddress}>
            <SelectTrigger size="sm" className="min-w-[220px]">
              <SelectValue placeholder="No interfaces found" />
            </SelectTrigger>
            <SelectContent>
              {networkInterfaces.map((iface) => (
                <SelectItem key={`${iface.name}-${iface.address}`} value={iface.address}>
                  {formatInterfaceLabel(iface)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => void generateQR()}
            disabled={loading || !selectedAddress}
            size="sm"
            className="gap-1.5"
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            {qrDataUrl ? 'Regenerate' : 'Generate QR Code'}
          </Button>
        </div>
      </div>

      {/* QR code display */}
      {qrDataUrl && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border/60 py-6">
          <button
            type="button"
            onClick={() => setQrEnlarged(true)}
            className="group relative cursor-pointer rounded-lg border border-border/60 bg-white p-3"
          >
            <img src={qrDataUrl} alt="QR Code for mobile pairing" className="size-48" />
            <Maximize2 className="absolute top-1.5 right-1.5 size-3 text-black/30 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
          {endpoint && <span className="text-muted-foreground font-mono text-xs">{endpoint}</span>}
          <p className="text-muted-foreground max-w-xs text-center text-xs">
            Scan this code with the Orca mobile app. Each code creates a unique device token.
          </p>
          {pairingUrl && (
            <div className="flex w-full max-w-lg flex-col gap-1.5 px-4">
              <div className="text-muted-foreground text-center text-xs">
                Or paste this code in the mobile app:
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyPairingCode()}
                className="font-mono text-[11px] leading-tight whitespace-normal break-all h-auto py-2 px-3"
              >
                <span className="flex-1 text-left">{pairingUrl}</span>
                {codeCopied ? (
                  <Check className="ml-2 size-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <Copy className="ml-2 size-3.5 shrink-0" />
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Paired devices */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Paired Devices</h3>
        {devices.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {qrDataUrl
              ? 'No devices paired yet. Scan the QR code with the Orca mobile app.'
              : 'No devices paired yet.'}
          </p>
        ) : (
          <div className="space-y-2">
            {devices.map((device) => (
              <div
                key={device.deviceId}
                className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">{device.name}</div>
                  <div className="text-muted-foreground text-xs">
                    Paired {new Date(device.pairedAt).toLocaleDateString()}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void revokeDevice(device.deviceId)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {devices.length > 0 && (
          <p className="text-muted-foreground mt-3 text-xs">
            Revoking a device disconnects it immediately.
          </p>
        )}
      </div>

      {/* Enlarged QR dialog */}
      <Dialog open={qrEnlarged} onOpenChange={setQrEnlarged}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan with Orca Mobile</DialogTitle>
          </DialogHeader>
          {qrDataUrl && (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg bg-white p-4">
                <img src={qrDataUrl} alt="QR Code for mobile pairing" className="size-72" />
              </div>
              {endpoint && (
                <span className="text-muted-foreground font-mono text-xs">{endpoint}</span>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
