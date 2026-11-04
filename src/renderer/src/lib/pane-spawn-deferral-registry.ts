import { useSyncExternalStore } from 'react'
import type { SpawnDeferralReason } from '../../../shared/host-spawn-admission'

export type PaneSpawnDeferral = {
  reason: SpawnDeferralReason
  resume: () => void
  /** The retry is in flight; the pane still owns the session but shows no overlay. */
  resuming?: true
  /** Offered only for a pause on a host that can clear it. */
  resumeAutomaticRestores?: () => void
}

// Why module state: the pane session is imperative and outlives renders; overlays only read it.
const deferralsByPaneKey = new Map<string, PaneSpawnDeferral>()
// Why: a hidden pane holding its sleeping agent's resume until shown owns that session too, with no overlay.
const revealHoldsByPaneKey = new Map<string, () => boolean>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function setPaneSpawnDeferral(paneKey: string, deferral: PaneSpawnDeferral): void {
  deferralsByPaneKey.set(paneKey, deferral)
  notify()
}

export function clearPaneSpawnDeferral(paneKey: string): void {
  if (deferralsByPaneKey.delete(paneKey)) {
    notify()
  }
}

export function getPaneSpawnDeferral(paneKey: string): PaneSpawnDeferral | undefined {
  return deferralsByPaneKey.get(paneKey)
}

/** A mounted pane holding a restore its host deferred, or one held until shown; it owns that session's resume. */
export function isPaneSpawnDeferred(paneKey: string): boolean {
  return deferralsByPaneKey.has(paneKey) || revealHoldsByPaneKey.get(paneKey)?.() === true
}

export function holdPaneResumeUntilShown(paneKey: string, isHolding: () => boolean): void {
  revealHoldsByPaneKey.set(paneKey, isHolding)
}

/** Only the hold's own pane releases it; a remount may already have replaced it. */
export function releasePaneResumeHold(paneKey: string, isHolding: () => boolean): void {
  if (revealHoldsByPaneKey.get(paneKey) === isHolding) {
    revealHoldsByPaneKey.delete(paneKey)
  }
}

// An in-place resumed start owns its session until settlement even while main clears the old terminal binding.
const inPlaceResumesByPaneKey = new Map<string, Set<() => boolean>>()

/** Returns the release; `isLive` lets a disposed pane stop owning a start that never settles. */
export function holdPaneResumeInPlace(paneKey: string, isLive: () => boolean): () => void {
  const holds = inPlaceResumesByPaneKey.get(paneKey) ?? new Set()
  holds.add(isLive)
  inPlaceResumesByPaneKey.set(paneKey, holds)
  return () => {
    holds.delete(isLive)
    if (holds.size === 0 && inPlaceResumesByPaneKey.get(paneKey) === holds) {
      inPlaceResumesByPaneKey.delete(paneKey)
    }
  }
}

export function isPaneResumingInPlace(paneKey: string): boolean {
  return [...(inPlaceResumesByPaneKey.get(paneKey) ?? [])].some((isLive) => isLive())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePaneSpawnDeferral(paneKey: string): PaneSpawnDeferral | undefined {
  return useSyncExternalStore(subscribe, () => deferralsByPaneKey.get(paneKey))
}
