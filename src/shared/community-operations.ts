import type {
  CommunityPullRequest,
  CommunitySourceRecord,
  CommunitySyncStatus
} from './community-catalog'
import type {
  CommunityFeature,
  CommunityFeatureHistoryPage,
  CommunityFeaturesSnapshot
} from './community-features'

export type CommunityQuery = {
  query?: string
  view?: 'explore' | 'saved' | 'viewed' | 'selected'
  area?: string
  kind?: string
  images?: boolean
  sort?: 'updated' | 'popular' | 'oldest'
  offset?: number
  limit?: number
}
export type CommunitySummary = {
  capturedAt: string | null
  total: number
  contributors: number
  images: number
  drafts: number
  areas: { name: string; count: number }[]
  kinds: { name: string; count: number }[]
  weeks: { date: string; count: number }[]
}
export type CommunityPage = {
  rows: CommunityPullRequest[]
  total: number
  nextOffset: number | null
  summary: CommunitySummary
  status: CommunitySyncStatus
  personal: CommunityFeaturesSnapshot
}
export type CommunityRelease = {
  tag: string
  name: string
  url: string
  publishedAt: string
  body: string
  prerelease: boolean
}
export type CommunityCheck = { name: string; state: string; url: string | null }
export type CommunityReview = {
  author: string
  state: string
  commit: string
  at: string | null
  url: string
}
export type CommunitySourceDiff = {
  baseSha: string
  headSha: string
  files: { path: string; status: string; patch: string | null }[]
  complete: boolean
}
export type CommunityDetail = {
  diff: CommunitySourceDiff | null
  pr: CommunityPullRequest
  body: string
  checks: CommunityCheck[]
  checksObserved: boolean
  checksComplete: boolean
  reviews: CommunityReview[]
  reviewsObserved: boolean
  warnings: string[]
  reviewsComplete: boolean
  mergeCommit: string | null
  mergedAt: string | null
  observedAt: string
  feature: CommunityFeature | null
  sourceHistory: CommunitySourceRecord[]
  history: CommunityFeatureHistoryPage
}
export type CommunityActivity = {
  capturedAt: string
  since: string
  complete: boolean
  cutoff: string
  rows: {
    number: number
    author: string
    authorAssociation: string
    memberReviewed: boolean | null
    memberApproved: boolean | null
    createdAt: string
    merged: boolean
    closed: boolean
    reviewed: boolean | null
    approved: boolean | null
    maintainerReviewed: boolean | null
    maintainerApproved: boolean | null
  }[]
  maintainers: string[] | null
  roleError: string | null
}
