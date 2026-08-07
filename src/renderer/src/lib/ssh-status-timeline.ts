import {
  createPtyDeliveryBreadcrumbRing,
  type PtyDeliveryBreadcrumbRing
} from '../../../shared/pty-delivery-diagnostics'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { boundPreservingEnds } from './ssh-diagnostic-text-scrub'

// A paired-runtime user routinely holds a local ring per configured target plus
// one per target on every environment, so 16 was under a single realistic
// session. 48 was too, in the other direction: the cap is GLOBAL, so a
// wake-from-sleep that flaps 60 targets at once shed the 12 oldest — and the
// oldest is the pane whose overlay surfaced first, i.e. the one the user clicks.
// Scope fairness (`evictForNewRing`) only answers a flood concentrated in one
// scope; breadth needed headroom. RAW_ERROR_CHARS pays for it so the product
// stays near the previous ceiling: 128 * 100 * 2048 ≈ 26MB worst case, and only
// if every entry of every ring carries a distinct maximal error.
export const MAX_TARGETS = 128
const RING_CAPACITY = 100
// Record-time cap only; capture redacts BEFORE truncating to 512 (§7). Bounded
// through `boundPreservingEnds`, so a key blob keeps the `-----END` the PEM rule
// anchors on even when the cut lands mid-block. Exported so a test can pin it
// under the scrub's own input bound — a second cut there would strand that
// terminator.
export const RAW_ERROR_CHARS = 2048

export type SshStatusTimelineOrigin =
  | 'push'
  | 'initial-hydration'
  | 'reconciliation'
  | 'runtime-push'
  | 'runtime-hydration'
  // A state the RENDERER fabricated (optimistic connect, rollback) rather than one
  // main emitted. Named so a report whose headline status came from one does not
  // read as a backend verdict — these carry no providerEpoch or generation.
  | 'renderer-optimistic'

export type SshStatusTimelineEntry = {
  atMs: number
  status: string
  attempt: number | null
  repeats: number
  /** Wall time from the run's first arrival to its last, when folded (§8.3). */
  runMs: number | null
  error: string | null
  generation: number | null
  origin: string
}

const rings = new Map<string, PtyDeliveryBreadcrumbRing>()
// Why: the ring has no cheap "read last entry" — snapshot() copies every
// entry (pty-delivery-diagnostics.ts:51-53), so it cannot run per arrival.
const lastRecorded = new Map<string, { key: string; atMs: number }>()

// Rings are per (environment, target). Target ids are only unique within their
// owning host, and a runtime hydration sweep re-inserts every target it reads —
// so an unscoped LRU lets that sweep evict the ring being captured.
// `:` is escaped so an environment id cannot forge the `::` scope boundary
// `scopeOfKey` splits on, and `%` before it so the escape itself is reversible —
// otherwise `a:b` and `a%3Ab` share a scope. The local namespace is a separate
// literal so an environment id of `local` cannot merge into it.
function scopeOf(environmentId?: string | null): string {
  if (environmentId == null) {
    return 'local::'
  }
  return `environment=${environmentId.replaceAll('%', '%25').replaceAll(':', '%3A')}::`
}

function scopeOfKey(key: string): string {
  return key.slice(0, key.indexOf('::') + 2)
}

function timelineKey(targetId: string, environmentId?: string | null): string {
  return `${scopeOf(environmentId)}${targetId}`
}

// V8 returns a SlicedString for any slice of 13+ chars, which holds the entire
// parent alive; `+ ''` and `.repeat(1)` do not flatten it. Without this copy
// RAW_ERROR_CHARS bounds the reported length and nothing else — the ring would
// pin the unbounded pre-clamp stderr the state arrived with.
function flattenString(text: string): string {
  return text.split('').join('')
}

// Only a bound that actually cut can pin a parent, and only then is the flatten
// (~19µs at the cap, ~95x the rest of this function) worth paying — an error
// already inside the cap is stored as-is, which is the overwhelmingly common case.
function boundedError(error: string): string {
  if (error.length <= RAW_ERROR_CHARS) {
    return error
  }
  return flattenString(boundPreservingEnds(error, RAW_ERROR_CHARS))
}

// Why read defensively past the type: these states cross IPC, and §8.1 requires
// the record path be non-throwing by construction, not just by its try/catch.
function attemptOf(state: SshConnectionState): number | null {
  return typeof state.reconnectAttempt === 'number' ? state.reconnectAttempt : null
}

function generationOf(state: SshConnectionState): number | null {
  return typeof state.connectionGeneration === 'number' ? state.connectionGeneration : null
}

// The ring folds on `kind` equality against its newest entry
// (pty-delivery-diagnostics.ts:38), so the fold key IS the kind. `attempt` and
// `generation` are in it deliberately: folding on status alone collapses the
// 9-step ladder (§8.3), and folding across generations reports an authority
// correction as a repeat of the state it corrects.
function foldKey(state: SshConnectionState): string {
  return `${state.status}#${attemptOf(state) ?? ''}#${generationOf(state) ?? ''}`
}

function evict(key: string): void {
  rings.delete(key)
  lastRecorded.delete(key)
}

/**
 * Sheds the oldest ring of whichever scope holds the most, so a sweeping
 * environment pays for its own growth and every scope keeps a fair share.
 *
 * Returning on the first in-scope key instead starved the scope that was
 * actively failing: with the map already full of stale `local::` rings, each
 * new environment ring evicted the environment's own previous one — pinning
 * that scope at exactly 1 while the local rings never shed at all.
 */
function evictForNewRing(newKey: string): void {
  const oldestOfScope = new Map<string, string>()
  const scopeSizes = new Map<string, number>()
  for (const key of rings.keys()) {
    if (key === newKey) {
      continue
    }
    const scope = scopeOfKey(key)
    if (!oldestOfScope.has(scope)) {
      oldestOfScope.set(scope, key)
    }
    scopeSizes.set(scope, (scopeSizes.get(scope) ?? 0) + 1)
  }
  let victim: string | undefined
  let victimScopeSize = 0
  // Insertion order here is oldest-scope-first, so a strict `>` breaks ties
  // toward the globally oldest ring.
  for (const [scope, oldest] of oldestOfScope) {
    const size = scopeSizes.get(scope) ?? 0
    if (size > victimScopeSize) {
      victim = oldest
      victimScopeSize = size
    }
  }
  if (victim !== undefined) {
    evict(victim)
  }
}

// Re-insert so Map iteration order stays least-recently-used first.
function touch(key: string, ring: PtyDeliveryBreadcrumbRing): void {
  rings.delete(key)
  rings.set(key, ring)
}

function ringFor(key: string): PtyDeliveryBreadcrumbRing {
  const existing = rings.get(key)
  if (existing) {
    touch(key, existing)
    return existing
  }
  // Infinite coalesce window, narrow key: an unchanged (status, attempt,
  // generation) folds at any spacing, a new attempt never does (§8.3).
  const ring = createPtyDeliveryBreadcrumbRing(RING_CAPACITY, Number.POSITIVE_INFINITY)
  rings.set(key, ring)
  if (rings.size > MAX_TARGETS) {
    evictForNewRing(key)
  }
  return ring
}

/** Record one arrival. Never throws: reconnect cannot depend on diagnostics. */
export function recordSshStateArrival(
  targetId: string,
  state: SshConnectionState,
  origin: SshStatusTimelineOrigin,
  environmentId?: string | null
): void {
  try {
    const timelineId = timelineKey(targetId, environmentId)
    const now = Date.now()
    const key = foldKey(state)
    const last = lastRecorded.get(timelineId)
    if (last?.key === key) {
      // A hydration that re-reads the state the timeline already ends with is a
      // poll, not an arrival — the forced hydration a push triggers re-reads that
      // same push, and folding it in reports one arrival as a flap. Checked before
      // `detail` is built so a discarded re-read pays nothing for it.
      if (origin === 'initial-hydration' || origin === 'runtime-hydration') {
        return
      }
    }
    const detail = {
      attempt: attemptOf(state),
      // Capped, not classified — capture scrubs then truncates (§7).
      error: typeof state.error === 'string' ? boundedError(state.error) : null,
      generation: generationOf(state),
      origin
    }
    if (last?.key === key) {
      // Fold a repeat of the same (status, attempt, generation) at any spacing,
      // preserving the run's START time — the ring stamps its own coalescing
      // with the LAST. Clamped: a backwards system clock would store a negative run.
      ringFor(timelineId).record(key, { ...detail, runMs: Math.max(0, now - last.atMs) })
      return
    }
    lastRecorded.set(timelineId, { key, atMs: now })
    ringFor(timelineId).record(key, detail)
  } catch {
    // Intentionally empty.
  }
}

export function snapshotSshStatusTimeline(
  targetId: string,
  environmentId?: string | null
): SshStatusTimelineEntry[] {
  try {
    const key = timelineKey(targetId, environmentId)
    const ring = rings.get(key)
    if (ring) {
      // Capturing counts as use: without it the ring the user is copying right
      // now is still the next eviction victim.
      touch(key, ring)
    }
    return (ring?.snapshot() ?? []).map((entry) => {
      const detail = entry.detail ?? {}
      // First `#`, not last: no SshConnectionStatus contains one, and the kind
      // appends two of them.
      const hash = entry.kind.indexOf('#')
      return {
        atMs: entry.atMs,
        status: hash === -1 ? entry.kind : entry.kind.slice(0, hash),
        attempt: typeof detail.attempt === 'number' ? detail.attempt : null,
        repeats: entry.repeats ?? 1,
        runMs: typeof detail.runMs === 'number' ? detail.runMs : null,
        error: typeof detail.error === 'string' ? detail.error : null,
        generation: typeof detail.generation === 'number' ? detail.generation : null,
        origin: typeof detail.origin === 'string' ? detail.origin : 'push'
      }
    })
  } catch {
    return []
  }
}

/**
 * Test-only reset seam (§4.1). Deliberately NOT wired to target removal: the
 * `targetRemoved` overlay is a state users capture from, and clearing there
 * would hand them an empty timeline. Retention is bounded by the LRU and by the
 * flat copy in `recordSshStateArrival`.
 */
export function forgetSshStatusTimeline(targetId: string, environmentId?: string | null): void {
  evict(timelineKey(targetId, environmentId))
}
