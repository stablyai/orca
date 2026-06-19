import type { CheckStatus, PRCheckDetail, PRInfo, Repo, Worktree } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { AppState } from '@/store'
import { translate } from '@/i18n/i18n'

export type ParentPrChecksCacheEntry<T> = {
  data: T | null
  fetchedAt: number
  headSha?: string
}

export type ParentPrChecksRefreshOutcome =
  | { kind: 'loading' }
  | { kind: 'found'; review: HostedReviewInfo }
  | { kind: 'no-review' }
  | { kind: 'unavailable' }
  | { kind: 'error'; error?: unknown }

export type ParentPrChecksRowStatus =
  | 'notFetched'
  | 'loading'
  | 'noReview'
  | 'linkedDetailsUnavailable'
  | 'refreshError'
  | 'unsupported'
  | 'unavailable'
  | 'failing'
  | 'pending'
  | 'success'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'conflict'
  | 'neutral'

export type ParentPrChecksGroupKey =
  | 'needsAttention'
  | 'pending'
  | 'merged'
  | 'passing'
  | 'draftOrNoChecks'
  | 'noPr'
  | 'unavailable'

export type ParentPrChecksRow = {
  id: string
  refreshIdentity: string
  worktree: Worktree
  repo: Repo | null
  branch: string | null
  status: ParentPrChecksRowStatus
  group: ParentPrChecksGroupKey
  checkTone: CheckStatus
  title: string
  reviewLabel: string | null
  reviewUrl: string | null
  reviewState: HostedReviewInfo['state'] | null
  provider: HostedReviewInfo['provider'] | null
  summary: string
  detailNames: string[]
  checks: PRCheckDetail[]
  isRefreshing: boolean
  hasLinkedReview: boolean
}

export type ParentPrChecksSummary = {
  attached: number
  knownReview: number
  failing: number
  pending: number
  passing: number
  noPr: number
  unknown: number
}

export type ParentPrChecksProjection = {
  rows: ParentPrChecksRow[]
  groups: {
    key: ParentPrChecksGroupKey
    label: string
    rows: ParentPrChecksRow[]
  }[]
  summary: ParentPrChecksSummary
}

export type BuildParentPrChecksRowsArgs = {
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  settings: AppState['settings']
  hostedReviewCache: Record<string, ParentPrChecksCacheEntry<HostedReviewInfo>>
  prCache: Record<string, ParentPrChecksCacheEntry<PRInfo>>
  checksCache: Record<string, ParentPrChecksCacheEntry<PRCheckDetail[]>>
  refreshOutcomes?: ReadonlyMap<string, ParentPrChecksRefreshOutcome>
}

export const PARENT_PR_CHECKS_GROUP_LABELS: Record<ParentPrChecksGroupKey, string> = {
  get needsAttention() {
    return translate(
      'auto.components.rightSidebar.parentPrChecks.groups.needsAttention',
      'Needs attention'
    )
  },
  get pending() {
    return translate('auto.components.rightSidebar.parentPrChecks.groups.pending', 'Pending')
  },
  get merged() {
    return translate('auto.components.rightSidebar.parentPrChecks.groups.merged', 'Merged')
  },
  get passing() {
    return translate('auto.components.rightSidebar.parentPrChecks.groups.passing', 'Passing')
  },
  get draftOrNoChecks() {
    return translate(
      'auto.components.rightSidebar.parentPrChecks.groups.draftOrNoChecks',
      'Draft / no checks'
    )
  },
  get noPr() {
    return translate('auto.components.rightSidebar.parentPrChecks.groups.noPr', 'No PR')
  },
  get unavailable() {
    return translate(
      'auto.components.rightSidebar.parentPrChecks.groups.unavailable',
      'Unavailable'
    )
  }
}

export const PARENT_PR_CHECKS_GROUP_ORDER: ParentPrChecksGroupKey[] = [
  'needsAttention',
  'pending',
  'merged',
  'passing',
  'draftOrNoChecks',
  'noPr',
  'unavailable'
]
