import type { HostedReviewState } from './source-control/hosted-review/hosted-review-contracts'
import type { CheckStatus } from './github/pull-requests/pull-request-types'

export const REVIEW_REFRESH_COOLDOWN_MS = 10_000
export const CLOSED_REVIEW_REFRESH_INTERVAL_MS = 15 * 60_000

/** How often PR/review state refreshes on a timer. Selecting a worktree, pushing, returning to the
 *  window and manual refresh still read at once in every mode. */
export const PR_AUTO_REFRESH_CADENCES = ['default', 'reduced', 'minimal', 'off'] as const
export type PRAutoRefreshCadence = (typeof PR_AUTO_REFRESH_CADENCES)[number]

/** The global-settings group this feature owns, composed into GlobalSettings. */
export type PRAutoRefreshSettings = {
  /** Timed PR/review/checks refresh cadence on this host; absent means 'default'. */
  prAutoRefresh?: PRAutoRefreshCadence
}

const CADENCE_INTERVAL_FACTOR: Record<Exclude<PRAutoRefreshCadence, 'off'>, number> = {
  default: 1,
  reduced: 5,
  minimal: 10
}

function isPRAutoRefreshCadence(value: unknown): value is PRAutoRefreshCadence {
  return PR_AUTO_REFRESH_CADENCES.some((cadence) => cadence === value)
}

export function normalizePRAutoRefreshCadence(value: unknown): PRAutoRefreshCadence {
  return isPRAutoRefreshCadence(value) ? value : 'default'
}

// Why one cadence per execution host: the setting belongs to the host that runs the GitHub reads
// and is presented that way ("applies to <host> and every client connected to it"). Each process
// keeps its own host's setting as the process cadence; a client that schedules work for a paired
// host keeps that host's setting beside it, keyed by environment id, and never lets its own
// setting slow or speed another host's timers. A host whose setting is unknown is read as Default,
// which is also what the host itself enforces for that client's timed reads.
let processCadence: PRAutoRefreshCadence = 'default'
const hostCadences = new Map<string, PRAutoRefreshCadence>()
const cadenceListeners = new Set<() => void>()
let cadenceRevision = 0

function notifyCadenceChanged(): void {
  cadenceRevision += 1
  // A snapshot: a listener may unsubscribe itself or another while we iterate.
  for (const listener of Array.from(cadenceListeners)) {
    listener()
  }
}

export function setPRAutoRefreshCadence(value: unknown): void {
  const next = normalizePRAutoRefreshCadence(value)
  if (next === processCadence) {
    return
  }
  processCadence = next
  notifyCadenceChanged()
}

export function getPRAutoRefreshCadence(): PRAutoRefreshCadence {
  return processCadence
}

/** Remember a paired host's own setting; null forgets it (the host is gone or unpaired). */
export function setPRAutoRefreshCadenceForHost(hostKey: string, value: unknown): void {
  const before = hostCadences.get(hostKey)
  if (value === null || value === undefined) {
    if (before === undefined) {
      return
    }
    hostCadences.delete(hostKey)
  } else {
    const next = normalizePRAutoRefreshCadence(value)
    if (next === before) {
      return
    }
    hostCadences.set(hostKey, next)
  }
  notifyCadenceChanged()
}

/** The cadence that governs work on `hostKey`: this process's own setting for local work (null),
 *  the remembered setting of a paired host, or Default while that host has not said. */
export function getPRAutoRefreshCadenceForHost(
  hostKey: string | null | undefined
): PRAutoRefreshCadence {
  if (hostKey === null || hostKey === undefined) {
    return processCadence
  }
  return hostCadences.get(hostKey) ?? 'default'
}

/** A paired host's remembered setting, or null while that host has not said. Schedulers use
 *  `getPRAutoRefreshCadenceForHost` (Default meanwhile); a control showing the host's setting
 *  must not present Default as an answer the host never gave. */
export function getKnownPRAutoRefreshCadenceForHost(hostKey: string): PRAutoRefreshCadence | null {
  return hostCadences.get(hostKey) ?? null
}

/** Fires after any cadence (this process's or a remembered host's) changes, so a mounted timer
 *  can replan instead of waiting for its next tick. */
export function subscribePRAutoRefreshCadence(listener: () => void): () => void {
  cadenceListeners.add(listener)
  return () => {
    cadenceListeners.delete(listener)
  }
}

/** Changes whenever any cadence changes; cheap to put in a memo or report identity. */
export function prAutoRefreshCadenceRevision(): number {
  return cadenceRevision
}

export function _resetPRAutoRefreshCadencesForTests(): void {
  processCadence = 'default'
  hostCadences.clear()
  cadenceListeners.clear()
  cadenceRevision = 0
}

/** Stretch a timed interval by the cadence; null means no timed refresh. */
export function scaleReviewRefreshInterval(
  intervalMs: number | null,
  cadence: PRAutoRefreshCadence = processCadence
): number | null {
  if (intervalMs === null || cadence === 'off') {
    return null
  }
  return intervalMs * CADENCE_INTERVAL_FACTOR[cadence]
}

function defaultReviewRefreshIntervalMs(input: {
  state?: HostedReviewState | null
  checksStatus?: CheckStatus | null
  hasReview?: boolean | null
  selected?: boolean
}): number | null {
  if (input.hasReview === false) {
    return input.selected ? 60_000 : 15 * 60_000
  }
  if (input.state === 'merged') {
    // Neutral means completed checks or no checks in the hosted-review contract.
    return input.checksStatus == null || input.checksStatus === 'pending' ? 60_000 : null
  }
  if (input.state === 'closed') {
    return CLOSED_REVIEW_REFRESH_INTERVAL_MS
  }
  return input.selected ? 60_000 : 120_000
}

export function reviewRefreshIntervalMs(
  input: {
    state?: HostedReviewState | null
    checksStatus?: CheckStatus | null
    hasReview?: boolean | null
    selected?: boolean
  },
  cadence: PRAutoRefreshCadence = processCadence
): number | null {
  return scaleReviewRefreshInterval(defaultReviewRefreshIntervalMs(input), cadence)
}

/** How old data must be before a foreground exposure (the window coming back, a row shown again)
 *  reads it again: the Default interval in every mode, since a cadence slows the timers, never the
 *  user's return, and never makes it faster than Default; the cooldown where Default itself runs
 *  no timer (settled data). */
export function reviewForegroundFreshnessMs(
  input: Parameters<typeof reviewRefreshIntervalMs>[0]
): number {
  return defaultReviewRefreshIntervalMs(input) ?? REVIEW_REFRESH_COOLDOWN_MS
}
