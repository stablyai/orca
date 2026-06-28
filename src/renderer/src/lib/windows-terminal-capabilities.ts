import { useEffect, useMemo, useState } from 'react'
import {
  readWindowsTerminalCapabilities,
  type WindowsTerminalCapabilityLoadTarget
} from './windows-terminal-capability-read'

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

function resolveWindowsTerminalCapabilityCacheKey(args: {
  ownerKey?: string
  target?: WindowsTerminalCapabilityLoadTarget
  sshConnectionId?: string | null
}): string {
  const explicitOwnerKey = args.ownerKey?.trim()
  if (explicitOwnerKey) {
    return explicitOwnerKey
  }
  const environmentId = args.target?.kind === 'environment' ? args.target.environmentId : null
  return getWindowsTerminalCapabilityOwnerKey(environmentId, args.sshConnectionId)
}

export function getWindowsTerminalCapabilityOwnerKey(
  activeRuntimeEnvironmentId?: string | null,
  sshConnectionId?: string | null
): string {
  // Why: remote desktop and paired web clients can switch hosts; Git Bash/WSL availability is
  // host-owned, so a previous runtime's answer must not bleed into the next.
  const connectionId = sshConnectionId?.trim()
  const environmentId = activeRuntimeEnvironmentId?.trim()
  if (connectionId && environmentId) {
    return `runtime:${environmentId}:ssh:${connectionId}`
  }
  if (connectionId) {
    return `ssh:${connectionId}`
  }
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

export function hasCachedWindowsTerminalCapabilities(ownerKey = 'local'): boolean {
  return cachedCapabilitiesByOwnerKey.has(ownerKey)
}

export function loadWindowsTerminalCapabilities(
  options: {
    force?: boolean
    now?: number
    ownerKey?: string
    target?: WindowsTerminalCapabilityLoadTarget
    sshConnectionId?: string | null
  } = {}
): Promise<WindowsTerminalCapabilities> {
  const now = options.now ?? Date.now()
  const sshConnectionId = options.sshConnectionId?.trim() || null
  const target = options.target ?? { kind: 'local' }
  const ownerKey = resolveWindowsTerminalCapabilityCacheKey({
    ownerKey: options.ownerKey,
    target,
    sshConnectionId
  })
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
  const nextPendingCapabilities = readWindowsTerminalCapabilities(target, sshConnectionId)
    .then((capabilities) => {
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
  ownerKey: string | undefined = undefined,
  target: WindowsTerminalCapabilityLoadTarget = { kind: 'local' },
  sshConnectionId?: string | null
): Promise<WindowsTerminalCapabilities> {
  return loadWindowsTerminalCapabilities({ force: true, ownerKey, target, sshConnectionId })
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
  ownerKey: string | undefined = undefined,
  target: WindowsTerminalCapabilityLoadTarget = { kind: 'local' },
  sshConnectionId?: string | null
): WindowsTerminalCapabilities {
  const targetKind = target.kind
  const targetEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const sshConnectionIdKey = sshConnectionId?.trim() || null
  const resolvedTarget: WindowsTerminalCapabilityLoadTarget = useMemo(
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
    const hasOwnerCache = cachedCapabilitiesByOwnerKey.has(resolvedOwnerKey)
    setState({
      ownerKey: resolvedOwnerKey,
      capabilities: hasOwnerCache ? cached : { ...cached, isLoading: true }
    })
    const setCapabilities = (capabilities: WindowsTerminalCapabilities): void => {
      setState({ ownerKey: resolvedOwnerKey, capabilities })
    }
    const subscribers = subscribersByOwnerKey.get(resolvedOwnerKey) ?? new Set()
    subscribers.add(setCapabilities)
    subscribersByOwnerKey.set(resolvedOwnerKey, subscribers)
    void loadWindowsTerminalCapabilities({
      force: forceRefreshOnMount,
      ownerKey: resolvedOwnerKey,
      target: resolvedTarget,
      sshConnectionId: sshConnectionIdKey
    }).then((nextCapabilities) => {
      if (!cancelled) {
        setState({ ownerKey: resolvedOwnerKey, capabilities: nextCapabilities })
      }
    })

    return () => {
      cancelled = true
      const currentSubscribers = subscribersByOwnerKey.get(resolvedOwnerKey)
      currentSubscribers?.delete(setCapabilities)
      if (currentSubscribers?.size === 0) {
        subscribersByOwnerKey.delete(resolvedOwnerKey)
      }
    }
  }, [enabled, forceRefreshOnMount, resolvedOwnerKey, resolvedTarget, sshConnectionIdKey])

  return selectWindowsTerminalCapabilitiesForOwner(state, enabled, resolvedOwnerKey)
}

export function resetWindowsTerminalCapabilitiesForTests(): void {
  cachedCapabilitiesByOwnerKey.clear()
  pendingCapabilitiesByOwnerKey.clear()
  nextCapabilityRequestId = 0
  latestCapabilityRequestIdByOwnerKey.clear()
  subscribersByOwnerKey.clear()
}
