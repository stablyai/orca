import type { GitLabPipeline, GitLabPipelineJob } from '../../../gitlab-types'
import type { PRCheckDetail } from '../../../github/check-types'
import type { CheckStatus } from '../../../github/pull-request-types'
import { checkRunTimes } from '../pr-check-time'

export function mapGitLabPipelineJobStatusToCheckStatus(status: string): PRCheckDetail['status'] {
  const s = status.toLowerCase()
  if (
    s === 'created' ||
    s === 'pending' ||
    s === 'scheduled' ||
    s === 'waiting_for_callback' ||
    s === 'waiting_for_resource' ||
    s === 'preparing'
  ) {
    return 'queued'
  }
  if (s === 'running') {
    return 'in_progress'
  }
  return 'completed'
}

export function mapGitLabPipelineJobStatusToConclusion(
  status: string
): PRCheckDetail['conclusion'] {
  const s = status.toLowerCase()
  if (s === 'success') {
    return 'success'
  }
  if (s === 'failed') {
    return 'failure'
  }
  if (s === 'canceled' || s === 'canceling') {
    return 'cancelled'
  }
  if (s === 'skipped') {
    return 'skipped'
  }
  // Manual jobs wait for a person; pending looks stuck, while action_required falsely marks green MRs as failing.
  if (s === 'manual') {
    return 'neutral'
  }
  if (s === 'action_required') {
    return 'action_required'
  }
  if (
    s === 'created' ||
    s === 'pending' ||
    s === 'running' ||
    s === 'waiting_for_callback' ||
    s === 'waiting_for_resource' ||
    s === 'preparing' ||
    s === 'scheduled'
  ) {
    return 'pending'
  }
  return null
}

const PIPELINE_CONCLUSION: Record<CheckStatus, PRCheckDetail['conclusion']> = {
  success: 'success',
  failure: 'failure',
  pending: 'pending',
  neutral: 'neutral'
}

/** The parent pipeline as a provider link, never a job row: its outcome follows pipeline-level policy. */
export function gitLabPipelineToPRCheck(
  pipeline: GitLabPipeline,
  pipelineLabel = 'Pipeline',
  mrHeadSha?: string
): PRCheckDetail {
  const notLatestCommitSha = getGitLabPipelineNotLatestCommitSha(pipeline, mrHeadSha)
  // The host settles the verdict with the MR status rule; a reply without one claims no outcome.
  const verdict = pipeline.checkStatus ?? 'neutral'
  return {
    name: `${pipelineLabel} #${pipeline.id}`,
    // Settled pipelines read as completed so shared classifiers agree with the pipeline verdict.
    status:
      verdict === 'pending'
        ? mapGitLabPipelineJobStatusToCheckStatus(pipeline.status)
        : 'completed',
    conclusion: PIPELINE_CONCLUSION[verdict],
    url: pipeline.webUrl ?? null,
    ...checkRunTimes(pipeline.startedAt, pipeline.finishedAt),
    ...(notLatestCommitSha ? { notLatestCommitSha } : {})
  }
}

// Merged-results and merge-train pipelines run on a synthetic merge commit, so their sha never equals the MR head.
const MERGE_COMMIT_PIPELINE_REF = /^refs\/merge-requests\/\d+\/(?:merge|train)$/

/** The pipeline's commit when the MR head has moved past it; unknown or merge-commit pipelines claim nothing. */
export function getGitLabPipelineNotLatestCommitSha(
  pipeline: GitLabPipeline,
  mrHeadSha: string | undefined
): string | undefined {
  if (
    !pipeline.sha ||
    !mrHeadSha ||
    !pipeline.ref ||
    MERGE_COMMIT_PIPELINE_REF.test(pipeline.ref)
  ) {
    return undefined
  }
  return pipeline.sha.toLowerCase() === mrHeadSha.toLowerCase() ? undefined : pipeline.sha
}

export function gitLabPipelineJobOutcome(job: {
  status?: string
  allowFailure?: boolean
}): Pick<PRCheckDetail, 'status' | 'conclusion' | 'gitlabAllowedFailure'> {
  const status = job.status ?? ''
  const allowedFailure = status.toLowerCase() === 'failed' && job.allowFailure === true
  return {
    status: mapGitLabPipelineJobStatusToCheckStatus(status),
    conclusion: allowedFailure ? 'neutral' : mapGitLabPipelineJobStatusToConclusion(status),
    ...(allowedFailure ? { gitlabAllowedFailure: true } : {})
  }
}

export function gitLabPipelineJobsToPRChecks(jobs: GitLabPipelineJob[]): PRCheckDetail[] {
  return jobs.map((job) => ({
    name: job.stage ? `${job.stage}: ${job.name}` : job.name,
    ...gitLabPipelineJobOutcome(job),
    url: job.webUrl || null,
    ...checkRunTimes(job.startedAt, job.finishedAt),
    // Truthiness, not != null: the runtime RPC schema requires a positive int.
    ...(job.id ? { gitlabJobId: job.id } : {})
  }))
}
