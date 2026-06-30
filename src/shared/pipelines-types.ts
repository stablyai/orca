import type { TuiAgent } from './types'

export type PipelineExecutionTargetType = 'local' | 'ssh'

export type PipelineRunStatus =
  | 'pending'
  | 'planning'
  | 'dispatching'
  | 'executing'
  | 'reviewing'
  | 'merging'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type PipelineIterationStatus =
  | 'pending'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'merging'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type PipelineTaskStatus =
  | 'planned'
  | 'worktree_created'
  | 'dispatched'
  | 'implemented'
  | 'reviewed'
  | 'no_changes'
  | 'merged'
  | 'skipped'
  | 'verified'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type PipelineStageName =
  | 'task_source'
  | 'planner'
  | 'implement'
  | 'review'
  | 'merge'
  | 'verify'

export type PipelineStageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'interrupted'

export type PipelineLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type PipelineTaskRecordSourceType = 'github_issue' | 'manual'

export type PipelineRunStatusReason = 'prd_closed'

export type PipelineReservationStatus = 'active' | 'released'

export type PipelineRecoveryReportStatus = 'pending_ack' | 'acknowledged'

export type PipelineManualTaskSourceItem = {
  id: string
  title: string
  body: string
}

export type PipelineTaskSource =
  | {
      type: 'github_issues'
      provider: 'github'
      owner: string
      repo: string
      prdIssueNumber: number
      pipelinePrdLabel: string
      state: 'open'
    }
  | {
      type: 'manual'
      tasks: PipelineManualTaskSourceItem[]
    }

export type PipelineVerifierConfig = {
  commands: string[]
  timeoutSeconds: number
}

export type PipelineError = {
  message: string
  code?: string
  details?: unknown
}

export type PipelineRunInput = {
  templateId: string
  repoId: string
  sourceBranch: string
  targetBranch: string
  taskSource: PipelineTaskSource
  maxConcurrent: number
  maxIterations?: number
  plannerAgentId: TuiAgent
  implementerAgentId: TuiAgent
  reviewerAgentId?: TuiAgent
  mergerAgentId: TuiAgent
  verifier?: PipelineVerifierConfig
  executionTargetType: PipelineExecutionTargetType
  executionTargetId?: string
}

export type PipelineRun = {
  id: string
  templateId: string
  repoId: string
  sourceBranch: string
  targetBranch: string
  taskSource: PipelineTaskSource
  status: PipelineRunStatus
  statusReason: PipelineRunStatusReason | null
  maxConcurrent: number
  maxIterations: number
  currentIteration: number
  plannerAgentId: TuiAgent
  implementerAgentId: TuiAgent
  reviewerAgentId: TuiAgent | null
  mergerAgentId: TuiAgent
  verifier: PipelineVerifierConfig | null
  executionTargetType: PipelineExecutionTargetType
  executionTargetId: string | null
  automationRunId: string | null
  replacesRunId: string | null
  recoveryReportId: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  error: PipelineError | null
}

export type PipelineIteration = {
  id: string
  runId: string
  iterationNumber: number
  status: PipelineIterationStatus
  plannerTerminalId: string | null
  plannerWorktreeId: string | null
  coordinatorRunId: string | null
  plannerOutput: unknown
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  error: PipelineError | null
}

export type PipelineTask = {
  id: string
  runId: string
  iterationId: string
  sourceType: PipelineTaskRecordSourceType
  sourceId: string
  title: string
  branch: string
  status: PipelineTaskStatus
  blockedBy: string[]
  orchestrationTaskId: string | null
  worktreeId: string | null
  terminalIds: string[]
  commitShas: string[]
  result: unknown
  issueClosure: unknown
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  error: PipelineError | null
}

export type PipelineStage = {
  id: string
  runId: string
  iterationId: string | null
  taskId: string | null
  stage: PipelineStageName
  status: PipelineStageStatus
  worktreeId: string | null
  terminalId: string | null
  startedAt: string | null
  completedAt: string | null
  outputSnapshot: string | null
  error: PipelineError | null
}

export type PipelineLogEntry = {
  id: string
  runId: string
  iterationId: string | null
  taskId: string | null
  stageId: string | null
  level: PipelineLogLevel
  message: string
  payload: unknown
  createdAt: string
}

export type PipelineDynamicContextResult = {
  id: string
  runId: string
  stageId: string | null
  templateId: string
  command: string
  cwd: string
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  createdAt: string
  completedAt: string | null
}

export type PipelinePrdWorkSetKey = {
  repoId: string
  providerOwner: string
  providerRepo: string
  prdIssueNumber: number
  pipelinePrdLabel: string
}

export type PipelineActiveRunReservation = PipelinePrdWorkSetKey & {
  id: string
  runId: string
  status: PipelineReservationStatus
  createdAt: string
  releasedAt: string | null
  releaseReason: string | null
  lastSeenAt: string
  executionTargetType: PipelineExecutionTargetType
  executionTargetId: string | null
}

export type PipelineRecoveryReportSummary = {
  completedTaskIssueNumbers: number[]
  openReadyTaskIssueNumbers: number[]
  preservedWorktreeIds: string[]
  dirtyWorktreeIds: string[]
  liveTerminalIds: string[]
  missingTerminalIds: string[]
}

export type PipelineRecoveryReport = PipelinePrdWorkSetKey & {
  id: string
  interruptedRunId: string
  replacementRunId: string | null
  status: PipelineRecoveryReportStatus
  summary: PipelineRecoveryReportSummary
  createdAt: string
  acknowledgedAt: string | null
}

export type PipelinePrdCandidate = {
  provider: 'github'
  owner: string
  repo: string
  prdIssueNumber: number
  prdTitle: string
  pipelinePrdLabel: string
  readyTaskCount: number
  openTaskCount: number
  latestTaskUpdatedAt: string
  latestPrdUpdatedAt: string
  activeRunId?: string
  reservationId?: string
}

export type PipelineRunDetail = {
  run: PipelineRun
  iterations: PipelineIteration[]
  tasks: PipelineTask[]
  stages: PipelineStage[]
  logs: PipelineLogEntry[]
  dynamicContextResults: PipelineDynamicContextResult[]
}
