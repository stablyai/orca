import type { HostedReviewInfo } from './hosted-review'

const rawIdentity = { iid: 7, title: 'Release', state: 'opened', has_conflicts: false }
const reviewIdentity = {
  provider: 'gitlab',
  number: 7,
  title: 'Release',
  state: 'open',
  url: '',
  updatedAt: ''
} satisfies Omit<HostedReviewInfo, 'status' | 'mergeable'>

export const gitlabMrCheckCases = [
  {
    name: 'failed pipeline',
    raw: {
      ...rawIdentity,
      head_pipeline: { status: 'failed' },
      detailed_merge_status: 'ci_must_pass'
    },
    review: {
      ...reviewIdentity,
      status: 'failure',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'ci_must_pass'
    } satisfies HostedReviewInfo,
    cardLabel: 'MR checks: Failed',
    tone: 'text-rose-500/85',
    rowSummary: 'Checks failing',
    mergeLabel: 'Checks must pass',
    directMergeAvailable: false
  },
  {
    name: 'mergeable manual pipeline',
    raw: {
      ...rawIdentity,
      head_pipeline: { status: 'manual' },
      detailed_merge_status: 'mergeable'
    },
    review: {
      ...reviewIdentity,
      status: 'neutral',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'mergeable'
    } satisfies HostedReviewInfo,
    cardLabel: 'MR: Open',
    tone: 'text-emerald-500/80',
    rowSummary: 'No check signal',
    mergeLabel: 'Able to merge',
    directMergeAvailable: true
  },
  {
    name: 'blocked manual pipeline',
    raw: {
      ...rawIdentity,
      head_pipeline: { status: 'manual' },
      detailed_merge_status: 'ci_must_pass'
    },
    review: {
      ...reviewIdentity,
      status: 'pending',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'ci_must_pass'
    } satisfies HostedReviewInfo,
    cardLabel: 'MR checks: Pending',
    tone: 'text-amber-500/85',
    rowSummary: 'Checks pending',
    mergeLabel: 'Checks must pass',
    directMergeAvailable: false
  }
]
