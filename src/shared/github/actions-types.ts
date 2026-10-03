import type { PRCheckRunDetails } from './check-types'
import type { GitHubRepositoryIdentity } from './pull-request-types'
import type { TaskSourceContext } from '../task-source-context'

export const ACTIONS_RUNS_PER_PAGE = 50
export const ACTIONS_RUNS_MAX_PAGE = 20
export const ACTIONS_JOBS_PER_PAGE = 100
export const ACTIONS_JOBS_MAX_PAGE = 10
export const ACTIONS_STATUSES = [
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
  'completed',
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'skipped',
  'neutral',
  'stale'
] as const

export type ActionsRun = {
  id: number
  workflowPath?: string | null
  workflowId: number
  runNumber: number
  runAttempt: number
  name: string
  displayTitle: string
  headBranch: string | null
  headSha: string | null
  event: string | null
  actor: string | null
  status: string | null
  conclusion: string | null
  htmlUrl: string | null
  createdAt: string | null
  updatedAt: string | null
  runStartedAt: string | null
}
export type ActionsWorkflow = {
  id: number
  name: string
  path: string | null
  state: string | null
}
export type ActionsPage<T> = {
  repository: GitHubRepositoryIdentity
  items: T[]
  page: number
  perPage: number
  totalCount: number | null
  hasNextPage: boolean
  limitReached: boolean
}
export type ActionsRunsQuery = {
  page?: number
  workflowId?: number
  branch?: string
  status?: string
  noCache?: boolean
}
export type ActionsWorkflowsQuery = { page?: number; noCache?: boolean }
export type ActionsDetailsQuery = {
  repository: GitHubRepositoryIdentity
  runId: number
  jobsPage?: number
  expectedAttempt?: number
  noCache?: boolean
}
export type ActionsDetailMetadata = {
  repository: GitHubRepositoryIdentity
  run: ActionsRun
  jobsPage: number
  hasNextPage: boolean
  limitReached: boolean
  totalJobs: number | null
  jobsError: string | null
  logWarnings: string[]
}
export type ActionsRunDetails = PRCheckRunDetails & { actions: ActionsDetailMetadata }
export type ActionsRequestContext = {
  ownerKey?: string
  repoId: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
}
