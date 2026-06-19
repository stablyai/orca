import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'
import { Label } from '../ui/label'
import { RuntimeAccessGrantList } from './RuntimeAccessGrantList'
import { translate } from '@/i18n/i18n'
import { RuntimePairingGeneratorForm } from './RuntimePairingGeneratorForm'

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
  const copiedTargetResetTimerRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()

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

  const loadRuntimeAccessGrants = useCallback(
    async (options: { showToastOnError?: boolean } = {}): Promise<void> => {
      const loadId = accessGrantLoadIdRef.current + 1
      accessGrantLoadIdRef.current = loadId
      if (mountedRef.current) {
        setIsLoadingAccessGrants(true)
      }
      try {
        const result = await window.api.mobile.listRuntimeAccessGrants()
        if (mountedRef.current && loadId === accessGrantLoadIdRef.current) {
          setRuntimeAccessGrants(result.grants)
        }
      } catch (error) {
        if (
          mountedRef.current &&
          loadId === accessGrantLoadIdRef.current &&
          options.showToastOnError
        ) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.1b4e0bbcc5',
                  'Failed to load shared access grants.'
                )
          )
        }
      } finally {
        if (mountedRef.current && loadId === accessGrantLoadIdRef.current) {
          setIsLoadingAccessGrants(false)
        }
      }
    },
    [mountedRef]
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
    void loadRuntimeAccessGrants()
    return () => {
      accessGrantLoadIdRef.current += 1
    }
  }, [loadRuntimeAccessGrants])

  const clearGeneratedUrls = (): void => {
    runtimePairingUrlCache.runtimePairingUrl = null
    runtimePairingUrlCache.webClientUrl = null
    runtimePairingUrlCache.runtimePairingDeviceId = null
    if (mountedRef.current) {
      setRuntimePairingUrl(null)
      setWebClientUrl(null)
      setRuntimePairingDeviceId(null)
    }
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
        if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.settings.RuntimePairingUrlGenerator.2752126f3e',
              'Runtime pairing is unavailable.'
            )
          )
        }
        return
      }
      runtimePairingUrlCache.runtimePairingUrl = result.pairingUrl
      runtimePairingUrlCache.webClientUrl = result.webClientUrl
      runtimePairingUrlCache.runtimePairingDeviceId = result.deviceId
      if (mountedRef.current) {
        setRuntimePairingUrl(result.pairingUrl)
        setWebClientUrl(result.webClientUrl)
        setRuntimePairingDeviceId(result.deviceId)
      }
      await loadRuntimeAccessGrants()
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

  const revokeRuntimeAccess = async (grant: RuntimeAccessGrant): Promise<void> => {
    setRevokingGrantId(grant.deviceId)
    try {
      const result = await window.api.mobile.revokeRuntimeAccess({ deviceId: grant.deviceId })
      if (!result.revoked) {
        if (mountedRef.current) {
          toast.error(
            translate(
              'auto.components.settings.RuntimePairingUrlGenerator.d797f516b1',
              'Shared access was already revoked.'
            )
          )
        }
        await loadRuntimeAccessGrants()
        return
      }
      if (mountedRef.current) {
        setRuntimeAccessGrants((current) =>
          current.filter((entry) => entry.deviceId !== grant.deviceId)
        )
      }
      if (runtimePairingDeviceId === grant.deviceId) {
        clearGeneratedUrls()
      }
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.RuntimePairingUrlGenerator.9f8e037c4a',
            'Shared access revoked.'
          )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimePairingUrlGenerator.e8d83f2b0f',
                'Failed to revoke shared access.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setRevokingGrantId(null)
      }
    }
  }

  const copyGeneratedUrl = async (target: 'web' | 'pairing', value: string): Promise<void> => {
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
        toast.success(
          target === 'web'
            ? translate(
                'auto.components.settings.RuntimePairingUrlGenerator.13704d635e',
                'Copied web client URL.'
              )
            : translate(
                'auto.components.settings.RuntimePairingUrlGenerator.df0aa45a86',
                'Copied pairing URL.'
              )
        )
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
    runtimePairingUrlCache.selectedAddress = address
    setSelectedAddress(address)
  }

  const updateCustomAddress = (address: string): void => {
    runtimePairingUrlCache.customAddress = address
    setCustomAddress(address)
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
          loopbackAddress={LOOPBACK_ADDRESS}
          networkInterfaces={networkInterfaces}
          selectedAddress={selectedAddress}
          customAddress={customAddress}
          refreshingNetworkInterfaces={refreshingNetworkInterfaces}
          isGeneratingPairing={isGeneratingPairing}
          webClientUrl={webClientUrl}
          runtimePairingUrl={runtimePairingUrl}
          copiedTarget={copiedTarget}
          onSelectedAddressChange={updateSelectedAddress}
          onCustomAddressChange={updateCustomAddress}
          onRefreshNetworkInterfaces={() => void loadNetworkInterfaces({ showToastOnError: true })}
          onGenerate={() => void generateRuntimePairingUrl()}
          onCopy={(target, value) => void copyGeneratedUrl(target, value)}
        />
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
