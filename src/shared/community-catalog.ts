export type CommunityPullRequest = {
  number: number
  title: string
  displayTitle: string
  url: string
  author: string
  createdAt: string
  updatedAt: string
  isDraft: boolean
  kind: string
  area: string
  comments: number | null
  prThumbsUp: number | null
  closingIssues: { number: number; title: string; url: string }[]
  headSha: string
  reviewDecision: string | null
  checkState: string | null
  checkObserved: boolean
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  imageUrls: string[]
  observedAt?: string
  state?: 'open' | 'closed' | 'merged'
}

export type CommunityCatalog = {
  repository: string
  capturedAt: string
  sourceUrl: string
  pullRequests: CommunityPullRequest[]
  groups: { id: string; label: string; area: string; members: number[] }[]
  screenshots: Record<string, { src: string; sourceUrl: string }>
  source?: 'bundled' | 'github'
  lastFullSyncAt?: string
}

export type CommunitySourceRecord = {
  id: string
  observedAt: string
  headSha: string
  state: 'open' | 'closed' | 'merged'
  url: string
}

export type CommunitySyncStatus = {
  running: boolean
  pages: number
  received: number
  error: string | null
  retryAt: string | null
}

export type CommunityApi = {
  read: () => Promise<{ catalog: CommunityCatalog | null; status: CommunitySyncStatus }>
  refresh: () => Promise<{ catalog: CommunityCatalog | null; status: CommunitySyncStatus }>
  cancel: () => Promise<void>
  detail: (number: number) => Promise<CommunityPullRequest>
  history: (number: number) => Promise<CommunitySourceRecord[]>
  onStatus: (listener: (status: CommunitySyncStatus) => void) => () => void
}
