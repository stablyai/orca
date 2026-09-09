import type {
  GitHubPRRefreshReason,
  GitHubPRRefreshSkippedReason,
  PRRefreshErrorType
} from '../../../../shared/github/pull-request-refresh-types'
import { capRecordByInsertionOrder } from './cache-policy'

export type PRRefreshState = {
  status: 'queued' | 'in-flight' | 'paused' | 'skipped' | 'error'
  reason: GitHubPRRefreshReason
  updatedAt: number
  pausedUntil?: number
  message?: string
  errorType?: PRRefreshErrorType
  skippedReason?: GitHubPRRefreshSkippedReason
  nextAutoRetryAt?: number
  retryDisabledUntil?: number
}

export type PRRefreshStateClearToken = {
  sequence: number
  status: PRRefreshState['status']
  updatedAt: number
}

const PR_REFRESH_ACTIVE_STALE_MS = 120_000
const PR_REFRESH_PAUSED_GRACE_MS = 5_000
const MAX_PR_REFRESH_STATE_ENTRIES = 2000
const SETTLED_PR_REFRESH_STATUSES = new Set<PRRefreshState['status']>(['error', 'skipped'])
export const ACTIVE_PR_REFRESH_STATUSES = new Set<PRRefreshState['status']>([
  'queued',
  'in-flight',
  'paused'
])

export function bypassesGitHubPRRefreshFreshness(reason: GitHubPRRefreshReason): boolean {
  return reason === 'manual' || reason === 'active' || reason === 'post-push'
}

export function buildGitHubPRRefreshStateClearToken(
  state: PRRefreshState | undefined,
  sequences: Record<string, number>,
  cacheKey: string
): PRRefreshStateClearToken | null {
  if (!state) {
    return null
  }
  return {
    sequence: sequences[cacheKey] ?? 0,
    status: state.status,
    updatedAt: state.updatedAt
  }
}

export function getGitHubPRRefreshStateExpiryAt(state: PRRefreshState | undefined): number | null {
  if (!state) {
    return null
  }
  if (state.status === 'queued' || state.status === 'in-flight') {
    return Number.isFinite(state.updatedAt) ? state.updatedAt + PR_REFRESH_ACTIVE_STALE_MS : 0
  }
  if (state.status === 'paused') {
    return Number.isFinite(state.pausedUntil)
      ? (state.pausedUntil ?? 0) + PR_REFRESH_PAUSED_GRACE_MS
      : 0
  }
  return null
}

export function isExpiredActivePRRefreshState(state: PRRefreshState, now: number): boolean {
  const expiryAt = getGitHubPRRefreshStateExpiryAt(state)
  return ACTIVE_PR_REFRESH_STATUSES.has(state.status) && expiryAt !== null && now > expiryAt
}

export function getEffectiveGitHubPRRefreshState(
  states: Record<string, PRRefreshState>,
  cacheKey: string,
  now = Date.now()
): PRRefreshState | undefined {
  const state = states[cacheKey]
  return !state || isExpiredActivePRRefreshState(state, now) ? undefined : state
}

export function pruneExpiredPRRefreshStates(
  states: Record<string, PRRefreshState>,
  now = Date.now()
): Record<string, PRRefreshState> {
  let next: Record<string, PRRefreshState> | null = null
  for (const [cacheKey, state] of Object.entries(states)) {
    if (!isExpiredActivePRRefreshState(state, now)) {
      continue
    }
    next ??= { ...states }
    delete next[cacheKey]
  }
  return next ?? states
}

export function capPrRefreshStates(
  states: Record<string, PRRefreshState>,
  maxEntries = MAX_PR_REFRESH_STATE_ENTRIES
): Record<string, PRRefreshState> {
  const keys = Object.keys(states)
  let toEvict = keys.length - maxEntries
  if (toEvict <= 0) {
    return states
  }
  const evicted = new Set<string>()
  for (const key of keys) {
    if (toEvict === 0) {
      break
    }
    if (SETTLED_PR_REFRESH_STATUSES.has(states[key].status)) {
      evicted.add(key)
      toEvict -= 1
    }
  }
  for (const key of keys) {
    if (toEvict === 0) {
      break
    }
    if (!evicted.has(key)) {
      evicted.add(key)
      toEvict -= 1
    }
  }
  const capped: Record<string, PRRefreshState> = {}
  for (const key of keys) {
    if (!evicted.has(key)) {
      capped[key] = states[key]
    }
  }
  return capped
}

export function capPrRefreshSequences(
  sequences: Record<string, number>,
  maxEntries?: number
): Record<string, number> {
  return capRecordByInsertionOrder(sequences, maxEntries)
}
