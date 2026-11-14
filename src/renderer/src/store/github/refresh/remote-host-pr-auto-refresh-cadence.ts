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

/** A host's settings.get while it is in flight. A newer authoritative value (a write from the
 *  Settings control, another answer) revokes it so its answer is dropped; forgetting the host also
 *  retires it, so nothing it started reaches a host that is gone. */
export type HostPRAutoRefreshCadenceRead = { revoked: boolean; retired: boolean }

// Only reads still in flight are kept, so a host leaves nothing behind once it is forgotten.
const pendingReads = new Map<string, HostPRAutoRefreshCadenceRead>()

export function beginHostPRAutoRefreshCadenceRead(
  environmentId: string
): HostPRAutoRefreshCadenceRead {
  const read = { revoked: false, retired: false }
  pendingReads.set(environmentId, read)
  return read
}

export function endHostPRAutoRefreshCadenceRead(
  environmentId: string,
  read: HostPRAutoRefreshCadenceRead
): void {
  if (pendingReads.get(environmentId) === read) {
    pendingReads.delete(environmentId)
  }
}

function revokePendingRead(environmentId: string, retire = false): void {
  const read = pendingReads.get(environmentId)
  if (!read) {
    return
  }
  read.revoked = true
  if (retire) {
    read.retired = true
    pendingReads.delete(environmentId)
  }
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

/** A value just read from or written to the host (Settings control, settings.get) is authoritative.
 *  A write's answer may be older than a read already asked for (another client's later change
 *  started it), so the write keeps that read and its owner checks it again (`keepPendingRead`). */
export function rememberHostPRAutoRefreshCadence(
  environmentId: string,
  value: unknown,
  { keepPendingRead = false }: { keepPendingRead?: boolean } = {}
): void {
  if (!keepPendingRead) {
    revokePendingRead(environmentId)
  }
  setHostLacksSetting(environmentId, false)
  setPRAutoRefreshCadenceForHost(environmentId, value)
}

export function forgetHostPRAutoRefreshCadence(environmentId: string): void {
  revokePendingRead(environmentId, true)
  setHostLacksSetting(environmentId, false)
  setPRAutoRefreshCadenceForHost(environmentId, null)
}

/** The host answered without the setting (an older Orca). It keeps no value here, so every
 *  scheduler reads it as Default, which is what that host does. */
export function noteHostLacksPRAutoRefresh(environmentId: string): void {
  revokePendingRead(environmentId)
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

/** How many hosts this client keeps any per-host read or support state for. */
export function _trackedHostPRAutoRefreshStateCountForTests(): number {
  return new Set([...pendingReads.keys(), ...hostsLackingSetting]).size
}

export function _resetHostPRAutoRefreshCadenceGenerationsForTests(): void {
  pendingReads.clear()
  hostsLackingSetting.clear()
  lackListeners.clear()
}
