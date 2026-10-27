import { translate } from '@/i18n/i18n'
import {
  gitLabJobCanHaveTrace,
  gitLabJobTraceToCheckRunDetails
} from '../../../shared/gitlab-job-trace-check-details'
import type { GitLabProjectRef } from '../../../shared/gitlab-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/github/check-types'
import { gitLabApiFor, JOB_TRACE_TIMEOUT_MS } from './gitlab-owner-api'
import { withGitLabIpcTimeout } from './gitlab-ipc-timeout'

/** Load GitLab job logs as provider-neutral details; null permits other-provider fallback, while GitLab failures throw for caller error UI. */
export async function loadGitLabJobLogDetails(args: {
  repoPath: string
  repoId?: string
  repoOwnerExecutionHostId?: string
  check: PRCheckDetail
  /** Fork/cross-project MRs run their pipeline outside the repo's own project. */
  projectRef?: GitLabProjectRef | null
}): Promise<PRCheckRunDetails | null> {
  const jobId = args.check.gitlabJobId
  if (!jobId) {
    return null
  }
  if (!gitLabJobCanHaveTrace(args.check)) {
    return gitLabJobTraceToCheckRunDetails(args.check, '', emptyTraceStrings())
  }
  const result = await withJobTraceTimeout(
    gitLabApiFor(args).jobTrace({
      repoPath: args.repoPath,
      repoId: args.repoId,
      jobId,
      projectRef: args.projectRef ?? null,
      logExcerpt: true
    })
  )
  if (!result?.ok) {
    throw new Error(
      result?.error?.trim() ||
        translate(
          'auto.runtime.gitlabJobTraceClient.loadFailed',
          'Failed to load the GitLab job log.'
        )
    )
  }
  return gitLabJobTraceToCheckRunDetails(args.check, result.trace, emptyTraceStrings())
}

// Expanded Checks needs its own timeout message, not the generic GitLab text.
function withJobTraceTimeout<T>(pending: Promise<T>): Promise<T> {
  return withGitLabIpcTimeout(pending, {
    timeoutMs: JOB_TRACE_TIMEOUT_MS,
    message: translate(
      'auto.runtime.gitlabJobTraceClient.timedOut',
      'Timed out loading the GitLab job log.'
    )
  })
}

// Called per-request, not at module scope, so the active locale applies.
function emptyTraceStrings(): { emptyTrace: string } {
  return {
    emptyTrace: translate(
      'auto.runtime.gitlabJobTraceClient.emptyTrace',
      'No log is available for this GitLab job.'
    )
  }
}
