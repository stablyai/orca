import { useSyncExternalStore } from 'react'
import {
  getKnownPRAutoRefreshCadenceForHost,
  getPRAutoRefreshCadenceForHost,
  setPRAutoRefreshCadenceForHost,
  subscribePRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'

// Why no store or RPC imports here: store slice code reads these; the reads and host-contact
// subscriptions that feed them live in remote-host-pr-auto-refresh-cadence-sync.ts.

// Each remember or forget of a host advances its generation, so a settings.get that was in flight
// when a newer authoritative value landed (a write from the Settings control, an unpairing) can tell
// its answer is obsolete and drop it.
const generations = new Map<string, number>()

function advanceGeneration(environmentId: string): void {
  generations.set(environmentId, hostPRAutoRefreshCadenceGeneration(environmentId) + 1)
}

// Hosts that answered `settings.get` without the setting: an Orca that predates it. Such a host
// polls at Default and rejects a write of the key, so the control must say so instead of waiting
// for an answer that never comes. Kept apart from "not answered yet".
const hostsLackingSetting = new Set<string>()
const lackListeners = new Set<() => void>()

function setHostLacksSetting(environmentId: string, lacks: boolean): void {
  if (hostsLackingSetting.has(environmentId) === lacks) {
    return
  }
  if (lacks) {
    hostsLackingSetting.add(environmentId)
  } else {
    hostsLackingSetting.delete(environmentId)
  }
  for (const listener of Array.from(lackListeners)) {
    listener()
  }
}

/** The cadence of a paired host, as this client last learned it; Default until it answers. */
export function hostPRAutoRefreshCadence(environmentId: string | null): PRAutoRefreshCadence {
  return getPRAutoRefreshCadenceForHost(environmentId)
}

/** A value just read from or written to the host (Settings control, settings.get) is authoritative. */
export function rememberHostPRAutoRefreshCadence(environmentId: string, value: unknown): void {
  advanceGeneration(environmentId)
  setHostLacksSetting(environmentId, false)
  setPRAutoRefreshCadenceForHost(environmentId, value)
}

export function forgetHostPRAutoRefreshCadence(environmentId: string): void {
  advanceGeneration(environmentId)
  setHostLacksSetting(environmentId, false)
  setPRAutoRefreshCadenceForHost(environmentId, null)
}

/** The host answered without the setting (an older Orca). It keeps no value here, so every
 *  scheduler reads it as Default, which is what that host does. */
export function noteHostLacksPRAutoRefresh(environmentId: string): void {
  advanceGeneration(environmentId)
  setPRAutoRefreshCadenceForHost(environmentId, null)
  setHostLacksSetting(environmentId, true)
}

export function hostLacksPRAutoRefresh(environmentId: string): boolean {
  return hostsLackingSetting.has(environmentId)
}

function subscribeHostLacksSetting(listener: () => void): () => void {
  lackListeners.add(listener)
  return () => {
    lackListeners.delete(listener)
  }
}

/** Whether the paired host is an older Orca without the setting; false for no host. */
export function useHostLacksPRAutoRefresh(environmentId: string | null): boolean {
  return useSyncExternalStore(subscribeHostLacksSetting, () =>
    environmentId ? hostLacksPRAutoRefresh(environmentId) : false
  )
}

/** The host's setting as this client last learned it, or null while unknown (still reading). */
export function knownHostPRAutoRefreshCadence(environmentId: string): PRAutoRefreshCadence | null {
  return getKnownPRAutoRefreshCadenceForHost(environmentId)
}

/** The one authoritative copy of a paired host's setting, live: whatever reads or writes it (the
 *  host's `settingsChanged`, regained contact, this or another window's Settings control) shows
 *  here at once. null while the host has not answered, or for no host. */
export function useHostPRAutoRefreshCadence(
  environmentId: string | null
): PRAutoRefreshCadence | null {
  return useSyncExternalStore(subscribePRAutoRefreshCadence, () =>
    environmentId ? knownHostPRAutoRefreshCadence(environmentId) : null
  )
}

export function hostPRAutoRefreshCadenceGeneration(environmentId: string): number {
  return generations.get(environmentId) ?? 0
}

export function _resetHostPRAutoRefreshCadenceGenerationsForTests(): void {
  generations.clear()
  hostsLackingSetting.clear()
  lackListeners.clear()
}
