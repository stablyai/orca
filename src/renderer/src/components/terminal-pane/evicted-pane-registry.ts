// STA-1282: module-scoped registry of parked (evicted) terminal panes.
//
// When a hidden pane is evicted (Tier 1 -> Tier 2), its xterm/DOM/addons are
// gone but the PTY, its main-side mirror, and a lightweight title/status feed
// stay alive. The parked transport + coordinator live here (webviewRegistry
// precedent) so they are not garbage-collected while the pane is unmounted, and
// so tab/worktree close can reconcile them (gate #8). Only live-PTY panes ever
// enter, so the registry is bounded by construction.
//
// Entries are keyed by paneKey (stable per tab+leaf) because a split tab evicts
// every leaf; each leaf transport is one entry. Close-reconcile keys off the
// tab/worktree stored on each entry. This module owns no xterm/DOM/scrollback
// state (perf budget item d2). It also owns the per-session fail-open counter
// (gate #5) and self-disable state.

import { TERMINAL_PANE_EVICTION_MAX_REPLAY_FAILURES } from '../../../../shared/terminal-pane-eviction-settings'

export type EvictedPaneEntry = {
  paneKey: string
  tabId: string
  worktreeId: string
  /** Live PTY id of the parked transport. */
  getPtyId: () => string | null
  /** Kill the PTY and dispose the parked transport + coordinator (the pane's
   *  owning tab/worktree is gone). */
  destroy: () => void
  /** Dispose only the parked coordinator/feed and neutralize the transport
   *  WITHOUT killing the PTY (a fresh pane is remounting and taking over). */
  releaseForClaim: () => void
}

const evictedPanes = new Map<string, EvictedPaneEntry>()

let sessionReplayFailureCount = 0
let sessionSelfDisabled = false
const selfDisableListeners = new Set<() => void>()

export function registerEvictedPane(entry: EvictedPaneEntry): void {
  // Why: parking a pane that already has a parked entry (rapid evict cycles)
  // must dispose the stale one so a single leaf never leaks two parked PTYs.
  const existing = evictedPanes.get(entry.paneKey)
  if (existing && existing !== entry) {
    existing.destroy()
  }
  evictedPanes.set(entry.paneKey, entry)
}

export function getEvictedPane(paneKey: string): EvictedPaneEntry | undefined {
  return evictedPanes.get(paneKey)
}

export function isPaneParked(paneKey: string): boolean {
  return evictedPanes.has(paneKey)
}

export function isTabParked(tabId: string): boolean {
  for (const entry of evictedPanes.values()) {
    if (entry.tabId === tabId) {
      return true
    }
  }
  return false
}

/** Distinct tab ids that currently have at least one parked leaf. */
export function parkedTabIds(): Set<string> {
  const ids = new Set<string>()
  for (const entry of evictedPanes.values()) {
    ids.add(entry.tabId)
  }
  return ids
}

/** Iterate (tabId, worktreeId) owners of currently-parked leaves. Used by the
 *  coordinator's change signature so a parked tab/worktree closing moves the
 *  signature and triggers the close-reconcile (gate #8), even though parked
 *  tabs are not in the coordinator's managed set. Allocation-free on purpose —
 *  this runs per store tick while anything is parked; duplicate owners
 *  (multi-leaf split tabs) just repeat a signature part, which is harmless. */
export function forEachParkedOwner(cb: (tabId: string, worktreeId: string) => void): void {
  for (const entry of evictedPanes.values()) {
    cb(entry.tabId, entry.worktreeId)
  }
}

export function evictedPaneCount(): number {
  return evictedPanes.size
}

/**
 * A fresh pane is remounting `paneKey`: hand the live PTY back by dropping the
 * parked entry without killing it. Returns true if an entry was claimed (the
 * remount is an eviction replay and should charge the fail-open counter).
 */
export function claimEvictedPane(paneKey: string): boolean {
  const entry = evictedPanes.get(paneKey)
  if (!entry) {
    return false
  }
  evictedPanes.delete(paneKey)
  entry.releaseForClaim()
  return true
}

/** The parked PTY exited on its own (or was hibernation-killed) — drop the entry
 *  and dispose the parked feed. The PTY is already dead, so no kill. */
export function forgetEvictedPaneOnExit(paneKey: string): void {
  const entry = evictedPanes.get(paneKey)
  if (!entry) {
    return
  }
  evictedPanes.delete(paneKey)
  entry.releaseForClaim()
}

/**
 * Gate #8: close-reconcile. Any parked transport whose owning tab or worktree is
 * gone is killed (its PTY too) so no parked PTY outlives its tab/worktree.
 */
export function reconcileEvictedPanes(live: {
  tabIds: ReadonlySet<string>
  worktreeIds: ReadonlySet<string>
}): void {
  // Deleting the current entry during Map iteration is safe.
  for (const [paneKey, entry] of evictedPanes) {
    if (!live.tabIds.has(entry.tabId) || !live.worktreeIds.has(entry.worktreeId)) {
      evictedPanes.delete(paneKey)
      entry.destroy()
    }
  }
}

// --- fail-open counter + self-disable (gate #5) ------------------------------

/**
 * Record the outcome of an eviction remount replay. Only a structural failure
 * (RPC error/timeout, malformed snapshot) counts toward self-disable; a nil or
 * empty mirror is a legitimately blank pane and must not.
 */
export function recordEvictionRemountReplayOutcome(outcome: 'ok' | 'nil' | 'error'): void {
  if (outcome !== 'error') {
    return
  }
  sessionReplayFailureCount += 1
  if (
    !sessionSelfDisabled &&
    sessionReplayFailureCount >= TERMINAL_PANE_EVICTION_MAX_REPLAY_FAILURES
  ) {
    sessionSelfDisabled = true
    for (const listener of selfDisableListeners) {
      listener()
    }
  }
}

export function isEvictionSelfDisabled(): boolean {
  return sessionSelfDisabled
}

/** Fires when the session self-disables (the coordinator cancels pending
 *  teardowns and stops evicting). */
export function onEvictionSelfDisable(listener: () => void): () => void {
  selfDisableListeners.add(listener)
  return () => selfDisableListeners.delete(listener)
}

// Test-only reset so per-session counters do not leak across unit tests.
export function __resetEvictedPaneRegistryForTest(): void {
  for (const entry of evictedPanes.values()) {
    entry.destroy()
  }
  evictedPanes.clear()
  sessionReplayFailureCount = 0
  sessionSelfDisabled = false
  selfDisableListeners.clear()
}
