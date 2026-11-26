import type { CheckStatus, ProviderCheckSummary } from '../pull-requests/pull-request-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../repositories/repository-identity'
import { githubRepoIdentityKey } from '../repositories/repository-identity-key'
import {
  matchesGitHubWorkItemTarget,
  parseGitHubItemRepository
} from '../work-items/work-item-target'

type CheckOwner = {
  number?: number
  url?: string
  headSha?: string
  prRepo?: GitHubOwnerRepo
  githubRepository?: GitHubOwnerRepo
  checksSummary?: ProviderCheckSummary
  checksStatus?: CheckStatus
  status?: CheckStatus
}
type Receipt = {
  observation: object
  scope: string
  target: string
  head: string | undefined
  summary: ProviderCheckSummary | undefined
  status: CheckStatus | undefined
}
export type PRCheckObservationContext = {
  scope: string
  complete: boolean
  current: boolean
  trusted?: boolean
}
const receipts = new WeakMap<object, Receipt>()

function targetKey(owner: CheckOwner): string | undefined {
  if (!owner.url || !owner.number) {
    return undefined
  }
  const repository = owner.prRepo ?? owner.githubRepository ?? parseGitHubItemRepository(owner.url)
  if (
    !repository ||
    !matchesGitHubWorkItemTarget(
      { url: owner.url, number: owner.number, type: 'pr', prRepo: repository },
      { repository, number: owner.number, type: 'pr' }
    )
  ) {
    return undefined
  }
  return `${githubRepoIdentityKey(repository)}:${owner.number}`
}
function status(owner: CheckOwner): CheckStatus | undefined {
  return owner.checksStatus ?? owner.status
}
function receipt(owner: CheckOwner): Receipt | undefined {
  const proof = receipts.get(owner)
  return proof &&
    proof.target === targetKey(owner) &&
    proof.head === owner.headSha &&
    proof.summary === owner.checksSummary &&
    proof.status === status(owner)
    ? proof
    : undefined
}

// Receipts stay on accepted objects; neither deserialization nor borrowing a summary transfers authority.
export function markCompletePRCheckOwner<T extends CheckOwner>(owner: T, scope: string): T {
  const target = targetKey(owner)
  if (target) {
    receipts.set(owner, {
      observation: owner,
      scope,
      target,
      head: owner.headSha,
      summary: owner.checksSummary,
      status: status(owner)
    })
  }
  return owner
}
export function completePRCheckOwnerScope(owner: CheckOwner): string | undefined {
  return receipt(owner)?.scope
}
export function isCompletePRCheckOwner(owner: CheckOwner): boolean {
  return receipt(owner) !== undefined
}

export function samePRCheckObservation(a: CheckOwner, b: CheckOwner): boolean {
  const first = receipt(a)
  return Boolean(first && first.observation === receipt(b)?.observation)
}
export function projectPRCheckOwner<T extends CheckOwner>(owner: CheckOwner, projected: T): T {
  const proof = receipt(owner)
  if (
    proof &&
    proof.target === targetKey(projected) &&
    proof.head === projected.headSha &&
    proof.summary === projected.checksSummary
  ) {
    receipts.set(projected, { ...proof, status: status(projected) })
  }
  return projected
}

/** The existing request/selection owner decides current; this rule owns checks identity and last-good. */
export function acceptPRCheckObservation<T extends CheckOwner>(
  next: T,
  previous: CheckOwner | null | undefined,
  context: PRCheckObservationContext
): (T & { checksSummary?: ProviderCheckSummary }) | null {
  if (!context.current) {
    return null
  }
  if (!context.complete) {
    return next
  }
  const prior = previous && receipt(previous)
  const supplied = context.trusted !== false && Boolean(next.headSha) && Boolean(next.checksSummary)
  const keep =
    !supplied &&
    prior &&
    prior.scope === context.scope &&
    next.headSha &&
    next.headSha === prior.head &&
    targetKey(next) === prior.target
  const checksSummary = supplied ? next.checksSummary : keep ? previous?.checksSummary : undefined
  const checksStatus =
    checksSummary && checksSummary.state !== 'none' ? checksSummary.state : 'neutral'
  const accepted = {
    ...next,
    checksSummary,
    ...('checksStatus' in next ? { checksStatus } : {}),
    ...('status' in next ? { status: checksStatus } : {})
  }
  return supplied && receipt(next)?.scope === context.scope
    ? projectPRCheckOwner(next, accepted)
    : markCompletePRCheckOwner(accepted, context.scope)
}
