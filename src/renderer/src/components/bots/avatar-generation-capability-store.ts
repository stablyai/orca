// Which installed agents can make pictures, kept app-wide so a picture picker's Generate face knows
// what it can run with. Fetched after startup settles, again on each open, and on Check again.
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
/** Whether the probe out skips main's cache. */
let checkingFresh = false
/** A Check again is out (or queued behind a quiet check); the picker shows it as checking. */
let rechecking = false
let freshQueued = false
/** Bumped by each run outcome, so a probe started before one can't overwrite it. */
let evidence = 0
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

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function publish(next: readonly AvatarImageAgentStatus[]): void {
  // An unchanged answer (most refreshes) wakes nobody.
  if (sameAgents(agents, next)) {
    return
  }
  agents = next
  notify()
}

/** Asks main again (its probe is cached briefly; `fresh` skips that); the answer reaches every reader. */
export function refreshAvatarCapability({ fresh = false }: { fresh?: boolean } = {}): void {
  const api = avatarGenerationApi()
  if (!api) {
    return
  }
  if (fresh && !rechecking) {
    // Only Check again shows its progress; the quiet refresh on each open wakes nobody.
    rechecking = true
    notify()
  }
  if (checking) {
    // A fresh check already out answers this one too. A quiet one may reuse main's cache, so a fresh
    // request asks again after it, and the quiet one's older answer is dropped.
    if (fresh && !checkingFresh) {
      freshQueued = true
    }
    return
  }
  probe(api, rechecking)
}

function probe(api: AvatarGenerationApi, fresh: boolean): void {
  // A run outcome learned while this probe is out is newer than its answer.
  const startedAt = evidence
  checkingFresh = fresh
  checking = api
    .capability(fresh ? { fresh: true } : undefined)
    .then(
      (found: AvatarGenerationCapability | undefined) => {
        // A first answer always lands, so Generate never waits on with nothing to show.
        if ((evidence === startedAt || agents === null) && !freshQueued) {
          // A bridge without this namespace (web fallbacks) answers undefined: none found.
          publish(Array.isArray(found?.agents) ? found.agents : [])
        }
      },
      () => {
        // A first check that fails reads as none found, so Generate says so instead of waiting on.
        if (agents === null && !freshQueued) {
          publish([])
        }
      }
    )
    .finally(() => {
      checking = null
      checkingFresh = false
      if (freshQueued) {
        freshQueued = false
        probe(api, true)
      } else if (fresh) {
        rechecking = false
        notify()
      }
    })
}

/** Forgets every answer and check out, as at launch; for tests, since the store is app-wide. */
export function resetAvatarCapabilityForTests(): void {
  agents = null
  checking = null
  checkingFresh = false
  rechecking = false
  freshQueued = false
  evidence = 0
}

/** A run's outcome is fresher than the last check: it proves an agent ready or signed out. */
export function setAvatarAgentStatus(
  agent: AvatarImageAgent,
  status: AvatarImageAgentStatus['status']
): void {
  evidence += 1
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

/** Whether Generate is still finding out: before the first answer, or until Check again's answer. */
export function readAvatarCapabilityChecking(): boolean {
  return agents === null || rechecking
}

export function useAvatarCapabilityChecking(): boolean {
  return useSyncExternalStore(subscribe, readAvatarCapabilityChecking)
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
