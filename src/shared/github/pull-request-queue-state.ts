import type { HostedReviewInfo, HostedReviewWireInfo } from '../hosted-review'
import type { PRInfo, PRState, PRWireState, PullRequestMergeQueueEntry } from './pull-request-types'

type QueueStateCarrier = {
  state: PRState
  mergeQueueEntry?: PullRequestMergeQueueEntry
}

/**
 * Whether a review is sitting in a provider merge queue. The presence of
 * `mergeQueueEntry` is the discriminator — hosts publish `open` alongside it and
 * clients derive `queued` here, so an older client simply reads it as open,
 * which it genuinely is.
 */
export function isQueuedPullRequest(carrier: QueueStateCarrier): boolean {
  return (carrier.state === 'open' || carrier.state === 'queued') && carrier.mergeQueueEntry != null
}

/** Narrows a possibly-derived state back to what a host is allowed to publish. */
export function toPullRequestWireState(state: PRState): PRWireState {
  return state === 'queued' ? 'open' : state
}

export function withDerivedPullRequestQueueState<T extends QueueStateCarrier>(value: T): T
export function withDerivedPullRequestQueueState<T extends QueueStateCarrier>(
  value: T | null | undefined
): T | null | undefined
export function withDerivedPullRequestQueueState<T extends QueueStateCarrier>(
  value: T | null | undefined
): T | null | undefined {
  if (!value || !isQueuedPullRequest(value) || value.state === 'queued') {
    return value
  }
  return { ...value, state: 'queued' }
}

/** Convenience wrapper preserving `PRInfo | null` for cache/store call sites. */
export function withDerivedPRInfoQueueState(pr: PRInfo | null): PRInfo | null {
  return withDerivedPullRequestQueueState(pr) ?? null
}

export function withDerivedHostedReviewQueueState(
  review: HostedReviewInfo | HostedReviewWireInfo | null
): HostedReviewInfo | null {
  if (!review) {
    return null
  }
  // Why: only GitHub publishes queue entries today; the derivation is
  // provider-neutral so a GitLab merge train can light it up with no change here.
  return withDerivedPullRequestQueueState(review as HostedReviewInfo) ?? null
}
