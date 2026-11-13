export type CommunityArtifactReceipt = {
  artifactId: number
  name: string
  path: string
  bytes: number
  digest: string
  githubDigestMatched: boolean
  stagedAt: string
  sourceUrl: string
}
export type CommunityCandidatePlan = {
  id: string
  createdAt: string
  baseSha: string
  profileMode: 'isolated-preview' | 'interactive-preview' | 'shared-profile' | null
  customSource: { repository: string; commit: string } | null
  includedChanges: {
    id: string
    title: string
    pullRequest?: { number: number; headSha: string; url: string }
  }[]
  additions: { number: number; title: string; headSha: string; sourceUrl: string }[]
  digest: string
}
export type CommunityCandidateRun = {
  artifact: CommunityArtifactReceipt | null
  plan: CommunityCandidatePlan
  repository: string
  workflowRef: string
  workflowCommit: string
  source: { repository: string; commit: string; branch: string } | null
  requestedAt: string
  runId: number | null
  url: string | null
  state: string
  conclusion: string | null
  artifactUrl: string | null
}

export type CommunityCandidateHistoryPage = {
  rows: { plan: CommunityCandidatePlan; run: CommunityCandidateRun | null }[]
  nextOffset: number | null
}
