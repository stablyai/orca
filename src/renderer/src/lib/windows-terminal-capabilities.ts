import { useEffect, useState } from 'react'

export type WindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  gitBashAvailable: boolean
  isLoading: boolean
}

const UNAVAILABLE_CAPABILITIES: WindowsTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  gitBashAvailable: false,
  isLoading: false
}

const CAPABILITY_CACHE_TTL_MS = 30_000
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

export function getWindowsTerminalCapabilityOwnerKey(
  activeRuntimeEnvironmentId?: string | null
): string {
  const isWebClient = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
  if (!isWebClient) {
    return 'local'
  }
  // Why: paired web clients can switch hosts; Git Bash/WSL availability is
  // host-owned, so a previous runtime's answer must not bleed into the next.
  return `runtime:${activeRuntimeEnvironmentId?.trim() || 'none'}`
}

function publish(
  capabilities: WindowsTerminalCapabilities,
  ownerKey: string,
  loadedAt = Date.now()
): void {
  cachedCapabilitiesByOwnerKey.set(ownerKey, { capabilities, loadedAt })
  for (const subscriber of subscribersByOwnerKey.get(ownerKey) ?? []) {
    subscriber(capabilities)
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
  } = {}
): Promise<WindowsTerminalCapabilities> {
  const now = options.now ?? Date.now()
  const ownerKey = options.ownerKey ?? 'local'
  const cached = cachedCapabilitiesByOwnerKey.get(ownerKey)
  if (cached && !options.force && now - cached.loadedAt < CAPABILITY_CACHE_TTL_MS) {
    return Promise.resolve(cached.capabilities)
  }
  const pendingCapabilities = pendingCapabilitiesByOwnerKey.get(ownerKey)
  if (pendingCapabilities && !options.force) {
    return pendingCapabilities
  }

  // Why: Settings and the tab bar need one shared answer. Separate probes can
  // leave Settings rendering without WSL while the "+" menu already shows it.
  const requestId = ++nextCapabilityRequestId
  latestCapabilityRequestIdByOwnerKey.set(ownerKey, requestId)
  const nextPendingCapabilities = Promise.all([
    window.api.wsl.isAvailable().catch(() => false),
    window.api.wsl.listDistros().catch(() => []),
    window.api.pwsh.isAvailable().catch(() => false),
    window.api.gitBash.isAvailable().catch(() => false)
  ])
    .then(([wslAvailable, wslDistros, pwshAvailable, gitBashAvailable]) => {
      const capabilities = {
        wslAvailable,
        wslDistros,
        pwshAvailable,
        gitBashAvailable,
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
  ownerKey = 'local'
): Promise<WindowsTerminalCapabilities> {
  return loadWindowsTerminalCapabilities({ force: true, ownerKey })
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
  ownerKey = 'local'
): WindowsTerminalCapabilities {
  const [state, setState] = useState(() => ({
    ownerKey,
    capabilities: getCachedWindowsTerminalCapabilities(ownerKey)
  }))

  useEffect(() => {
    if (!enabled) {
      setState({ ownerKey, capabilities: UNAVAILABLE_CAPABILITIES })
      return
    }

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
    void loadWindowsTerminalCapabilities({ force: forceRefreshOnMount, ownerKey }).then(
      (nextCapabilities) => {
        if (!cancelled) {
          setState({ ownerKey, capabilities: nextCapabilities })
        }
      }
    )

    return () => {
      cancelled = true
      const currentSubscribers = subscribersByOwnerKey.get(ownerKey)
      currentSubscribers?.delete(setCapabilities)
      if (currentSubscribers?.size === 0) {
        subscribersByOwnerKey.delete(ownerKey)
      }
    }
  }, [enabled, forceRefreshOnMount, ownerKey])

  return selectWindowsTerminalCapabilitiesForOwner(state, enabled, ownerKey)
}

export function resetWindowsTerminalCapabilitiesForTests(): void {
  cachedCapabilitiesByOwnerKey.clear()
  pendingCapabilitiesByOwnerKey.clear()
  nextCapabilityRequestId = 0
  latestCapabilityRequestIdByOwnerKey.clear()
  subscribersByOwnerKey.clear()
}
