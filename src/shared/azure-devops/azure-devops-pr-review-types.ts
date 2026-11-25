export const AZURE_DEVOPS_PR_REVIEW_READ_RUNTIME_CAPABILITY =
  'azure-devops.pr-review-read.v1' as const
export const AZURE_DEVOPS_PR_REVIEW_WRITE_RUNTIME_CAPABILITY =
  'azure-devops.pr-review-write.v1' as const

/** Azure DevOps reviewer votes: 10, 5, 0, -5, -10. */
export type AzureDevOpsVoteLabel =
  | 'approved'
  | 'approved-with-suggestions'
  | 'no-vote'
  | 'waiting-for-author'
  | 'rejected'

export type AzureDevOpsPullRequestStatus = 'active' | 'completed' | 'abandoned'

export type AzureDevOpsPrReviewer = {
  displayName: string
  uniqueName: string | null
  vote: number
  voteLabel: AzureDevOpsVoteLabel
  isRequired: boolean
  /** A team or group; its vote is the aggregate Azure DevOps computed. */
  isGroup: boolean
  isMe: boolean
}

export type AzureDevOpsPrSummary = {
  id: number
  title: string
  status: AzureDevOpsPullRequestStatus
  isDraft: boolean
  project: string
  repository: string
  author: string | null
  createdDate: string | null
  sourceBranch: string
  targetBranch: string
  url: string
  /** The signed-in user's vote when they are a reviewer, else null. */
  myVote: AzureDevOpsVoteLabel | null
}

export type AzureDevOpsPrDetail = AzureDevOpsPrSummary & {
  description: string
  mergeStatus: string | null
  reviewers: AzureDevOpsPrReviewer[]
  iterationCount: number
  sourceCommit: string | null
  targetCommit: string | null
}

export type AzureDevOpsPrThreadComment = {
  id: number
  parentId: number | null
  author: string | null
  publishedDate: string | null
  /** Markdown as the author wrote it; agents treat it as untrusted text. */
  content: string
}

export type AzureDevOpsPrThread = {
  id: number
  /** active, fixed, wontFix, closed, byDesign or pending; null for a thread with no status. */
  status: string | null
  filePath: string | null
  line: number | null
  comments: AzureDevOpsPrThreadComment[]
}

export type AzureDevOpsPrCheck = {
  name: string
  kind: 'build' | 'policy' | 'status'
  /** Policy: queued, running, approved, rejected, notApplicable, broken. Status: its state. */
  status: string
  isBlocking: boolean
  buildId: number | null
  /** The build ran on an older merge commit than the PR's current one. */
  isStale: boolean
  /** The PR head the build ran on, when the host reports it. */
  builtCommit: string | null
  url: string | null
}

export type AzureDevOpsPrFileChange = {
  path: string
  /** add, edit, delete, rename, or a comma-joined mix such as `edit, rename`. */
  changeType: string
  originalPath: string | null
}

export type AzureDevOpsPrFiles = {
  iteration: number
  /** The iteration the changes are measured from; 0 means the PR's merge base. */
  comparedTo: number
  baseCommit: string | null
  headCommit: string | null
  files: AzureDevOpsPrFileChange[]
}

export type AzureDevOpsBuildStep = {
  name: string
  /** Stage, Phase, Job or Task, as the build timeline reports it. */
  type: string
  state: string | null
  result: string | null
  errorCount: number
  logId: number | null
  /** Error and warning messages the step reported. */
  issues: string[]
}

export type AzureDevOpsBuildLog = {
  step: string
  lines: string[]
  /** Earlier lines were left out to keep the tail. */
  truncated: boolean
}

export type AzureDevOpsPrBuild = {
  id: number
  number: string | null
  definition: string | null
  status: string | null
  result: string | null
  sourceBranch: string | null
  sourceVersion: string | null
  startTime: string | null
  finishTime: string | null
  url: string | null
  steps: AzureDevOpsBuildStep[]
  /** Tails of the failed task logs, when asked for. */
  logs: AzureDevOpsBuildLog[]
}
