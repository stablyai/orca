import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { SkillFreshnessInventory } from '../../../shared/skill-freshness'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'

// Why: window focus fires on every alt-tab, and each scan re-reads and re-hashes
// every installed package; a just-completed scan stays authoritative briefly.
const FOCUS_RESCAN_COOLDOWN_MS = 15_000
let cachedInventory: SkillFreshnessInventory | null = null
let pendingInventory: Promise<SkillFreshnessInventory> | null = null
let invalidationRevision = 0
let completedRevision = -1
let lastCompletedScanAt = 0
let refreshSequence = 0
let scheduledFocusRescan: number | null = null

type SkillFreshnessSnapshot = {
  inventory: SkillFreshnessInventory | null
  loading: boolean
  error: string | null
}

let snapshot: SkillFreshnessSnapshot = {
  inventory: null,
  loading: false,
  error: null
}
const DISABLED_SNAPSHOT: SkillFreshnessSnapshot = Object.freeze({
  inventory: null,
  loading: false,
  error: null
})
const REENABLING_SNAPSHOT: SkillFreshnessSnapshot = Object.freeze({
  inventory: null,
  loading: true,
  error: null
})
const subscribers = new Set<() => void>()
let pendingReenableRefresh: Promise<void> | null = null

function publishSnapshot(next: SkillFreshnessSnapshot): void {
  if (
    snapshot.inventory === next.inventory &&
    snapshot.loading === next.loading &&
    snapshot.error === next.error
  ) {
    return
  }
  snapshot = next
  for (const subscriber of subscribers) {
    subscriber()
  }
}

async function loadInventory(force: boolean): Promise<SkillFreshnessInventory> {
  if (force) {
    invalidationRevision += 1
  }
  const targetRevision = invalidationRevision
  for (;;) {
    if (cachedInventory && completedRevision >= targetRevision) {
      return cachedInventory
    }
    if (!pendingInventory) {
      const requestRevision = invalidationRevision
      const request = window.api.skills
        .freshnessInventory()
        .then((inventory) => {
          cachedInventory = inventory
          completedRevision = Math.max(completedRevision, requestRevision)
          lastCompletedScanAt = Date.now()
          return inventory
        })
        .finally(() => {
          if (pendingInventory === request) {
            pendingInventory = null
          }
        })
      pendingInventory = request
    }
    await pendingInventory
  }
}

/** Rescan freshness without going through the hook, for surfaces whose explicit
 *  refresh affordance must move the shared verdict (the installed-skills refreshed
 *  event reuses a completed scan and deliberately does not reach this store). */
export async function refreshSkillFreshness(force = true): Promise<void> {
  if (scheduledFocusRescan !== null) {
    window.clearTimeout(scheduledFocusRescan)
    scheduledFocusRescan = null
  }
  const sequence = ++refreshSequence
  // Why: eligibility is write authority for the draft command. Once invalidated,
  // stale bytes must stop authorizing UI even if the replacement scan fails.
  publishSnapshot({ inventory: null, loading: true, error: null })
  try {
    const inventory = await loadInventory(force)
    if (sequence === refreshSequence) {
      publishSnapshot({ inventory, loading: false, error: null })
    }
  } catch (cause) {
    if (sequence === refreshSequence) {
      publishSnapshot({
        inventory: null,
        loading: false,
        error: cause instanceof Error ? cause.message : 'Could not inspect Orca skills.'
      })
    }
  }
}

function onWindowFocus(): void {
  const cooldownRemaining = FOCUS_RESCAN_COOLDOWN_MS - (Date.now() - lastCompletedScanAt)
  if (cooldownRemaining <= 0) {
    void refreshSkillFreshness(true)
    return
  }
  if (!snapshot.inventory?.eligibleUpdateNames.length || scheduledFocusRescan !== null) {
    return
  }
  // Why: a focus event can follow an external edit. Retract stale update
  // authority immediately, but keep rapid alt-tabs to one trailing disk scan.
  publishSnapshot({ inventory: null, loading: true, error: null })
  scheduledFocusRescan = window.setTimeout(
    () => {
      scheduledFocusRescan = null
      void refreshSkillFreshness(true)
    },
    Math.min(cooldownRemaining, FOCUS_RESCAN_COOLDOWN_MS)
  )
}

function onInstalledSkillsChanged(): void {
  void refreshSkillFreshness(true)
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  if (subscribers.size === 1) {
    // Why: every consumer reads one external snapshot, so focus/install events
    // install one listener and trigger one shared IPC scan regardless of UI count.
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onInstalledSkillsChanged)
  }
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) {
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onInstalledSkillsChanged)
      if (scheduledFocusRescan !== null) {
        window.clearTimeout(scheduledFocusRescan)
        scheduledFocusRescan = null
      }
    }
  }
}

function subscribeDisabled(): () => void {
  return () => {}
}

function getSnapshot(): SkillFreshnessSnapshot {
  return snapshot
}

function getDisabledSnapshot(): SkillFreshnessSnapshot {
  return DISABLED_SNAPSHOT
}

function ensureInventoryLoaded(): void {
  if (!snapshot.inventory && !snapshot.loading) {
    void refreshSkillFreshness(false)
  }
}

export type SkillFreshnessState = SkillFreshnessSnapshot & {
  refresh: () => Promise<void>
}

async function skipSkillFreshnessRefresh(): Promise<void> {}

function refreshSkillFreshnessAfterReenable(): Promise<void> {
  pendingReenableRefresh ??= refreshSkillFreshness(true).finally(() => {
    pendingReenableRefresh = null
  })
  return pendingReenableRefresh
}

export function useSkillFreshness(enabled = true): SkillFreshnessState {
  const previousEnabledRef = useRef(enabled)
  const reenabled = enabled && !previousEnabledRef.current
  const current = useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    enabled ? getSnapshot : getDisabledSnapshot,
    enabled ? getSnapshot : getDisabledSnapshot
  )

  useEffect(() => {
    const wasEnabled = previousEnabledRef.current
    previousEnabledRef.current = enabled
    if (!enabled) {
      return
    }
    if (!wasEnabled) {
      void refreshSkillFreshnessAfterReenable()
      return
    }
    ensureInventoryLoaded()
  }, [enabled])

  return {
    ...(reenabled ? REENABLING_SNAPSHOT : current),
    refresh: enabled ? refreshSkillFreshness : skipSkillFreshnessRefresh
  }
}

export const _skillFreshnessCacheForTests = {
  reset(): void {
    cachedInventory = null
    pendingInventory = null
    invalidationRevision = 0
    completedRevision = -1
    lastCompletedScanAt = 0
    refreshSequence = 0
    pendingReenableRefresh = null
    if (scheduledFocusRescan !== null) {
      window.clearTimeout(scheduledFocusRescan)
      scheduledFocusRescan = null
    }
    snapshot = { inventory: null, loading: false, error: null }
  }
}
