import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { RuntimeAccessGrant } from '../../../../../../shared/remote-runtime/host-catalog/runtime-access-grants'
import { Label } from '../../../ui/label'
import { RuntimeAccessGrantList } from './RuntimeAccessGrantList'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { RuntimePairingGeneratorForm } from './RuntimePairingGeneratorForm'
import {
  RUNTIME_PAIRING_LOOPBACK_ADDRESS,
  cacheGeneratedRuntimePairingLink,
  clearGeneratedRuntimePairingLink,
  followedRuntimePairingInterface,
  readRuntimePairingInterface,
  resolveAnotherDeviceAddress,
  runtimePairingLinkCache,
  runtimePairingReachForIntent,
  selectRuntimePairingIntent,
  type RuntimePairingIntent
} from './runtime-pairing-link-state'
import { useRuntimePairingLinkExpiry } from './use-runtime-pairing-link-expiry'
import { useRuntimePairingUrlCopy } from './use-runtime-pairing-url-copy'

type RuntimePairingUrlGeneratorProps = {
  framed?: boolean
  showHeader?: boolean
  showGeneratorForm?: boolean
  runtimeAccessGrants: RuntimeAccessGrant[] | null
  loadRuntimeAccessGrants: () => Promise<void>
  onAccessGrantRevoked: (deviceId: string) => void
}

export function RuntimePairingUrlGenerator({
  framed = true,
  showHeader = true,
  showGeneratorForm = true,
  runtimeAccessGrants,
  loadRuntimeAccessGrants,
  onAccessGrantRevoked
}: RuntimePairingUrlGeneratorProps): React.JSX.Element {
  const t = useTranslate()
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
  const [expiresAt, setExpiresAt] = useState(runtimePairingLinkCache.expiresAt)
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)
  const networkInterfaceLoadIdRef = useRef(0)
  const mountedRef = useMountedRef()
  const { copiedTarget, copyGeneratedUrl, setContainerNode } = useRuntimePairingUrlCopy(mountedRef)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const chosenInterface = useAppStore((state) =>
    readRuntimePairingInterface(state.settings?.runtimePairingInterface)
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
    const nextAddress = resolveAnotherDeviceAddress(
      networkInterfaces,
      selectedAddress,
      chosenInterface
    )
    if (nextAddress !== selectedAddress) {
      runtimePairingLinkCache.selectedAddress = nextAddress
      setSelectedAddress(nextAddress)
      const followed = followedRuntimePairingInterface(
        networkInterfaces,
        nextAddress,
        chosenInterface
      )
      if (followed) {
        void updateSettings({ runtimePairingInterface: followed })
      }
    }
  }, [chosenInterface, intent, networkInterfaces, selectedAddress, updateSettings])

  const clearGeneratedUrls = (): void => {
    clearGeneratedRuntimePairingLink()
    if (mountedRef.current) {
      setRuntimePairingUrl(null)
      setWebClientUrl(null)
      setRuntimePairingDeviceId(null)
      setGeneratedAddress(null)
      setExpiresAt(null)
    }
  }

  const generateRuntimePairingUrl = async (): Promise<void> => {
    const address = selectedAddress.trim()
    runtimePairingLinkCache.selectedAddress = address
    setSelectedAddress(address)
    if (intent === 'custom') {
      runtimePairingLinkCache.customAddress = address
    }
    setIsGeneratingPairing(true)
    try {
      const result = await window.api.mobile.getRuntimePairingUrl({
        address,
        rotate: true,
        // Send declared reach with the address; loopback alone cannot distinguish local-only intent from a tunnel frontend.
        reach: runtimePairingReachForIntent(intent)
      })
      if (!result.available) {
        clearGeneratedUrls()
        if (mountedRef.current) {
          // Prefer specific exposure guidance after widening failure, with generic fallback for other unavailable cases (STA-2370).
          toast.error(
            result.guidance ??
              t(
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
        deviceId: result.deviceId,
        expiresAt: result.expiresAt ?? null
      })
      if (mountedRef.current) {
        setRuntimePairingUrl(result.pairingUrl)
        setWebClientUrl(result.webClientUrl)
        setRuntimePairingDeviceId(result.deviceId)
        setGeneratedAddress(address)
        setExpiresAt(result.expiresAt ?? null)
      }
      await loadRuntimeAccessGrants()
      if (mountedRef.current) {
        toast.success(
          result.webClientUrl
            ? t(
                'auto.components.settings.RuntimePairingUrlGenerator.6dd594a507',
                'Generated web client URL.'
              )
            : t(
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
            : t(
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
            t(
              'auto.components.settings.RuntimePairingUrlGenerator.d797f516b1',
              'Shared access was already revoked.'
            )
          )
        }
        await loadRuntimeAccessGrants()
        return
      }
      onAccessGrantRevoked(grant.deviceId)
      if (runtimePairingLinkCache.runtimePairingDeviceId === grant.deviceId) {
        clearGeneratedUrls()
      }
      if (mountedRef.current) {
        toast.success(
          t(
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
            : t(
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

  const grantStatus =
    runtimePairingDeviceId === runtimePairingLinkCache.runtimePairingDeviceId
      ? runtimePairingLinkCache.grantStatus
      : 'unknown'
  const linkExpiry = useRuntimePairingLinkExpiry({
    expiresAt,
    used: grantStatus === 'used',
    onExpired: () => void loadRuntimeAccessGrants()
  })

  const containerClassName = framed
    ? 'space-y-3 rounded-lg border border-border/50 bg-muted/25 p-3'
    : 'space-y-4'
  const sharedAccessClassName = showGeneratorForm ? 'border-t border-border/40 pt-3' : ''

  const disconnectedInterface =
    intent === 'another' &&
    networkInterfaces.length > 0 &&
    chosenInterface?.address === selectedAddress &&
    !networkInterfaces.some((networkInterface) => networkInterface.address === selectedAddress)
      ? chosenInterface
      : null

  const updateSelectedAddress = (address: string): void => {
    runtimePairingLinkCache.selectedAddress = address
    setSelectedAddress(address)
    const pickedInterface =
      intent === 'another'
        ? networkInterfaces.find((networkInterface) => networkInterface.address === address)
        : undefined
    if (pickedInterface) {
      // Why: the top-ranked address is the default, so picking it clears the choice instead of pinning it.
      const nextChoice =
        pickedInterface === networkInterfaces[0] ? null : { name: pickedInterface.name, address }
      if (
        nextChoice?.name !== chosenInterface?.name ||
        nextChoice?.address !== chosenInterface?.address
      ) {
        void updateSettings({ runtimePairingInterface: nextChoice })
      }
    } else if (intent === 'another') {
      runtimePairingLinkCache.customAddress = address
      runtimePairingLinkCache.intent = 'custom'
      setIntent('custom')
    } else if (intent === 'custom') {
      runtimePairingLinkCache.customAddress = address
    }
  }

  const updateIntent = (nextIntent: RuntimePairingIntent): void => {
    setIntent(nextIntent)
    const nextAddress = selectRuntimePairingIntent(
      nextIntent,
      networkInterfaces,
      runtimePairingLinkCache.customAddress,
      chosenInterface
    )
    setSelectedAddress(nextAddress)
    const followed =
      nextIntent === 'another'
        ? followedRuntimePairingInterface(networkInterfaces, nextAddress, chosenInterface)
        : null
    if (followed) {
      void updateSettings({ runtimePairingInterface: followed })
    }
  }

  return (
    <div ref={setContainerNode} className={containerClassName}>
      {showHeader ? (
        <div className="space-y-1">
          <Label id="runtime-share-server-label">
            {t(
              'auto.components.settings.RuntimePairingUrlGenerator.f8500e134a',
              'Share this Orca server'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
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
          disconnectedInterface={disconnectedInterface}
          selectedAddress={selectedAddress}
          refreshingNetworkInterfaces={refreshingNetworkInterfaces}
          isGeneratingPairing={isGeneratingPairing}
          webClientUrl={webClientUrl}
          runtimePairingUrl={runtimePairingUrl}
          copiedTarget={copiedTarget}
          generatedAddress={generatedAddress}
          grantRemoved={grantStatus === 'removed'}
          linkExpiry={linkExpiry}
          onIntentChange={updateIntent}
          onSelectedAddressChange={updateSelectedAddress}
          onRefreshNetworkInterfaces={() => void loadNetworkInterfaces({ showToastOnError: true })}
          onGenerate={() => void generateRuntimePairingUrl()}
          onCopy={(target, value) => void copyGeneratedUrl(target, value)}
        />
      ) : null}

      {runtimeAccessGrants ? (
        <RuntimeAccessGrantList
          className={sharedAccessClassName}
          grants={runtimeAccessGrants}
          currentGrantId={runtimePairingDeviceId}
          isLoading={false}
          revokingGrantId={revokingGrantId}
          onRevoke={(grant) => void revokeRuntimeAccess(grant)}
        />
      ) : null}
    </div>
  )
}
