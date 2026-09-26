import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Label } from '../ui/label'
import { RuntimeAccessGrantList } from './RuntimeAccessGrantList'
import { translate } from '@/i18n/i18n'
import {
  RuntimePairingGeneratorForm,
  type RuntimePairingCopyTarget
} from './RuntimePairingGeneratorForm'
import { useRuntimeAccessGrants } from './useRuntimeAccessGrants'
import { parseCloudflareTunnelAddress } from '../../../../shared/network/cloudflare-tunnel-address'
import { webSocketEndpointPort } from '../../../../shared/network/pairing-url'
import {
  RUNTIME_PAIRING_LOOPBACK_ADDRESS,
  cacheGeneratedRuntimePairingLink,
  clearGeneratedRuntimePairingLink,
  rememberIntentAddress,
  runtimePairingLinkCache,
  runtimePairingReachForIntent,
  selectRuntimePairingIntent,
  type RuntimePairingIntent,
  type RuntimePairingUrlGeneratorProps
} from './runtime-pairing-link-state'

export function RuntimePairingUrlGenerator({
  framed = true,
  showHeader = true,
  showGeneratorForm = true
}: RuntimePairingUrlGeneratorProps): React.JSX.Element {
  const [networkInterfaces, setNetworkInterfaces] = useState<{ name: string; address: string }[]>(
    []
  )
  const [selectedAddress, setSelectedAddress] = useState(runtimePairingLinkCache.selectedAddress)
  const [intent, setIntent] = useState<RuntimePairingIntent>(runtimePairingLinkCache.intent)
  const [generatedAddress, setGeneratedAddress] = useState<string | null>(
    runtimePairingLinkCache.generatedAddress
  )
  const [runtimePairingUrl, setRuntimePairingUrl] = useState<string | null>(
    runtimePairingLinkCache.runtimePairingUrl
  )
  const [webClientUrl, setWebClientUrl] = useState<string | null>(
    runtimePairingLinkCache.webClientUrl
  )
  const [runtimePairingDeviceId, setRuntimePairingDeviceId] = useState<string | null>(
    runtimePairingLinkCache.runtimePairingDeviceId
  )
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [localWebSocketPort, setLocalWebSocketPort] = useState<number | null>(null)
  const [copiedTarget, setCopiedTarget] = useState<RuntimePairingCopyTarget | null>(null)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)
  const networkInterfaceLoadIdRef = useRef(0)
  const copiedTargetResetTimerRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()

  const clearGeneratedUrlsIfGrantMatches = useCallback((deviceId: string): void => {
    if (runtimePairingLinkCache.runtimePairingDeviceId !== deviceId) {
      return
    }
    clearGeneratedRuntimePairingLink()
    setRuntimePairingUrl(null)
    setWebClientUrl(null)
    setRuntimePairingDeviceId(null)
    setGeneratedAddress(null)
  }, [])

  const accessGrants = useRuntimeAccessGrants({ onGrantRevoked: clearGeneratedUrlsIfGrantMatches })

  const clearCopiedTargetResetTimer = useCallback((): void => {
    if (copiedTargetResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(copiedTargetResetTimerRef.current)
    copiedTargetResetTimerRef.current = null
  }, [])

  const setContainerNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: copy feedback timers are owned by this settings surface; clear
      // them when Settings collapses or navigates away.
      if (!node) {
        clearCopiedTargetResetTimer()
      }
    },
    [clearCopiedTargetResetTimer]
  )

  const loadNetworkInterfaces = useCallback(
    async (options: { showToastOnError?: boolean } = {}): Promise<void> => {
      const loadId = networkInterfaceLoadIdRef.current + 1
      networkInterfaceLoadIdRef.current = loadId
      if (mountedRef.current) {
        setRefreshingNetworkInterfaces(true)
      }
      try {
        const result = await window.api.mobile.listNetworkInterfaces()
        if (mountedRef.current && loadId === networkInterfaceLoadIdRef.current) {
          setNetworkInterfaces(result.interfaces)
        }
      } catch {
        if (
          mountedRef.current &&
          loadId === networkInterfaceLoadIdRef.current &&
          options.showToastOnError
        ) {
          toast.error(
            translate(
              'auto.components.settings.RuntimePairingUrlGenerator.95b8be4cea',
              'Failed to refresh network interfaces.'
            )
          )
        }
      } finally {
        if (mountedRef.current && loadId === networkInterfaceLoadIdRef.current) {
          setRefreshingNetworkInterfaces(false)
        }
      }
    },
    [mountedRef]
  )

  useEffect(() => {
    void loadNetworkInterfaces()
    return () => {
      networkInterfaceLoadIdRef.current += 1
    }
  }, [loadNetworkInterfaces])

  useEffect(() => {
    if (intent !== 'another' || networkInterfaces.length === 0) {
      return
    }
    const addressStillAvailable = networkInterfaces.some(
      (networkInterface) => networkInterface.address === selectedAddress
    )
    if (!addressStillAvailable) {
      const nextAddress = networkInterfaces[0]?.address ?? ''
      runtimePairingLinkCache.selectedAddress = nextAddress
      setSelectedAddress(nextAddress)
    }
  }, [intent, networkInterfaces, selectedAddress])

  // Re-read on intent change so selecting Cloudflare Tunnel picks up a listener that bound (or
  // rebound on a new port) after this pane mounted.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const status = await window.api.mobile.isWebSocketReady()
        if (!cancelled && mountedRef.current) {
          setLocalWebSocketPort(webSocketEndpointPort(status.endpoint))
        }
      } catch {
        /* leave the port unknown; the panel withholds the command */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mountedRef, intent])

  const clearGeneratedUrls = (): void => {
    clearGeneratedRuntimePairingLink()
    if (mountedRef.current) {
      setRuntimePairingUrl(null)
      setWebClientUrl(null)
      setRuntimePairingDeviceId(null)
      setGeneratedAddress(null)
    }
  }

  const generateRuntimePairingUrl = async (): Promise<void> => {
    const address = selectedAddress.trim()
    runtimePairingLinkCache.selectedAddress = address
    setSelectedAddress(address)
    rememberIntentAddress(intent, address)
    // Send wss:// so main does not graft the local port onto the tunnel host.
    const tunnelAddress = intent === 'cloudflare' ? parseCloudflareTunnelAddress(address) : null
    const advertisedAddress = tunnelAddress?.ok ? tunnelAddress.value : address
    setIsGeneratingPairing(true)
    try {
      const result = await window.api.mobile.getRuntimePairingUrl({
        address: advertisedAddress,
        rotate: true,
        // Why: main gates the one-way network widen on this, so the declared choice must travel with the
        // address — the address alone cannot tell "This computer only" from a loopback tunnel front-end.
        reach: runtimePairingReachForIntent(intent)
      })
      if (!result.available) {
        clearGeneratedUrls()
        if (mountedRef.current) {
          // Why: STA-2370 — surface the specific network-exposure guidance when the widen failed; fall back
          // to the generic message for other unavailable cases (e.g. no reachable address).
          toast.error(
            result.guidance ??
              translate(
                'auto.components.settings.RuntimePairingUrlGenerator.2752126f3e',
                'Runtime pairing is unavailable.'
              )
          )
        }
        return
      }
      cacheGeneratedRuntimePairingLink({
        address,
        pairingUrl: result.pairingUrl,
        webClientUrl: result.webClientUrl,
        deviceId: result.deviceId
      })
      if (mountedRef.current) {
        setRuntimePairingUrl(result.pairingUrl)
        setWebClientUrl(result.webClientUrl)
        setRuntimePairingDeviceId(result.deviceId)
        setGeneratedAddress(address)
      }
      await accessGrants.reload()
      if (mountedRef.current) {
        toast.success(
          result.webClientUrl
            ? translate(
                'auto.components.settings.RuntimePairingUrlGenerator.6dd594a507',
                'Generated web client URL.'
              )
            : translate(
                'auto.components.settings.RuntimePairingUrlGenerator.11d5248e62',
                'Generated pairing URL.'
              )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimePairingUrlGenerator.2ed55c841a',
                'Failed to generate pairing URL.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsGeneratingPairing(false)
      }
    }
  }

  const copyGeneratedUrl = async (
    target: RuntimePairingCopyTarget,
    value: string
  ): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(value)
      if (mountedRef.current) {
        clearCopiedTargetResetTimer()
        setCopiedTarget(target)
        copiedTargetResetTimerRef.current = window.setTimeout(() => {
          copiedTargetResetTimerRef.current = null
          if (mountedRef.current) {
            setCopiedTarget((current) => (current === target ? null : current))
          }
        }, 1400)
        toast.success(copiedToastMessage(target))
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimePairingUrlGenerator.d6c081adf4',
                'Failed to copy URL.'
              )
        )
      }
    }
  }

  const containerClassName = framed
    ? 'space-y-3 rounded-lg border border-border/50 bg-muted/25 p-3'
    : 'space-y-4'
  const sharedAccessClassName = showGeneratorForm ? 'border-t border-border/40 pt-3' : ''

  const updateSelectedAddress = (address: string): void => {
    runtimePairingLinkCache.selectedAddress = address
    setSelectedAddress(address)
    if (
      intent === 'another' &&
      !networkInterfaces.some((networkInterface) => networkInterface.address === address)
    ) {
      runtimePairingLinkCache.customAddress = address
      runtimePairingLinkCache.intent = 'custom'
      setIntent('custom')
      return
    }
    rememberIntentAddress(intent, address)
  }

  const updateIntent = (nextIntent: RuntimePairingIntent): void => {
    setIntent(nextIntent)
    setSelectedAddress(
      selectRuntimePairingIntent(nextIntent, networkInterfaces, {
        customAddress: runtimePairingLinkCache.customAddress,
        cloudflareAddress: runtimePairingLinkCache.cloudflareAddress
      })
    )
  }

  return (
    <div ref={setContainerNode} className={containerClassName}>
      {showHeader ? (
        <div className="space-y-1">
          <Label id="runtime-share-server-label">
            {translate(
              'auto.components.settings.RuntimePairingUrlGenerator.f8500e134a',
              'Share this Orca server'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimePairingUrlGenerator.ff80904fc4',
              'Create a revocable access grant for browser or desktop clients.'
            )}
          </p>
        </div>
      ) : null}
      {showGeneratorForm ? (
        <RuntimePairingGeneratorForm
          intent={intent}
          loopbackAddress={RUNTIME_PAIRING_LOOPBACK_ADDRESS}
          networkInterfaces={networkInterfaces}
          selectedAddress={selectedAddress}
          refreshingNetworkInterfaces={refreshingNetworkInterfaces}
          isGeneratingPairing={isGeneratingPairing}
          webClientUrl={webClientUrl}
          runtimePairingUrl={runtimePairingUrl}
          copiedTarget={copiedTarget}
          generatedAddress={generatedAddress}
          localWebSocketPort={localWebSocketPort}
          onIntentChange={updateIntent}
          onSelectedAddressChange={updateSelectedAddress}
          onRefreshNetworkInterfaces={() => void loadNetworkInterfaces({ showToastOnError: true })}
          onGenerate={() => void generateRuntimePairingUrl()}
          onCopy={(target, value) => void copyGeneratedUrl(target, value)}
        />
      ) : null}

      <RuntimeAccessGrantList
        className={sharedAccessClassName}
        grants={accessGrants.grants}
        currentGrantId={runtimePairingDeviceId}
        isLoading={accessGrants.isLoading}
        revokingGrantId={accessGrants.revokingGrantId}
        onRefresh={() => void accessGrants.reload({ showToastOnError: true })}
        onRevoke={(grant) => void accessGrants.revoke(grant)}
      />
    </div>
  )
}

function copiedToastMessage(target: RuntimePairingCopyTarget): string {
  if (target === 'web') {
    return translate(
      'auto.components.settings.RuntimePairingUrlGenerator.13704d635e',
      'Copied web client URL.'
    )
  }
  if (target === 'command') {
    return translate(
      'auto.components.settings.RuntimePairingUrlGenerator.copiedTunnelCommand',
      'Copied tunnel command.'
    )
  }
  return translate(
    'auto.components.settings.RuntimePairingUrlGenerator.df0aa45a86',
    'Copied pairing URL.'
  )
}
