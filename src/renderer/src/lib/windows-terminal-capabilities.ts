import { useEffect, useState } from 'react'

export type WindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  isLoading: boolean
}

const UNAVAILABLE_CAPABILITIES: WindowsTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  isLoading: false
}

const CAPABILITY_CACHE_TTL_MS = 30_000
let cachedCapabilities: WindowsTerminalCapabilities | null = null
let cachedCapabilitiesLoadedAt = 0
let pendingCapabilities: Promise<WindowsTerminalCapabilities> | null = null
let latestCapabilityRequestId = 0
const subscribers = new Set<(capabilities: WindowsTerminalCapabilities) => void>()

function publish(capabilities: WindowsTerminalCapabilities, loadedAt = Date.now()): void {
  cachedCapabilities = capabilities
  cachedCapabilitiesLoadedAt = loadedAt
  for (const subscriber of subscribers) {
    subscriber(capabilities)
  }
}

export function getCachedWindowsTerminalCapabilities(): WindowsTerminalCapabilities {
  return cachedCapabilities ?? UNAVAILABLE_CAPABILITIES
}

export function loadWindowsTerminalCapabilities(
  options: {
    force?: boolean
    now?: number
  } = {}
): Promise<WindowsTerminalCapabilities> {
  const now = options.now ?? Date.now()
  if (
    cachedCapabilities &&
    !options.force &&
    now - cachedCapabilitiesLoadedAt < CAPABILITY_CACHE_TTL_MS
  ) {
    return Promise.resolve(cachedCapabilities)
  }
  if (pendingCapabilities && !options.force) {
    return pendingCapabilities
  }

  // Why: Settings and the tab bar need one shared answer. Separate probes can
  // leave Settings rendering without WSL while the "+" menu already shows it.
  const requestId = ++latestCapabilityRequestId
  pendingCapabilities = Promise.all([
    window.api.wsl.isAvailable().catch(() => false),
    window.api.wsl.listDistros().catch(() => []),
    window.api.pwsh.isAvailable().catch(() => false)
  ])
    .then(([wslAvailable, wslDistros, pwshAvailable]) => {
      const capabilities = { wslAvailable, wslDistros, pwshAvailable, isLoading: false }
      if (requestId === latestCapabilityRequestId) {
        pendingCapabilities = null
        publish(capabilities, now)
        return capabilities
      }
      return getCachedWindowsTerminalCapabilities()
    })
    .catch(() => {
      if (requestId === latestCapabilityRequestId) {
        pendingCapabilities = null
        publish(UNAVAILABLE_CAPABILITIES, now)
        return UNAVAILABLE_CAPABILITIES
      }
      return getCachedWindowsTerminalCapabilities()
    })

  return pendingCapabilities
}

export function refreshWindowsTerminalCapabilities(): Promise<WindowsTerminalCapabilities> {
  return loadWindowsTerminalCapabilities({ force: true })
}

export function useWindowsTerminalCapabilities(
  enabled: boolean,
  forceRefreshOnMount = false
): WindowsTerminalCapabilities {
  const [capabilities, setCapabilities] = useState(getCachedWindowsTerminalCapabilities)

  useEffect(() => {
    if (!enabled) {
      setCapabilities(UNAVAILABLE_CAPABILITIES)
      return
    }

    const cached = getCachedWindowsTerminalCapabilities()
    setCapabilities(cachedCapabilities ? cached : { ...cached, isLoading: true })
    subscribers.add(setCapabilities)
    void loadWindowsTerminalCapabilities({ force: forceRefreshOnMount }).then(setCapabilities)

    return () => {
      subscribers.delete(setCapabilities)
    }
  }, [enabled, forceRefreshOnMount])

  return enabled ? capabilities : UNAVAILABLE_CAPABILITIES
}

export function resetWindowsTerminalCapabilitiesForTests(): void {
  cachedCapabilities = null
  cachedCapabilitiesLoadedAt = 0
  pendingCapabilities = null
  latestCapabilityRequestId = 0
  subscribers.clear()
}
