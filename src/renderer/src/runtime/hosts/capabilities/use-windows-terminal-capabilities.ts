import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { startWindowsTerminalCapabilityReprobe } from './windows-terminal-capability-reprobe'
import {
  UNAVAILABLE_CAPABILITIES,
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities,
  loadWindowsTerminalCapabilities,
  resolveWindowsTerminalCapabilityCacheKey,
  watchWindowsTerminalCapabilities,
  type WindowsTerminalCapabilities
} from './windows-terminal-capability-cache'

type WindowsTerminalCapabilityHookState = {
  ownerKey: string
  capabilities: WindowsTerminalCapabilities
}

export function selectWindowsTerminalCapabilitiesForOwner(
  state: WindowsTerminalCapabilityHookState,
  enabled: boolean,
  ownerKey: string
): WindowsTerminalCapabilities {
  if (!enabled) {
    return UNAVAILABLE_CAPABILITIES
  }
  return state.ownerKey === ownerKey
    ? state.capabilities
    : getCachedWindowsTerminalCapabilities(ownerKey)
}

export function useWindowsTerminalCapabilities(
  enabled: boolean,
  forceRefreshOnMount = false,
  ownerKey?: string,
  target: RuntimeClientTarget = { kind: 'local' },
  sshConnectionId?: string | null,
  /** A strip remounting after its workspace released it; new mounts keep the cache TTL. */
  reuseCachedAnswerOnMount = false
): WindowsTerminalCapabilities {
  const targetKind = target.kind
  const targetEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const sshConnectionIdKey = sshConnectionId?.trim() || null
  const resolvedTarget: RuntimeClientTarget = useMemo(
    () =>
      targetKind === 'environment' && targetEnvironmentId
        ? { kind: 'environment', environmentId: targetEnvironmentId }
        : { kind: 'local' },
    [targetKind, targetEnvironmentId]
  )
  const resolvedOwnerKey = resolveWindowsTerminalCapabilityCacheKey({
    ownerKey,
    target: resolvedTarget,
    sshConnectionId: sshConnectionIdKey
  })
  // Reuse applies only to the owner the strip returned with; an owner change clears it for the strip's life.
  const returnedOwnerKeyRef = useRef(reuseCachedAnswerOnMount ? resolvedOwnerKey : null)
  const [state, setState] = useState(() => ({
    ownerKey: resolvedOwnerKey,
    capabilities: getCachedWindowsTerminalCapabilities(resolvedOwnerKey)
  }))

  useEffect(() => {
    if (!enabled) {
      setState({ ownerKey: resolvedOwnerKey, capabilities: UNAVAILABLE_CAPABILITIES })
      return
    }
    let cancelled = false
    const cached = getCachedWindowsTerminalCapabilities(resolvedOwnerKey)
    const hasOwnerCache = hasCachedWindowsTerminalCapabilities(resolvedOwnerKey)
    setState({
      ownerKey: resolvedOwnerKey,
      capabilities: hasOwnerCache ? cached : { ...cached, isLoading: true }
    })
    const setCapabilities = (capabilities: WindowsTerminalCapabilities): void => {
      setState({ ownerKey: resolvedOwnerKey, capabilities })
    }
    const unwatch = watchWindowsTerminalCapabilities(resolvedOwnerKey, setCapabilities)
    const reprobe: { stop: (() => void) | null } = { stop: null }
    const isLocalOwner = resolvedTarget.kind === 'local' && !sshConnectionIdKey
    // On main a released strip stayed mounted and never re-probed; returning reads the shared answer the same way.
    // A failed probe's placeholder isn't an answer, so it still reloads (remote owners have no re-probe runner).
    if (returnedOwnerKeyRef.current !== resolvedOwnerKey) {
      returnedOwnerKeyRef.current = null
    }
    const reuseCachedAnswer =
      returnedOwnerKeyRef.current !== null &&
      !forceRefreshOnMount &&
      hasOwnerCache &&
      cached !== UNAVAILABLE_CAPABILITIES
    const mountLoad = reuseCachedAnswer
      ? Promise.resolve(cached)
      : loadWindowsTerminalCapabilities({
          force: forceRefreshOnMount,
          ownerKey: resolvedOwnerKey,
          target: resolvedTarget,
          sshConnectionId: sshConnectionIdKey
        })
    void mountLoad.then((nextCapabilities) => {
      if (cancelled) {
        return
      }
      setState({ ownerKey: resolvedOwnerKey, capabilities: nextCapabilities })
      // Why: each re-probe spawns wsl.exe/pwsh.exe, so local consumers share a bounded backoff.
      if (isLocalOwner) {
        reprobe.stop = startWindowsTerminalCapabilityReprobe({
          ownerKey: resolvedOwnerKey,
          readCached: () => getCachedWindowsTerminalCapabilities(resolvedOwnerKey),
          probe: () =>
            loadWindowsTerminalCapabilities({
              ownerKey: resolvedOwnerKey,
              target: resolvedTarget,
              sshConnectionId: sshConnectionIdKey
            })
        })
      }
    })

    return () => {
      cancelled = true
      reprobe.stop?.()
      unwatch()
    }
  }, [
    enabled,
    forceRefreshOnMount,
    resolvedOwnerKey,
    resolvedTarget,
    sshConnectionIdKey,
    reuseCachedAnswerOnMount
  ])

  return selectWindowsTerminalCapabilitiesForOwner(state, enabled, resolvedOwnerKey)
}

export function useLocalWindowsTerminalCapabilities(
  enabled: boolean,
  forceRefreshOnMount = false,
  ownerKey = 'local'
): WindowsTerminalCapabilities {
  // Why: desktop-owned defaults must not follow the active remote environment.
  return useWindowsTerminalCapabilities(enabled, forceRefreshOnMount, ownerKey, { kind: 'local' })
}
