import type React from 'react'
import type { Badge } from '@/components/ui/badge'
import type {
  PipelineExecutionTargetType,
  PipelinePrdCandidate,
  PipelineRecoveryReport,
  PipelineRunDetail,
  PipelineRunInput,
  PipelineRunStatus
} from '../../../../shared/pipelines-types'
import type { TuiAgent } from '../../../../shared/types'

export const DEFAULT_PIPELINE_TEMPLATE_ID = 'parallel-planner-with-review'
export const SEQUENTIAL_REVIEWER_TEMPLATE_ID = 'sequential-reviewer'

export function getPipelineRunStatusLabel(status: PipelineRunStatus): string {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'planning':
      return 'Planning'
    case 'dispatching':
      return 'Dispatching'
    case 'executing':
      return 'Executing'
    case 'reviewing':
      return 'Reviewing'
    case 'merging':
      return 'Merging'
    case 'verifying':
      return 'Verifying'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Interrupted'
  }
}

export function getPipelineRunStatusVariant(
  status: PipelineRunStatus
): React.ComponentProps<typeof Badge>['variant'] {
  if (status === 'failed') {
    return 'destructive'
  }
  if (status === 'completed') {
    return 'secondary'
  }
  if (status === 'cancelled' || status === 'interrupted') {
    return 'outline'
  }
  return 'dot'
}

export function canCancelPipelineRun(status: PipelineRunStatus): boolean {
  return (
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'interrupted'
  )
}

export function summarizePipelineRunDetail(detail: PipelineRunDetail): {
  iterations: number
  tasks: number
  stages: number
  logs: number
  errors: number
} {
  return {
    iterations: detail.iterations.length,
    tasks: detail.tasks.length,
    stages: detail.stages.length,
    logs: detail.logs.length,
    errors:
      (detail.run.error ? 1 : 0) +
      detail.iterations.filter((iteration) => iteration.error).length +
      detail.tasks.filter((task) => task.error).length +
      detail.stages.filter((stage) => stage.error).length
  }
}

export function getPipelinePrdTabKey(
  candidate: Pick<PipelinePrdCandidate, 'owner' | 'repo' | 'prdIssueNumber' | 'pipelinePrdLabel'>
): string {
  return [
    'github',
    candidate.owner,
    candidate.repo,
    candidate.prdIssueNumber,
    candidate.pipelinePrdLabel
  ].join(':')
}

export function isSequentialReviewerTemplate(templateId: string): boolean {
  return templateId === SEQUENTIAL_REVIEWER_TEMPLATE_ID
}

export function getEffectiveMaxConcurrent(templateId: string, value: number): number {
  return isSequentialReviewerTemplate(templateId) ? 1 : value
}

export function buildPipelineRunInputFromCandidate(input: {
  candidate: PipelinePrdCandidate
  templateId: string
  repoId: string
  sourceBranch: string
  targetBranch: string
  maxConcurrent: number
  maxIterations: number
  agentId: TuiAgent
  executionTargetType: PipelineExecutionTargetType
  executionTargetId?: string
}): PipelineRunInput {
  return {
    templateId: input.templateId,
    repoId: input.repoId,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    taskSource: {
      type: 'github_issues',
      provider: 'github',
      owner: input.candidate.owner,
      repo: input.candidate.repo,
      prdIssueNumber: input.candidate.prdIssueNumber,
      pipelinePrdLabel: input.candidate.pipelinePrdLabel,
      state: 'open'
    },
    maxConcurrent: getEffectiveMaxConcurrent(input.templateId, input.maxConcurrent),
    maxIterations: input.maxIterations,
    plannerAgentId: input.agentId,
    implementerAgentId: input.agentId,
    reviewerAgentId: input.agentId,
    mergerAgentId: input.agentId,
    executionTargetType: input.executionTargetType,
    executionTargetId: input.executionTargetId
  }
}

export function getLatestPendingRecoveryReport(
  candidate: Pick<PipelinePrdCandidate, 'owner' | 'repo' | 'prdIssueNumber' | 'pipelinePrdLabel'>,
  reports: PipelineRecoveryReport[]
): PipelineRecoveryReport | null {
  return (
    reports
      .filter(
        (report) =>
          report.status === 'pending_ack' &&
          report.providerOwner === candidate.owner &&
          report.providerRepo === candidate.repo &&
          report.prdIssueNumber === candidate.prdIssueNumber &&
          report.pipelinePrdLabel === candidate.pipelinePrdLabel
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      )[0] ?? null
  )
}

export function getPipelineLaunchBlockReason(input: {
  candidate: PipelinePrdCandidate | null
  latestPendingRecoveryReport: PipelineRecoveryReport | null
}): string | null {
  if (!input.candidate) {
    return 'Choose a PRD work set.'
  }
  if (input.latestPendingRecoveryReport) {
    return 'Acknowledge the latest recovery report before starting a replacement run.'
  }
  if (input.candidate.activeRunId) {
    return 'This PRD work set already has an active Pipeline run.'
  }
  if (input.candidate.readyTaskCount <= 0) {
    return 'This PRD work set has no open ready task issues.'
  }
  return null
}
