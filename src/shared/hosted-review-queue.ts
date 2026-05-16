import type {
  HostedReviewIdentity,
  HostedReviewQueueClassification,
  HostedReviewQueueState,
  HostedReviewQueueSummary,
  HostedReviewUser
} from './hosted-review'

export type HostedReviewClassificationOptions = {
  viewer?: HostedReviewUser | null
  agentAuthorLogins?: string[]
}

export function hostedReviewIdentityKey(identity: HostedReviewIdentity): string {
  return `${identity.provider}::${identity.host.toLowerCase()}::${identity.owner.toLowerCase()}::${identity.repo.toLowerCase()}::${identity.number}`
}

function hasRequestedReviewerSignal(
  summary: HostedReviewQueueSummary,
  viewer?: HostedReviewUser | null
): boolean {
  if (!viewer?.login) {
    return false
  }
  const requested = summary.requestedReviewerLogins
  if (!requested || requested.length === 0) {
    return false
  }
  const viewerLogin = viewer.login.toLowerCase()
  return requested.some((login) => login.toLowerCase() === viewerLogin)
}

function isAgentAuthored(
  summary: HostedReviewQueueSummary,
  options?: HostedReviewClassificationOptions
): boolean {
  if (summary.author?.isBot) {
    return true
  }
  const author = summary.author?.login?.toLowerCase()
  if (!author) {
    return false
  }
  if (options?.agentAuthorLogins?.some((login) => login.toLowerCase() === author)) {
    return true
  }
  return author.endsWith('[bot]') || author.includes('bot')
}

function getQueueState(
  summary: HostedReviewQueueSummary,
  options?: HostedReviewClassificationOptions
): HostedReviewQueueState {
  const viewerLogin = options?.viewer?.login?.toLowerCase() ?? null
  const authorLogin = summary.author?.login?.toLowerCase() ?? null
  if (viewerLogin && authorLogin && viewerLogin === authorLogin) {
    return 'mine'
  }
  if (hasRequestedReviewerSignal(summary, options?.viewer)) {
    return 'requested'
  }
  if (isAgentAuthored(summary, options)) {
    return 'agent'
  }
  return 'teammate'
}

export function reviewNeedsResponse(
  summary: HostedReviewQueueSummary,
  viewer?: HostedReviewUser | null
): boolean {
  void viewer
  if (summary.state !== 'open' && summary.state !== 'draft') {
    return false
  }
  if ((summary.threadSummary?.unresolvedCount ?? 0) > 0) {
    return true
  }
  if (summary.checksStatus === 'failure') {
    return true
  }
  if (summary.mergeable === 'CONFLICTING') {
    return true
  }
  if (summary.lastViewedAt === undefined) {
    return false
  }
  const updatedAt = Date.parse(summary.updatedAt)
  return Number.isFinite(updatedAt) && updatedAt > summary.lastViewedAt
}

export function reviewReadyToMerge(summary: HostedReviewQueueSummary): boolean {
  if (summary.state !== 'open') {
    return false
  }
  if (summary.draft) {
    return false
  }
  if (summary.mergeable !== 'MERGEABLE') {
    return false
  }
  if (summary.checksStatus !== 'success' && summary.checksStatus !== 'neutral') {
    return false
  }
  if (summary.threadSummary?.unresolvedCount !== 0) {
    return false
  }
  return true
}

export function classifyHostedReview(
  summary: HostedReviewQueueSummary,
  options?: HostedReviewClassificationOptions
): HostedReviewQueueClassification {
  const state = getQueueState(summary, options)
  return {
    state,
    requested: hasRequestedReviewerSignal(summary, options?.viewer),
    needsResponse: reviewNeedsResponse(summary, options?.viewer),
    readyToMerge: reviewReadyToMerge(summary)
  }
}
