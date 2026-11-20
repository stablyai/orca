import { useEffect, useSyncExternalStore } from 'react'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callAntigravityChatAuthDetect } from './runtime-antigravity-accounts-client'

/**
 * Each host's detected Antigravity chat credentials, shared by every surface that shows them.
 * Read when a surface mounts and when the window regains focus; never on a timer.
 */

type Entry = {
  owner: RuntimeClientTarget
  detection: AntigravityChatAuthDetection | null
  fetchedAt: number
  inFlight: Promise<boolean> | null
  /** The one read queued behind `inFlight` for every forced caller. */
  forced: Promise<boolean> | null
  observers: number
}

// Surfaces that mount together (strip, chip, notices) share one read.
const FRESH_MS = 5_000

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let observedHosts = 0
let removeFocusListener: (() => void) | null = null

const hostKey = (owner: RuntimeClientTarget): string =>
  owner.kind === 'local' ? '' : owner.environmentId

function entryFor(owner: RuntimeClientTarget): Entry {
  let entry = entries.get(hostKey(owner))
  if (!entry) {
    entry = {
      owner,
      detection: null,
      fetchedAt: 0,
      inFlight: null,
      forced: null,
      observers: 0
    }
    entries.set(hostKey(owner), entry)
  }
  return entry
}

const sameDetection = (
  a: AntigravityChatAuthDetection | null,
  b: AntigravityChatAuthDetection | null
): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Re-reads the host's credentials; a fresh read is reused unless `force`. Resolves to whether
 *  the host answered: a failed read keeps the last answer. */
export function refreshAntigravityChatAuthDetection(
  owner: RuntimeClientTarget,
  options: { force?: boolean; now?: () => number } = {}
): Promise<boolean> {
  const entry = entryFor(owner)
  const now = options.now ?? Date.now
  if (entry.inFlight) {
    // A read already out may predate the change a forced read is meant to see.
    if (!options.force) {
      return entry.inFlight
    }
    const queued = entry
    queued.forced ??= entry.inFlight.then(() => {
      queued.forced = null
      return refreshAntigravityChatAuthDetection(owner, options)
    })
    return queued.forced
  }
  if (!options.force && entry.fetchedAt > 0 && now() - entry.fetchedAt < FRESH_MS) {
    return Promise.resolve(true)
  }
  const read = callAntigravityChatAuthDetect(entry.owner)
    .then((detection) => {
      entry.fetchedAt = now()
      if (!sameDetection(entry.detection, detection)) {
        entry.detection = detection
        listeners.forEach((listener) => listener())
      }
      return true
    })
    // The next mount, focus or sign-in change asks again.
    .catch(() => false)
    .finally(() => {
      entry.inFlight = null
    })
  entry.inFlight = read
  return read
}

function refreshObservedHosts(): void {
  for (const entry of entries.values()) {
    if (entry.observers > 0) {
      void refreshAntigravityChatAuthDetection(entry.owner)
    }
  }
}

function observe(owner: RuntimeClientTarget): () => void {
  const entry = entryFor(owner)
  entry.observers += 1
  observedHosts += 1
  if (!removeFocusListener) {
    window.addEventListener('focus', refreshObservedHosts)
    removeFocusListener = () => window.removeEventListener('focus', refreshObservedHosts)
  }
  void refreshAntigravityChatAuthDetection(owner)
  return () => {
    entry.observers -= 1
    observedHosts -= 1
    if (observedHosts === 0) {
      removeFocusListener?.()
      removeFocusListener = null
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readAntigravityChatAuthDetection(
  owner: RuntimeClientTarget | null
): AntigravityChatAuthDetection | null {
  return owner ? (entries.get(hostKey(owner))?.detection ?? null) : null
}

/** The host's detected credentials while `owner` is set; null before the first answer. */
export function useAntigravityChatAuthDetection(
  owner: RuntimeClientTarget | null
): AntigravityChatAuthDetection | null {
  const environmentId = owner?.kind === 'environment' ? owner.environmentId : null
  const shown = owner !== null
  useEffect(
    () =>
      shown
        ? observe(
            environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
          )
        : undefined,
    [shown, environmentId]
  )
  const read = (): AntigravityChatAuthDetection | null => readAntigravityChatAuthDetection(owner)
  return useSyncExternalStore(subscribe, read, read)
}
