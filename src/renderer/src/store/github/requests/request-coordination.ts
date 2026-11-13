import type { PRCheckContract } from '@/lib/source-control/checks/pr-check-observation-contract'
import type { PRCheckDetail } from '../../../../../shared/github/checks/check-types'
import type { PRComment } from '../../../../../shared/github/comments/comment-types'
import type {
  GitHubPRRefreshReason,
  PRSnapshotReply
} from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type {
  IssueInfo,
  PRInfo
} from '../../../../../shared/github/pull-requests/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { GetProjectViewTableResult } from '../../../../../shared/github/projects/project-result-types'
import type { LinkedReviewClearScope } from '../pull-requests/linked-review-clear'
import type { AppState } from '../../types'
import { matchesRepoCacheEviction, type RepoCacheEviction } from '../cache/cache-identity'
import type { PromiseSettlementWaiters } from '../../../../../shared/promise-settlement-waiters'

export type InflightPR = {
  promise: Promise<PRInfo | null>
  controller: AbortController
  waiters: PromiseSettlementWaiters<PRInfo | null>
  force: boolean
  generation: number
  lookupHintKey: string
  reason?: GitHubPRRefreshReason
  superseded?: boolean
  outcome?: PRSnapshotReply
}
export type InflightChecks = {
  promise: Promise<PRCheckDetail[]>
  /** The provider reply alone, so a failed successor can land it without waiting on this request. */
  reply?: Promise<PRCheckDetail[]>
  requestId: number
  force: boolean
  noCache: boolean
  /** A user act's request may start a stopped WSL distro; a poll's would be refused. */
  wakeWslDistro?: boolean
}
export type InflightComments = {
  promise: Promise<PRComment[]>
  reply?: Promise<PRComment[]>
  requestId: number
  postedComments: PRComment[]
}
export type InflightWorkItems = {
  promise: Promise<readonly GitHubWorkItem[] | undefined>
  requestId: number
  force: boolean
  noCache: boolean
  requireComplete: boolean
  wakeWslDistro?: boolean
}
export type InflightProjectView = {
  promise: Promise<GetProjectViewTableResult>
  requestId: number
  force: boolean
}

export const inflightPRRequests = new Map<string, InflightPR>()
export const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
export const inflightChecksRequests = new Map<string, InflightChecks>()
export const inflightCommentsRequests = new Map<string, InflightComments>()
export const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
export const inflightProjectViewRequests = new Map<string, InflightProjectView>()
export const prRequestGenerations = new Map<string, number>()
// Each new direct PR lookup takes a never-reused token; a pending detail-recovery grant yields to it.
const prLookupIntentTokens = new Map<string, number>()
let prLookupIntentSequence = 0
// Eviction raises this floor, so a forgotten key still reads newer than any token captured before it.
let prLookupIntentEvictedFloor = 0
const prLookupIntentListeners = new Set<(cacheKey: string) => void>()
const prLookupIntentPins = new Map<string, number>()

/** Hold the alias's current value in place while an owner compares it; release when done. */
export function pinPRLookupIntent(cacheKey: string): () => void {
  if (!prLookupIntentTokens.has(cacheKey)) {
    prLookupIntentTokens.set(cacheKey, prLookupIntentEvictedFloor)
  }
  prLookupIntentPins.set(cacheKey, (prLookupIntentPins.get(cacheKey) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (prLookupIntentPins.get(cacheKey) ?? 1) - 1
    if (remaining > 0) {
      prLookupIntentPins.set(cacheKey, remaining)
    } else {
      prLookupIntentPins.delete(cacheKey)
    }
  }
}

export function notePRLookupIntent(cacheKey: string): void {
  prLookupIntentSequence += 1
  prLookupIntentTokens.delete(cacheKey)
  prLookupIntentTokens.set(cacheKey, prLookupIntentSequence)
  for (const [oldestKey, oldestToken] of prLookupIntentTokens) {
    if (prLookupIntentTokens.size <= 1_000) {
      break
    }
    // A pinned alias has a live owner comparing its value; unrelated churn must not move it.
    if (prLookupIntentPins.has(oldestKey)) {
      continue
    }
    prLookupIntentTokens.delete(oldestKey)
    prLookupIntentEvictedFloor = Math.max(prLookupIntentEvictedFloor, oldestToken)
  }
  for (const listener of prLookupIntentListeners) {
    listener(cacheKey)
  }
}

/** Strictly increases whenever new direct intent for the alias exists, including across eviction. */
export function prLookupIntentRevision(cacheKey: string): number {
  return prLookupIntentTokens.get(cacheKey) ?? prLookupIntentEvictedFloor
}

export function onPRLookupIntent(listener: (cacheKey: string) => void): () => void {
  prLookupIntentListeners.add(listener)
  return () => prLookupIntentListeners.delete(listener)
}
export const prRefreshStartedHostedReviewEntries = new Map<
  string,
  {
    entry: AppState['hostedReviewCache'][string] | undefined
    checkContract?: PRCheckContract
    expiresAt: number
  }
>()
export const prRefreshStartedLinkedReviewScopes = new Map<
  string,
  { sequence: number; scope: LinkedReviewClearScope; expiresAt: number }
>()

let providerRequestSequence = 0

/** Stamp identifying one provider request, captured before it awaits so it can recheck ownership after. */
export function nextProviderRequestId(): number {
  providerRequestSequence += 1
  return providerRequestSequence
}

/** Bounded upgrade waits permit concurrent strengths; only current key owner may cache replies or late weaker results gain fresh timestamps over newer data. */
export function ownsInflightRequest<T extends { requestId: number }>(
  registry: ReadonlyMap<string, T>,
  key: string,
  requestId: number
): boolean {
  return registry.get(key)?.requestId === requestId
}

export function _getGitHubPRRequestGenerationCountForTest(): number {
  return prRequestGenerations.size
}

export function _getGitHubPRRefreshStartedEntryCountForTest(): number {
  return prRefreshStartedHostedReviewEntries.size
}

export function _clearGitHubPRRefreshStartedEntriesForTest(): void {
  prRefreshStartedHostedReviewEntries.clear()
  prRefreshStartedLinkedReviewScopes.clear()
}

const PROVIDER_REQUEST_CONCURRENCY = 8
let providerRequestsInFlight = 0
const providerRequestWaiters: (() => void)[] = []

export async function acquireProviderRequestSlot(): Promise<void> {
  if (providerRequestsInFlight < PROVIDER_REQUEST_CONCURRENCY) {
    providerRequestsInFlight += 1
    return
  }
  await new Promise<void>((resolve) => providerRequestWaiters.push(resolve))
}

export function releaseProviderRequestSlot(): void {
  const next = providerRequestWaiters.shift()
  if (next) {
    next()
    return
  }
  providerRequestsInFlight -= 1
}

export function clearInflightWorkItemsForRepo(eviction: RepoCacheEviction): void {
  for (const key of Array.from(inflightWorkItemsRequests.keys())) {
    if (matchesRepoCacheEviction(key, eviction)) {
      inflightWorkItemsRequests.delete(key)
    }
  }
}
