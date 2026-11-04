export type PRCheckDetail = {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'timed_out'
    | 'neutral'
    | 'skipped'
    | 'pending'
    // Manual-approval suites may have no check run/rollup row yet block auto-merge as unstable; expose them separately.
    | 'action_required'
    | null
  url: string | null
  checkRunId?: number
  workflowRunId?: number
  // GitLab trace retrieval requires numeric job id, so carry it through the Checks row.
  gitlabJobId?: number
}

export type PRCheckAnnotation = {
  path: string | null
  startLine: number | null
  endLine: number | null
  annotationLevel: string | null
  title: string | null
  message: string
  rawDetails: string | null
}

export type PRCheckStep = {
  name: string
  status: string | null
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
}

export type PRCheckJob = {
  id: number | null
  name: string
  status: string | null
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  url: string | null
  logTail: string | null
  logState?: 'available' | 'empty' | 'error' | 'not_requested'
  steps: PRCheckStep[]
}

export type PRCheckRunDetails = {
  name: string
  status: PRCheckDetail['status'] | (string & {}) | null
  conclusion: PRCheckDetail['conclusion'] | (string & {}) | null
  url: string | null
  detailsUrl: string | null
  startedAt: string | null
  completedAt: string | null
  title: string | null
  summary: string | null
  text: string | null
  annotations: PRCheckAnnotation[]
  jobs: PRCheckJob[]
}

export type GitHubRerunPRChecksResult = { ok: true; count: number } | { ok: false; error: string }
