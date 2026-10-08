import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import type { IssueInfo, PRInfo } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GetProjectViewTableResult } from '../../../../shared/github/project-result-types'
import type { AppState } from '../types'

export type InflightPR = {
  promise: Promise<PRInfo | null>
  force: boolean
  generation: number
  lookupHintKey: string
}
export type InflightChecks = {
  promise: Promise<PRCheckDetail[]>
  requestId: number
  force: boolean
  noCache: boolean
}
export type InflightWorkItems = {
  promise: Promise<readonly GitHubWorkItem[]>
  requestId: number
  force: boolean
  noCache: boolean
  requireComplete: boolean
}
export type InflightProjectView = {
  promise: Promise<GetProjectViewTableResult>
  requestId: number
  force: boolean
}

export const inflightPRRequests = new Map<string, InflightPR>()
export const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
export const inflightChecksRequests = new Map<string, InflightChecks>()
export const inflightCommentsRequests = new Map<string, Promise<PRComment[]>>()
export const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
export const inflightProjectViewRequests = new Map<string, InflightProjectView>()
export const prRequestGenerations = new Map<string, number>()
export const prRefreshStartedHostedReviewEntries = new Map<
  string,
  AppState['hostedReviewCache'][string] | undefined
>()

let providerRequestSequence = 0

/** Stamp identifying one provider request, captured before it awaits so it can recheck ownership after. */
export function nextProviderRequestId(): number {
  providerRequestSequence += 1
  return providerRequestSequence
}

/**
 * Why: the upgrade wait is bounded, so a stronger request can run beside a weaker one for the same
 * key. Only the request the key currently resolves to may write that key's cache — otherwise a late
 * weaker reply overwrites the stronger request's fresher result under a brand-new `fetchedAt`.
 */
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

export function clearInflightWorkItemsForRepo(repoId: string, repoPath?: string): void {
  const prefixes = [`${repoId}::`]
  if (repoPath && repoPath !== repoId) {
    prefixes.push(`${repoPath}::`)
  }
  for (const key of Array.from(inflightWorkItemsRequests.keys())) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      inflightWorkItemsRequests.delete(key)
    }
  }
}
