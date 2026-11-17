// Agent secret requests seen on each runtime environment's client-event stream, plus what
// this window did with them. Names, reasons and ids only: the value a person types stays in the card.
import { useSyncExternalStore } from 'react'
import type {
  SecretRequestedEvent,
  SecretRequestSettledEvent,
  SecretRequestStatus
} from '../../../../shared/secret-request-contract'

/** What this window is showing for a request once the person acted on it. */
export type SecretRequestLocalPhase =
  | 'saving'
  /** Saved and the agent was told. */
  | 'saved'
  /** Saved, but the request had expired, so the agent stopped waiting. */
  | 'savedAfterExpiry'
  | 'expired'

export type SecretRequestEntry = {
  environmentId: string
  event: SecretRequestedEvent
  /** Set by orcad's settle event, or by this window's own resolve. */
  settled: Exclude<SecretRequestStatus, 'pending'> | null
  local: SecretRequestLocalPhase | null
  /** This window's clock when the event first arrived (ties in requestedAt keep arrival order). */
  receivedAt: number
  /** When this window last sent touchRequest (at most once a minute, across card remounts). */
  touchedAt: number
}

type State = { entries: ReadonlyMap<string, SecretRequestEntry> }

let state: State = { entries: new Map() }
const listeners = new Set<() => void>()

function commit(next: Map<string, SecretRequestEntry>): void {
  state = { entries: next }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function keyOf(environmentId: string, requestId: string): string {
  return `${environmentId}\u0000${requestId}`
}

/** A card keeps showing once the person acted (saving, done, expired) until they dismiss it. */
function stillShown(entry: SecretRequestEntry): boolean {
  return entry.local !== null || entry.settled === null
}

export function applySecretRequested(
  environmentId: string,
  event: SecretRequestedEvent,
  now = Date.now()
): void {
  const key = keyOf(environmentId, event.requestId)
  const existing = state.entries.get(key)
  const next = new Map(state.entries)
  // A replay on attach repeats the event; keep what this window already did with it.
  next.set(key, {
    environmentId,
    event,
    settled: existing?.settled ?? null,
    local: existing?.local ?? null,
    receivedAt: existing?.receivedAt ?? now,
    touchedAt: existing?.touchedAt ?? 0
  })
  const seen = seenSinceReady.get(environmentId) ?? new Set<string>()
  seen.add(event.requestId)
  seenSinceReady.set(environmentId, seen)
  commit(next)
}

/** Any client's touchRequest moved the expiry (secrets.requestUpdated). */
export function applySecretRequestUpdated(
  environmentId: string,
  event: { requestId: string; expiresAt: number }
): void {
  setSecretRequestExpiry(environmentId, event.requestId, event.expiresAt)
}

// Requests seen on each host's stream since its last 'ready'. orcad replays every pending request
// right before 'ready', so at 'ready' anything unresolved and unseen was settled while we were away.
const seenSinceReady = new Map<string, Set<string>>()

/** The stream sent 'ready': drop requests orcad no longer has (unless this window is showing a result). */
export function pruneSecretRequestsOnReady(environmentId: string): void {
  const seen = seenSinceReady.get(environmentId) ?? new Set<string>()
  seenSinceReady.set(environmentId, new Set())
  const pruned = new Map(
    [...state.entries].filter(
      ([, entry]) =>
        entry.environmentId !== environmentId ||
        entry.local !== null ||
        seen.has(entry.event.requestId)
    )
  )
  if (pruned.size !== state.entries.size) {
    commit(pruned)
  }
}

export function setSecretRequestTouched(
  environmentId: string,
  requestId: string,
  touchedAt: number
): void {
  const key = keyOf(environmentId, requestId)
  const existing = state.entries.get(key)
  if (!existing) {
    return
  }
  const next = new Map(state.entries)
  next.set(key, { ...existing, touchedAt })
  commit(next)
}

export function applySecretRequestSettled(
  environmentId: string,
  event: SecretRequestSettledEvent
): void {
  const key = keyOf(environmentId, event.requestId)
  const existing = state.entries.get(key)
  if (!existing) {
    return
  }
  const next = new Map(state.entries)
  const updated: SecretRequestEntry = {
    ...existing,
    settled: event.status,
    // Expiry reported by orcad shows the expired state unless this window already finished it.
    local: event.status === 'expired' && existing.local === null ? 'expired' : existing.local
  }
  if (stillShown(updated)) {
    next.set(key, updated)
  } else {
    next.delete(key)
  }
  commit(next)
}

export function setSecretRequestLocal(
  environmentId: string,
  requestId: string,
  local: SecretRequestLocalPhase | null
): void {
  const key = keyOf(environmentId, requestId)
  const existing = state.entries.get(key)
  if (!existing || existing.local === local) {
    return
  }
  const next = new Map(state.entries)
  const updated = { ...existing, local }
  if (stillShown(updated)) {
    next.set(key, updated)
  } else {
    next.delete(key)
  }
  commit(next)
}

/** touchRequest moved the expiry; the card's clock follows it. */
export function setSecretRequestExpiry(
  environmentId: string,
  requestId: string,
  expiresAt: number
): void {
  const key = keyOf(environmentId, requestId)
  const existing = state.entries.get(key)
  if (!existing || existing.event.expiresAt === expiresAt) {
    return
  }
  const next = new Map(state.entries)
  next.set(key, { ...existing, event: { ...existing.event, expiresAt } })
  commit(next)
}

export function dismissSecretRequest(environmentId: string, requestId: string): void {
  const key = keyOf(environmentId, requestId)
  if (!state.entries.has(key)) {
    return
  }
  const next = new Map(state.entries)
  next.delete(key)
  commit(next)
}

const EMPTY: readonly SecretRequestEntry[] = []
let cachedFor: State | null = null
let cachedList: readonly SecretRequestEntry[] = EMPTY

function listAll(): readonly SecretRequestEntry[] {
  if (cachedFor !== state) {
    cachedFor = state
    cachedList =
      state.entries.size === 0
        ? EMPTY
        : [...state.entries.values()].sort(
            (a, b) => a.event.requestedAt - b.event.requestedAt || a.receivedAt - b.receivedAt
          )
  }
  return cachedList
}

/** Every request this window shows a card for, oldest first. */
export function useSecretRequests(): readonly SecretRequestEntry[] {
  return useSyncExternalStore(subscribe, listAll, listAll)
}

export function readSecretRequests(): readonly SecretRequestEntry[] {
  return listAll()
}

export function resetSecretRequestStoreForTests(): void {
  seenSinceReady.clear()
  state = { entries: new Map() }
  cachedFor = null
  cachedList = EMPTY
}

/** When this window last touched the request, read at the time a hold starts. */
export function readSecretRequestTouchedAt(environmentId: string, requestId: string): number {
  return state.entries.get(keyOf(environmentId, requestId))?.touchedAt ?? 0
}
