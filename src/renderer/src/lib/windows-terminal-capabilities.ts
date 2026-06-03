import { useEffect, useState } from 'react'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'

export type WindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  gitBashAvailable: boolean
  hostPlatform: NodeJS.Platform | null
  isLoading: boolean
}

const UNAVAILABLE_CAPABILITIES: WindowsTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  gitBashAvailable: false,
  hostPlatform: null,
  isLoading: false
}

const CAPABILITY_CACHE_TTL_MS = 30_000
const CAPABILITY_OWNER_CACHE_MAX = 32
const cachedCapabilitiesByOwnerKey = new Map<
  string,
  { capabilities: WindowsTerminalCapabilities; loadedAt: number }
>()
const pendingCapabilitiesByOwnerKey = new Map<string, Promise<WindowsTerminalCapabilities>>()
let nextCapabilityRequestId = 0
const latestCapabilityRequestIdByOwnerKey = new Map<string, number>()
const subscribersByOwnerKey = new Map<
  string,
  Set<(capabilities: WindowsTerminalCapabilities) => void>
>()

type WindowsTerminalCapabilityHookState = {
  ownerKey: string
  capabilities: WindowsTerminalCapabilities
}

type WindowsTerminalCapabilityLoadTarget = RuntimeClientTarget

export function getWindowsTerminalCapabilityOwnerKey(
  activeRuntimeEnvironmentId?: string | null
): string {
  // Why: remote desktop and paired web clients can switch hosts; Git Bash/WSL availability is
  // host-owned, so a previous runtime's answer must not bleed into the next.
  const environmentId = activeRuntimeEnvironmentId?.trim()
  return environmentId ? `runtime:${environmentId}` : 'local'
}

function publish(
  capabilities: WindowsTerminalCapabilities,
  ownerKey: string,
  loadedAt = Date.now()
): void {
  cachedCapabilitiesByOwnerKey.delete(ownerKey)
  cachedCapabilitiesByOwnerKey.set(ownerKey, { capabilities, loadedAt })
  trimCapabilityOwnerCaches()
  for (const subscriber of subscribersByOwnerKey.get(ownerKey) ?? []) {
    subscriber(capabilities)
  }
}

function pruneExpiredCapabilityOwners(now: number): void {
  for (const [ownerKey, cached] of cachedCapabilitiesByOwnerKey) {
    if (
      now - cached.loadedAt >= CAPABILITY_CACHE_TTL_MS &&
      !pendingCapabilitiesByOwnerKey.has(ownerKey) &&
      !subscribersByOwnerKey.has(ownerKey)
    ) {
      cachedCapabilitiesByOwnerKey.delete(ownerKey)
      latestCapabilityRequestIdByOwnerKey.delete(ownerKey)
    }
  }
}

function trimCapabilityOwnerCaches(): void {
  while (cachedCapabilitiesByOwnerKey.size > CAPABILITY_OWNER_CACHE_MAX) {
    const oldest = cachedCapabilitiesByOwnerKey.keys().next().value
    if (oldest === undefined) {
      break
    }
    cachedCapabilitiesByOwnerKey.delete(oldest)
    if (!pendingCapabilitiesByOwnerKey.has(oldest) && !subscribersByOwnerKey.has(oldest)) {
      latestCapabilityRequestIdByOwnerKey.delete(oldest)
    }
  }
}

export function getCachedWindowsTerminalCapabilities(
  ownerKey = 'local'
): WindowsTerminalCapabilities {
  return cachedCapabilitiesByOwnerKey.get(ownerKey)?.capabilities ?? UNAVAILABLE_CAPABILITIES
}

export function loadWindowsTerminalCapabilities(
  options: {
    force?: boolean
    now?: number
    ownerKey?: string
    target?: WindowsTerminalCapabilityLoadTarget
  } = {}
): Promise<WindowsTerminalCapabilities> {
  const now = options.now ?? Date.now()
  const ownerKey = options.ownerKey ?? 'local'
  const target = options.target ?? { kind: 'local' }
  pruneExpiredCapabilityOwners(now)
  const cached = cachedCapabilitiesByOwnerKey.get(ownerKey)
  if (cached && !options.force && now - cached.loadedAt < CAPABILITY_CACHE_TTL_MS) {
    return Promise.resolve(cached.capabilities)
  }
  const pendingCapabilities = pendingCapabilitiesByOwnerKey.get(ownerKey)
  if (pendingCapabilities && !options.force) {
    return pendingCapabilities
  }

  // Why: Settings, status bar, and paired web tab bars need one shared answer.
  // Separate probes can leave one surface showing stale Windows shell choices.
  const requestId = ++nextCapabilityRequestId
  latestCapabilityRequestIdByOwnerKey.set(ownerKey, requestId)
  const nextPendingCapabilities = Promise.all(readWindowsTerminalCapabilityPromises(target))
    .then(([wslAvailable, wslDistros, pwshAvailable, gitBashAvailable, hostPlatform]) => {
      const capabilities = {
        wslAvailable,
        wslDistros,
        pwshAvailable,
        gitBashAvailable,
        hostPlatform,
        isLoading: false
      }
      if (requestId === latestCapabilityRequestIdByOwnerKey.get(ownerKey)) {
        pendingCapabilitiesByOwnerKey.delete(ownerKey)
        publish(capabilities, ownerKey, now)
        return capabilities
      }
      return getCachedWindowsTerminalCapabilities(ownerKey)
    })
    .catch(() => {
      if (requestId === latestCapabilityRequestIdByOwnerKey.get(ownerKey)) {
        pendingCapabilitiesByOwnerKey.delete(ownerKey)
        publish(UNAVAILABLE_CAPABILITIES, ownerKey, now)
        return UNAVAILABLE_CAPABILITIES
      }
      return getCachedWindowsTerminalCapabilities(ownerKey)
    })

  pendingCapabilitiesByOwnerKey.set(ownerKey, nextPendingCapabilities)
  return nextPendingCapabilities
}

export function refreshWindowsTerminalCapabilities(
  ownerKey = 'local',
  target: WindowsTerminalCapabilityLoadTarget = { kind: 'local' }
): Promise<WindowsTerminalCapabilities> {
  return loadWindowsTerminalCapabilities({ force: true, ownerKey, target })
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
    : (cachedCapabilitiesByOwnerKey.get(ownerKey)?.capabilities ?? UNAVAILABLE_CAPABILITIES)
}

export function useWindowsTerminalCapabilities(
  enabled: boolean,
  forceRefreshOnMount = false,
  ownerKey = 'local',
  target: WindowsTerminalCapabilityLoadTarget = { kind: 'local' }
): WindowsTerminalCapabilities {
  const targetKind = target.kind
  const targetEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const [state, setState] = useState(() => ({
    ownerKey,
    capabilities: getCachedWindowsTerminalCapabilities(ownerKey)
  }))

  useEffect(() => {
    if (!enabled) {
      setState({ ownerKey, capabilities: UNAVAILABLE_CAPABILITIES })
      return
    }
    const loadTarget: WindowsTerminalCapabilityLoadTarget =
      targetKind === 'environment' && targetEnvironmentId
        ? { kind: 'environment', environmentId: targetEnvironmentId }
        : { kind: 'local' }

    let cancelled = false
    const cached = getCachedWindowsTerminalCapabilities(ownerKey)
    const hasOwnerCache = cachedCapabilitiesByOwnerKey.has(ownerKey)
    setState({
      ownerKey,
      capabilities: hasOwnerCache ? cached : { ...cached, isLoading: true }
    })
    const setCapabilities = (capabilities: WindowsTerminalCapabilities): void => {
      setState({ ownerKey, capabilities })
    }
    const subscribers = subscribersByOwnerKey.get(ownerKey) ?? new Set()
    subscribers.add(setCapabilities)
    subscribersByOwnerKey.set(ownerKey, subscribers)
    void loadWindowsTerminalCapabilities({
      force: forceRefreshOnMount,
      ownerKey,
      target: loadTarget
    }).then((nextCapabilities) => {
      if (!cancelled) {
        setState({ ownerKey, capabilities: nextCapabilities })
      }
    })

    return () => {
      cancelled = true
      const currentSubscribers = subscribersByOwnerKey.get(ownerKey)
      currentSubscribers?.delete(setCapabilities)
      if (currentSubscribers?.size === 0) {
        subscribersByOwnerKey.delete(ownerKey)
      }
    }
  }, [enabled, forceRefreshOnMount, ownerKey, targetKind, targetEnvironmentId])

  return selectWindowsTerminalCapabilitiesForOwner(state, enabled, ownerKey)
}

function readWindowsTerminalCapabilityPromises(
  target: WindowsTerminalCapabilityLoadTarget
): [
  Promise<boolean>,
  Promise<string[]>,
  Promise<boolean>,
  Promise<boolean>,
  Promise<NodeJS.Platform | null>
] {
  if (target.kind === 'local') {
    return [
      window.api.wsl.isAvailable().catch(() => false),
      window.api.wsl.listDistros().catch(() => []),
      window.api.pwsh.isAvailable().catch(() => false),
      window.api.gitBash.isAvailable().catch(() => false),
      window.api.runtime
        .getStatus()
        .then((status) => status.hostPlatform ?? null)
        .catch(() => null)
    ]
  }

  return [
    callRuntimeRpc<boolean>(target, 'host.wsl.isAvailable', undefined, { timeoutMs: 15_000 }).catch(
      () => false
    ),
    callRuntimeRpc<string[]>(target, 'host.wsl.listDistros', undefined, {
      timeoutMs: 15_000
    }).catch(() => []),
    callRuntimeRpc<boolean>(target, 'host.pwsh.isAvailable', undefined, {
      timeoutMs: 15_000
    }).catch(() => false),
    callRuntimeRpc<boolean>(target, 'host.gitBash.isAvailable', undefined, {
      timeoutMs: 15_000
    }).catch(() => false),
    callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, { timeoutMs: 15_000 })
      .then((status) => status.hostPlatform ?? null)
      .catch(() => null)
  ]
}

export function resetWindowsTerminalCapabilitiesForTests(): void {
  cachedCapabilitiesByOwnerKey.clear()
  pendingCapabilitiesByOwnerKey.clear()
  nextCapabilityRequestId = 0
  latestCapabilityRequestIdByOwnerKey.clear()
  subscribersByOwnerKey.clear()
}
