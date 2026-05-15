import { Check, Copy, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

const LOOPBACK_ADDRESS = '127.0.0.1'

// Why: runtime pairing tokens stay valid in the main-process registry; keep the
// last displayed URL across settings collapse/navigation without less-protected storage.
const runtimePairingUrlCache: {
  selectedAddress: string
  customAddress: string
  runtimePairingUrl: string | null
  webClientUrl: string | null
} = {
  selectedAddress: LOOPBACK_ADDRESS,
  customAddress: '',
  runtimePairingUrl: null,
  webClientUrl: null
}

function GeneratedUrlRow({
  label,
  value,
  copied,
  onCopy
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

type RuntimePairingUrlGeneratorProps = {
  framed?: boolean
  showHeader?: boolean
}

export function RuntimePairingUrlGenerator({
  framed = true,
  showHeader = true
}: RuntimePairingUrlGeneratorProps): React.JSX.Element {
  const [networkInterfaces, setNetworkInterfaces] = useState<{ name: string; address: string }[]>(
    []
  )
  const [selectedAddress, setSelectedAddress] = useState(runtimePairingUrlCache.selectedAddress)
  const [customAddress, setCustomAddress] = useState(runtimePairingUrlCache.customAddress)
  const [runtimePairingUrl, setRuntimePairingUrl] = useState<string | null>(
    runtimePairingUrlCache.runtimePairingUrl
  )
  const [webClientUrl, setWebClientUrl] = useState<string | null>(
    runtimePairingUrlCache.webClientUrl
  )
  const [copiedTarget, setCopiedTarget] = useState<'web' | 'pairing' | null>(null)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)

  useEffect(() => {
    let stale = false

    const loadNetworkInterfaces = async (): Promise<void> => {
      try {
        const result = await window.api.mobile.listNetworkInterfaces()
        if (!stale) {
          setNetworkInterfaces(result.interfaces)
        }
      } catch {
        // Keep the loopback option available even if interface enumeration fails.
      }
    }

    void loadNetworkInterfaces()

    return () => {
      stale = true
    }
  }, [])

  const generateRuntimePairingUrl = async (): Promise<void> => {
    setIsGeneratingPairing(true)
    try {
      const advertiseAddress = customAddress.trim() || selectedAddress
      const result = await window.api.mobile.getRuntimePairingUrl({
        address: advertiseAddress,
        rotate: true
      })
      if (!result.available) {
        runtimePairingUrlCache.runtimePairingUrl = null
        runtimePairingUrlCache.webClientUrl = null
        setRuntimePairingUrl(null)
        setWebClientUrl(null)
        toast.error('Runtime pairing is unavailable.')
        return
      }
      runtimePairingUrlCache.runtimePairingUrl = result.pairingUrl
      runtimePairingUrlCache.webClientUrl = result.webClientUrl
      setRuntimePairingUrl(result.pairingUrl)
      setWebClientUrl(result.webClientUrl)
      toast.success(result.webClientUrl ? 'Generated web client URL.' : 'Generated pairing URL.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate pairing URL.')
    } finally {
      setIsGeneratingPairing(false)
    }
  }

  const copyGeneratedUrl = async (target: 'web' | 'pairing', value: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(value)
      setCopiedTarget(target)
      toast.success(target === 'web' ? 'Copied web client URL.' : 'Copied pairing URL.')
      window.setTimeout(() => {
        setCopiedTarget((current) => (current === target ? null : current))
      }, 1400)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy URL.')
    }
  }

  const containerClassName = framed
    ? 'space-y-3 rounded-lg border border-border/50 bg-muted/25 p-3'
    : 'space-y-4'

  const updateSelectedAddress = (address: string): void => {
    runtimePairingUrlCache.selectedAddress = address
    setSelectedAddress(address)
  }

  const updateCustomAddress = (address: string): void => {
    runtimePairingUrlCache.customAddress = address
    setCustomAddress(address)
  }

  return (
    <div className={containerClassName}>
      {showHeader ? (
        <div className="space-y-1">
          <Label id="runtime-share-server-label">Share this desktop</Label>
          <p className="text-xs text-muted-foreground">
            Generate a runtime pairing URL for the web client or another Orca client.
          </p>
        </div>
      ) : null}
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
          <div className="space-y-1">
            <Label id="runtime-pairing-address-label" htmlFor="runtime-pairing-address">
              Advertise address
            </Label>
            <Select value={selectedAddress} onValueChange={updateSelectedAddress}>
              <SelectTrigger
                id="runtime-pairing-address"
                size="sm"
                className="min-w-[220px]"
                aria-labelledby="runtime-pairing-address-label"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LOOPBACK_ADDRESS}>This computer ({LOOPBACK_ADDRESS})</SelectItem>
                {networkInterfaces.map((networkInterface, index) => (
                  <SelectItem
                    key={`${networkInterface.name}:${networkInterface.address}:${index}`}
                    value={networkInterface.address}
                  >
                    {networkInterface.name} ({networkInterface.address})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="runtime-pairing-custom-address">Custom address</Label>
            <Input
              id="runtime-pairing-custom-address"
              value={customAddress}
              onChange={(event) => updateCustomAddress(event.target.value)}
              placeholder="host, host:port, or wss://host/path"
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void generateRuntimePairingUrl()}
            disabled={isGeneratingPairing}
          >
            {isGeneratingPairing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Generate
          </Button>
        </div>
      </div>

      {webClientUrl ? (
        <GeneratedUrlRow
          label="Web client URL"
          value={webClientUrl}
          copied={copiedTarget === 'web'}
          onCopy={() => void copyGeneratedUrl('web', webClientUrl)}
        />
      ) : null}

      {runtimePairingUrl ? (
        <GeneratedUrlRow
          label="Pairing URL"
          value={runtimePairingUrl}
          copied={copiedTarget === 'pairing'}
          onCopy={() => void copyGeneratedUrl('pairing', runtimePairingUrl)}
        />
      ) : null}
    </div>
  )
}
