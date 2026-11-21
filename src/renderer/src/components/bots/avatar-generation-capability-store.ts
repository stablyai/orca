// Which installed agents can make pictures, kept app-wide so a picture picker knows at its first
// render whether it has a Generate face. Fetched after startup settles and again on each open.
import { useEffect, useSyncExternalStore } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store'
import { scheduleAfterInputQuiet } from '@/lib/window-activity/input-quiet-scheduler'
import type {
  AvatarGenerationApi,
  AvatarGenerationCapability,
  AvatarImageAgent,
  AvatarImageAgentStatus
} from '../../../../shared/avatar-generation/avatar-generation-contract'

/** null until the first check answers. */
let agents: readonly AvatarImageAgentStatus[] | null = null
let checking: Promise<void> | null = null
const listeners = new Set<() => void>()

export function avatarGenerationApi(): AvatarGenerationApi | null {
  // Desktop only: a paired web or phone client has no local agents to run.
  return isWebClientLocation() ? null : (window.api?.avatarGeneration ?? null)
}

function sameAgents(
  a: readonly AvatarImageAgentStatus[] | null,
  b: readonly AvatarImageAgentStatus[]
): boolean {
  return (
    a !== null &&
    a.length === b.length &&
    a.every((entry, i) => entry.agent === b[i]?.agent && entry.status === b[i]?.status)
  )
}

function publish(next: readonly AvatarImageAgentStatus[]): void {
  // An unchanged answer (most refreshes) wakes nobody.
  if (sameAgents(agents, next)) {
    return
  }
  agents = next
  for (const listener of listeners) {
    listener()
  }
}

/** Asks main again (its probe is cached briefly); the answer reaches every reader. */
export function refreshAvatarCapability(): void {
  const api = avatarGenerationApi()
  if (!api || checking) {
    return
  }
  checking = api
    .capability()
    .then(
      (found: AvatarGenerationCapability | undefined) => {
        // A bridge without this namespace (web fallbacks) answers undefined: no Generate.
        publish(Array.isArray(found?.agents) ? found.agents : [])
      },
      () => {}
    )
    .finally(() => {
      checking = null
    })
}

/** A run's outcome is fresher than the last check: it proves an agent ready or signed out. */
export function setAvatarAgentStatus(
  agent: AvatarImageAgent,
  status: AvatarImageAgentStatus['status']
): void {
  if (agents?.some((entry) => entry.agent === agent && entry.status !== status)) {
    publish(agents.map((entry) => (entry.agent === agent ? { agent, status } : entry)))
  }
}

export function readAvatarCapability(): readonly AvatarImageAgentStatus[] | null {
  return agents
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAvatarCapability(): readonly AvatarImageAgentStatus[] | null {
  return useSyncExternalStore(subscribe, readAvatarCapability)
}

function detectedAgentsKey(ids: readonly string[] | null): string | null {
  return ids ? [...ids].sort().join(' ') : null
}

/** Checks once startup settles, so the first picture picker opened already knows the answer,
 *  and again whenever the launcher detects a different set of installed agents. */
export function usePrefetchAvatarCapability(): void {
  useEffect(() => {
    const cancel = scheduleAfterInputQuiet(refreshAvatarCapability, {
      delayMs: 3_000,
      quietMs: 500,
      idleTimeoutMs: 2_000,
      maxWaitMs: 10_000
    })
    let seenIds = useAppStore.getState().detectedAgentIds
    let seen = detectedAgentsKey(seenIds)
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.detectedAgentIds === seenIds) {
        return
      }
      seenIds = state.detectedAgentIds
      const key = detectedAgentsKey(seenIds)
      if (key === seen) {
        return
      }
      const first = seen === null
      seen = key
      // The first detection only confirms what the startup check will ask anyway.
      if (!first && key !== null) {
        refreshAvatarCapability()
      }
    })
    return () => {
      cancel()
      unsubscribe()
    }
  }, [])
}

/** As if the check had already answered `next` before anything opened. */
export function seedAvatarCapabilityForTest(next: readonly AvatarImageAgentStatus[]): void {
  publish(next)
}

export function resetAvatarCapabilityForTest(): void {
  agents = null
  checking = null
  listeners.clear()
}
