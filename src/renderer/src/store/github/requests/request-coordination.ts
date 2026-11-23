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
import type { PromiseSettlementWaiters } from '../../../../../shared/concurrency/promise-settlement-waiters'

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
export const inflightIssueRequests = new Map<
  string,
  { promise: Promise<IssueInfo | null>; requestId: number }
>()
export const inflightChecksRequests = new Map<string, InflightChecks>()
export const inflightCommentsRequests = new Map<string, InflightComments>()
export const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
export const inflightProjectViewRequests = new Map<string, InflightProjectView>()
export const prRequestGenerations = new Map<string, number>()
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
const pendingMutationCacheWrites = new Map<string, Set<{ current: boolean }>>()

export function trackGitHubMutationCacheWrite(key: string): {
  isCurrent: () => boolean
  dispose: () => void
} {
  const mutation = { current: true }
  const pending = pendingMutationCacheWrites.get(key) ?? new Set<{ current: boolean }>()
  pending.add(mutation)
  pendingMutationCacheWrites.set(key, pending)
  return {
    isCurrent: () => mutation.current,
    dispose: () => {
      pending.delete(mutation)
      if (pending.size === 0 && pendingMutationCacheWrites.get(key) === pending) {
        pendingMutationCacheWrites.delete(key)
      }
    }
  }
}

export async function runWithGitHubMutationCacheWrite<T>(
  key: string | null,
  run: (write: Pick<ReturnType<typeof trackGitHubMutationCacheWrite>, 'isCurrent'>) => Promise<T>
): Promise<T> {
  const write = key === null ? null : trackGitHubMutationCacheWrite(key)
  try {
    return await run({ isCurrent: () => write?.isCurrent() !== false })
  } finally {
    write?.dispose()
  }
}

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

export function clearInflightGitHubRequestsForRepo(eviction: RepoCacheEviction): void {
  for (const [key, pending] of pendingMutationCacheWrites) {
    if (matchesRepoCacheEviction(key, eviction)) {
      for (const mutation of pending) {
        mutation.current = false
      }
      pendingMutationCacheWrites.delete(key)
    }
  }
  for (const registry of [
    inflightPRRequests,
    prRequestGenerations,
    inflightIssueRequests,
    inflightChecksRequests,
    inflightCommentsRequests,
    inflightWorkItemsRequests,
    prRefreshStartedHostedReviewEntries,
    prRefreshStartedLinkedReviewScopes
  ]) {
    for (const key of registry.keys()) {
      if (matchesRepoCacheEviction(key, eviction)) {
        registry.delete(key)
      }
    }
  }
}
