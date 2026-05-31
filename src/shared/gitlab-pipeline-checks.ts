import type { GitLabPipelineJob } from './gitlab-types'
import type { PRCheckDetail } from './types'

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
  // Why: manual GitLab jobs are intentionally waiting for a human trigger;
  // treating them as pending would make the Checks tab look stuck forever.
  if (s === 'manual') {
    return 'neutral'
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

export function gitLabPipelineJobsToPRChecks(jobs: GitLabPipelineJob[]): PRCheckDetail[] {
  return jobs.map((job) => ({
    name: job.stage ? `${job.stage}: ${job.name}` : job.name,
    status: mapGitLabPipelineJobStatusToCheckStatus(job.status),
    conclusion: mapGitLabPipelineJobStatusToConclusion(job.status),
    url: job.webUrl || null
  }))
}
