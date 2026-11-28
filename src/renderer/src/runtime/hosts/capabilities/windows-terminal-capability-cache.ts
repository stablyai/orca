import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { readWindowsTerminalCapabilities } from './windows-terminal-capability-read'
import { isWindowsTerminalCapabilityOwnerHeld } from './windows-terminal-capability-holds'
import { capabilitiesToCache, freshCachedCapabilities } from './windows-terminal-capability-host'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type WindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  gitBashAvailable: boolean
  hostPlatform: NodeJS.Platform | null
  isLoading: boolean
}

export const UNAVAILABLE_CAPABILITIES: WindowsTerminalCapabilities = {
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
  { capabilities: WindowsTerminalCapabilities; loadedAt: number; gitBashProbed: boolean }
>()
const pendingCapabilitiesByOwnerKey = new Map<string, Promise<WindowsTerminalCapabilities>>()
let nextCapabilityRequestId = 0
const latestCapabilityRequestIdByOwnerKey = new Map<string, number>()
const subscribersByOwnerKey = new Map<
  string,
  Set<(capabilities: WindowsTerminalCapabilities) => void>
>()

export function resolveWindowsTerminalCapabilityCacheKey(args: {
  ownerKey?: string
  target?: RuntimeClientTarget
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
  // Shell availability belongs to hosts; runtime switches must not reuse previous-owner Git Bash/WSL answers.
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
  loadedAt = Date.now(),
  gitBashProbed = false
): void {
  cachedCapabilitiesByOwnerKey.delete(ownerKey)
  cachedCapabilitiesByOwnerKey.set(ownerKey, { capabilities, loadedAt, gitBashProbed })
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
      !subscribersByOwnerKey.has(ownerKey) &&
      !isWindowsTerminalCapabilityOwnerHeld(ownerKey)
    ) {
      cachedCapabilitiesByOwnerKey.delete(ownerKey)
      latestCapabilityRequestIdByOwnerKey.delete(ownerKey)
    }
  }
}

function trimCapabilityOwnerCaches(): void {
  // Owners still in use (a mounted subscriber or a released strip's hold) are never evicted, so the cache
  // exceeds this cap only by live owners, which are bounded by mounted and released strips.
  for (const ownerKey of cachedCapabilitiesByOwnerKey.keys()) {
    if (cachedCapabilitiesByOwnerKey.size <= CAPABILITY_OWNER_CACHE_MAX) {
      break
    }
    if (subscribersByOwnerKey.has(ownerKey) || isWindowsTerminalCapabilityOwnerHeld(ownerKey)) {
      continue
    }
    cachedCapabilitiesByOwnerKey.delete(ownerKey)
    if (!pendingCapabilitiesByOwnerKey.has(ownerKey) && !subscribersByOwnerKey.has(ownerKey)) {
      latestCapabilityRequestIdByOwnerKey.delete(ownerKey)
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

/** This machine's probed Git Bash availability for local launches; undefined when unknown. */
export function getProbedLocalGitBashAvailability(): boolean | undefined {
  if (isWebClientLocation()) {
    return undefined
  }
  const cached = cachedCapabilitiesByOwnerKey.get('local')
  return cached?.gitBashProbed ? cached.capabilities.gitBashAvailable : undefined
}

export function loadWindowsTerminalCapabilities(
  options: {
    force?: boolean
    now?: number
    ownerKey?: string
    target?: RuntimeClientTarget
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
  const fresh = freshCachedCapabilities(
    cached,
    UNAVAILABLE_CAPABILITIES,
    now,
    CAPABILITY_CACHE_TTL_MS,
    options.force
  )
  if (fresh) {
    return Promise.resolve(fresh)
  }
  const pendingCapabilities = pendingCapabilitiesByOwnerKey.get(ownerKey)
  if (pendingCapabilities && !options.force) {
    return pendingCapabilities
  }

  // Share one probe across Settings/status/web bars or shell choices can disagree.
  const requestId = ++nextCapabilityRequestId
  latestCapabilityRequestIdByOwnerKey.set(ownerKey, requestId)
  const isLocalDesktopRead = target.kind === 'local' && !sshConnectionId
  const nextPendingCapabilities = readWindowsTerminalCapabilities(target, sshConnectionId)
    .then(({ capabilities, gitBashProbed }) => {
      if (requestId === latestCapabilityRequestIdByOwnerKey.get(ownerKey)) {
        pendingCapabilitiesByOwnerKey.delete(ownerKey)
        const published = capabilitiesToCache(capabilities, gitBashProbed, UNAVAILABLE_CAPABILITIES)
        publish(published, ownerKey, now, gitBashProbed && isLocalDesktopRead)
        return published
      }
      return getCachedWindowsTerminalCapabilities(ownerKey)
    })
    .catch(() => {
      if (requestId === latestCapabilityRequestIdByOwnerKey.get(ownerKey)) {
        pendingCapabilitiesByOwnerKey.delete(ownerKey)
        publish(UNAVAILABLE_CAPABILITIES, ownerKey, now, false)
        return UNAVAILABLE_CAPABILITIES
      }
      return getCachedWindowsTerminalCapabilities(ownerKey)
    })

  pendingCapabilitiesByOwnerKey.set(ownerKey, nextPendingCapabilities)
  return nextPendingCapabilities
}

export function resetWindowsTerminalCapabilitiesForTests(): void {
  cachedCapabilitiesByOwnerKey.clear()
  pendingCapabilitiesByOwnerKey.clear()
  nextCapabilityRequestId = 0
  latestCapabilityRequestIdByOwnerKey.clear()
  subscribersByOwnerKey.clear()
}

export function watchWindowsTerminalCapabilities(
  ownerKey: string,
  subscriber: (capabilities: WindowsTerminalCapabilities) => void
): () => void {
  const subscribers = subscribersByOwnerKey.get(ownerKey) ?? new Set()
  subscribers.add(subscriber)
  subscribersByOwnerKey.set(ownerKey, subscribers)
  return () => {
    const currentSubscribers = subscribersByOwnerKey.get(ownerKey)
    currentSubscribers?.delete(subscriber)
    if (currentSubscribers?.size === 0) {
      subscribersByOwnerKey.delete(ownerKey)
    }
  }
}
