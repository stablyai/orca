import { Check, Copy, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { RuntimeAccessGrantList } from './RuntimeAccessGrantList'

const LOOPBACK_ADDRESS = '127.0.0.1'

// Why: runtime pairing tokens stay valid in the main-process registry; keep the
// last displayed URL across settings collapse/navigation without less-protected storage.
const runtimePairingUrlCache: {
  selectedAddress: string
  customAddress: string
  runtimePairingUrl: string | null
  webClientUrl: string | null
  runtimePairingDeviceId: string | null
} = {
  selectedAddress: LOOPBACK_ADDRESS,
  customAddress: '',
  runtimePairingUrl: null,
  webClientUrl: null,
  runtimePairingDeviceId: null
}

function GeneratedUrlRow({
  label,
  description,
  value,
  copied,
  onCopy
}: {
  label: string
  description?: string
  value: string
  copied: boolean
  onCopy: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
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

function UnavailableUrlRow({
  label,
  description
}: {
  label: string
  description: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="rounded-md border border-border/60 px-2 py-1.5">
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

type RuntimePairingUrlGeneratorProps = {
  framed?: boolean
  showHeader?: boolean
  showGeneratorForm?: boolean
}

export function RuntimePairingUrlGenerator({
  framed = true,
  showHeader = true,
  showGeneratorForm = true
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
  const [runtimePairingDeviceId, setRuntimePairingDeviceId] = useState<string | null>(
    runtimePairingUrlCache.runtimePairingDeviceId
  )
  const [runtimeAccessGrants, setRuntimeAccessGrants] = useState<RuntimeAccessGrant[]>([])
  const [isLoadingAccessGrants, setIsLoadingAccessGrants] = useState(false)
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null)
  const [copiedTarget, setCopiedTarget] = useState<'web' | 'pairing' | null>(null)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)
  const networkInterfaceLoadIdRef = useRef(0)
  const accessGrantLoadIdRef = useRef(0)

  useEffect(() => {
    if (copiedTarget === null) {
      return
    }
    const target = copiedTarget
    const timeout = window.setTimeout(() => {
      setCopiedTarget((current) => (current === target ? null : current))
    }, 1400)
    return () => window.clearTimeout(timeout)
  }, [copiedTarget])

  const loadRuntimeAccessGrants = useCallback(
    async (options: { showToastOnError?: boolean } = {}): Promise<void> => {
      const loadId = accessGrantLoadIdRef.current + 1
      accessGrantLoadIdRef.current = loadId
      setIsLoadingAccessGrants(true)
      try {
        const result = await window.api.mobile.listRuntimeAccessGrants()
        if (loadId === accessGrantLoadIdRef.current) {
          setRuntimeAccessGrants(result.grants)
        }
      } catch (error) {
        if (loadId === accessGrantLoadIdRef.current && options.showToastOnError) {
          toast.error(
            error instanceof Error ? error.message : 'Failed to load shared access grants.'
          )
        }
      } finally {
        if (loadId === accessGrantLoadIdRef.current) {
          setIsLoadingAccessGrants(false)
        }
      }
    },
    []
  )

  const loadNetworkInterfaces = useCallback(
    async (options: { showToastOnError?: boolean } = {}): Promise<void> => {
      const loadId = networkInterfaceLoadIdRef.current + 1
      networkInterfaceLoadIdRef.current = loadId
      setRefreshingNetworkInterfaces(true)
      try {
        const result = await window.api.mobile.listNetworkInterfaces()
        if (loadId === networkInterfaceLoadIdRef.current) {
          setNetworkInterfaces(result.interfaces)
        }
      } catch {
        if (loadId === networkInterfaceLoadIdRef.current && options.showToastOnError) {
          toast.error('Failed to refresh network interfaces.')
        }
      } finally {
        if (loadId === networkInterfaceLoadIdRef.current) {
          setRefreshingNetworkInterfaces(false)
        }
      }
    },
    []
  )

  useEffect(() => {
    void loadNetworkInterfaces()
    return () => {
      networkInterfaceLoadIdRef.current += 1
    }
  }, [loadNetworkInterfaces])

  useEffect(() => {
    void loadRuntimeAccessGrants()
    return () => {
      accessGrantLoadIdRef.current += 1
    }
  }, [loadRuntimeAccessGrants])

  const clearGeneratedUrls = (): void => {
    runtimePairingUrlCache.runtimePairingUrl = null
    runtimePairingUrlCache.webClientUrl = null
    runtimePairingUrlCache.runtimePairingDeviceId = null
    setRuntimePairingUrl(null)
    setWebClientUrl(null)
    setRuntimePairingDeviceId(null)
  }

  const generateRuntimePairingUrl = async (): Promise<void> => {
    setIsGeneratingPairing(true)
    try {
      const advertiseAddress = customAddress.trim() || selectedAddress
      const result = await window.api.mobile.getRuntimePairingUrl({
        address: advertiseAddress,
        rotate: true
      })
      if (!result.available) {
        clearGeneratedUrls()
        toast.error('Runtime pairing is unavailable.')
        return
      }
      runtimePairingUrlCache.runtimePairingUrl = result.pairingUrl
      runtimePairingUrlCache.webClientUrl = result.webClientUrl
      runtimePairingUrlCache.runtimePairingDeviceId = result.deviceId
      setRuntimePairingUrl(result.pairingUrl)
      setWebClientUrl(result.webClientUrl)
      setRuntimePairingDeviceId(result.deviceId)
      await loadRuntimeAccessGrants()
      toast.success(result.webClientUrl ? 'Generated web client URL.' : 'Generated pairing URL.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate pairing URL.')
    } finally {
      setIsGeneratingPairing(false)
    }
  }

  const revokeRuntimeAccess = async (grant: RuntimeAccessGrant): Promise<void> => {
    setRevokingGrantId(grant.deviceId)
    try {
      const result = await window.api.mobile.revokeRuntimeAccess({ deviceId: grant.deviceId })
      if (!result.revoked) {
        toast.error('Shared access was already revoked.')
        await loadRuntimeAccessGrants()
        return
      }
      setRuntimeAccessGrants((current) =>
        current.filter((entry) => entry.deviceId !== grant.deviceId)
      )
      if (runtimePairingDeviceId === grant.deviceId) {
        clearGeneratedUrls()
      }
      toast.success('Shared access revoked.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to revoke shared access.')
    } finally {
      setRevokingGrantId(null)
    }
  }

  const copyGeneratedUrl = async (target: 'web' | 'pairing', value: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(value)
      setCopiedTarget(target)
      toast.success(target === 'web' ? 'Copied web client URL.' : 'Copied pairing URL.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy URL.')
    }
  }

  const containerClassName = framed
    ? 'space-y-3 rounded-lg border border-border/50 bg-muted/25 p-3'
    : 'space-y-4'
  const sharedAccessClassName = showGeneratorForm ? 'border-t border-border/40 pt-3' : ''

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
          <Label id="runtime-share-server-label">Share this Orca server</Label>
          <p className="text-xs text-muted-foreground">
            Create a revocable access grant for browser or desktop clients.
          </p>
        </div>
      ) : null}
      {showGeneratorForm ? (
        <>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
              <div className="space-y-1">
                <Label id="runtime-pairing-address-label" htmlFor="runtime-pairing-address">
                  Connection address
                </Label>
                <div className="flex min-w-0 items-center gap-2">
                  <Select value={selectedAddress} onValueChange={updateSelectedAddress}>
                    <SelectTrigger
                      id="runtime-pairing-address"
                      size="sm"
                      className="min-w-0 flex-1"
                      aria-labelledby="runtime-pairing-address-label"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={LOOPBACK_ADDRESS}>
                        This computer ({LOOPBACK_ADDRESS})
                      </SelectItem>
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
                  {/* Why: server sharing uses the same interface list as Mobile,
                      and VPN/tailnet addresses can appear after Settings opens. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void loadNetworkInterfaces({ showToastOnError: true })}
                        disabled={refreshingNetworkInterfaces}
                        aria-label="Refresh connection addresses"
                        className="text-muted-foreground"
                      >
                        <RefreshCw className={refreshingNetworkInterfaces ? 'animate-spin' : ''} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Refresh connection addresses
                    </TooltipContent>
                  </Tooltip>
                </div>
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
            <p className="text-xs text-muted-foreground">
              127.0.0.1 only works on this computer. Use a LAN, Tailscale, or custom address for
              another device.
            </p>
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
                Generate Access Link
              </Button>
            </div>
          </div>

          {webClientUrl ? (
            <GeneratedUrlRow
              label="Open in browser"
              description="Use this URL from a browser that can reach the selected address."
              value={webClientUrl}
              copied={copiedTarget === 'web'}
              onCopy={() => void copyGeneratedUrl('web', webClientUrl)}
            />
          ) : runtimePairingUrl ? (
            <UnavailableUrlRow
              label="Open in browser"
              description="Browser link unavailable in this build. The pairing URL still works for Orca clients."
            />
          ) : null}

          {runtimePairingUrl ? (
            <GeneratedUrlRow
              label="Pair another Orca client"
              description="Paste this pairing URL into another Orca client."
              value={runtimePairingUrl}
              copied={copiedTarget === 'pairing'}
              onCopy={() => void copyGeneratedUrl('pairing', runtimePairingUrl)}
            />
          ) : null}
        </>
      ) : null}

      <RuntimeAccessGrantList
        className={sharedAccessClassName}
        grants={runtimeAccessGrants}
        currentGrantId={runtimePairingDeviceId}
        isLoading={isLoadingAccessGrants}
        revokingGrantId={revokingGrantId}
        onRefresh={() => void loadRuntimeAccessGrants({ showToastOnError: true })}
        onRevoke={(grant) => void revokeRuntimeAccess(grant)}
      />
    </div>
  )
}
