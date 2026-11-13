export type CommunityChatReference = {
  headSha: string | null
  sessionId: string
  tabId: string
  workspaceId: string
  environmentId: string | null
  agent: string
}

export type CommunityReleaseProof = {
  headSha: string
  tag: string
  releaseCommit: string
  mergeCommit: string
  url: string
  comparisonUrl: string
  observedAt: string
}
export type CommunityEvidenceSignals = {
  headSha: string
  capturedAt: string
  review: 'approved' | 'changes-requested' | 'none' | 'unknown'
  checks: 'passed' | 'attention' | 'pending' | 'none' | 'unknown'
}
export type CommunityFeature = {
  signals: CommunityEvidenceSignals | null
  installed: {
    buildId: string
    baseVersion: string
    headSha: string
    title: string
    observedAt: string
  } | null
  candidate: { id: string; state: string; url: string | null; headSha: string } | null
  evidenceId: string | null
  release: CommunityReleaseProof | null
  number: number
  savedAt: string | null
  selectedAt: string | null
  visit: { headSha: string; at: string } | null
  chat: CommunityChatReference | null
  source: {
    title: string
    headSha: string
    state: 'open' | 'closed' | 'merged'
    observedAt: string
    imageUrls: string[]
  } | null
}

export type CommunityFeatureAction =
  | { action: 'save' | 'unsave' | 'select' | 'unselect'; number: number }
  | { action: 'visit'; number: number; headSha: string }
  | { action: 'link-chat'; number: number; chat: CommunityChatReference }

export type CommunityFeatureEvent = {
  id: string
  revision: number
  number: number
  at: string
  kind: string
  actor: 'user' | 'github' | 'runner' | 'build'
  headSha: string | null
  evidence: string[]
  summary: string
}

export type CommunityFeaturesSnapshot = {
  revision: number
  features: Record<string, CommunityFeature>
}

export type CommunityFeatureHistoryPage = {
  events: CommunityFeatureEvent[]
  nextBefore: number | null
}
