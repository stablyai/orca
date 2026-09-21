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
  force: boolean
  noCache: boolean
}
export type InflightWorkItems = {
  promise: Promise<readonly GitHubWorkItem[]>
  force: boolean
  noCache: boolean
  requireComplete: boolean
}

export const inflightPRRequests = new Map<string, InflightPR>()
export const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
export const inflightChecksRequests = new Map<string, InflightChecks>()
export const inflightCommentsRequests = new Map<string, Promise<PRComment[]>>()
export const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
export const inflightProjectViewRequests = new Map<
  string,
  { promise: Promise<GetProjectViewTableResult>; force: boolean }
>()
export const prRequestGenerations = new Map<string, number>()
export const prRefreshStartedHostedReviewEntries = new Map<
  string,
  AppState['hostedReviewCache'][string] | undefined
>()

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
