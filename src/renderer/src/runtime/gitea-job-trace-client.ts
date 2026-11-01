import { translate } from '@/i18n/i18n'
import {
  gitLabJobCanHaveTrace,
  gitLabJobTraceToCheckRunDetails
} from '../../../shared/gitlab-job-trace-check-details'
import type { GiteaProjectRef } from '../../../shared/gitea-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/github/check-types'
import { giteaApiFor } from './gitea-owner-api'
import { withGitLabIpcTimeout } from './gitlab-ipc-timeout'
import { codeHostErrorText } from '@/lib/code-host-error-copy'

const GITEA_JOB_TRACE_TIMEOUT_MS = 65_000

/** Load Gitea Actions job logs as provider-neutral details; null permits other-provider fallback, while Gitea failures throw for caller error UI. */
export async function loadGiteaJobLogDetails(args: {
  repoPath: string
  repoId?: string
  repoOwnerExecutionHostId?: string
  check: PRCheckDetail
  projectRef?: GiteaProjectRef | null
}): Promise<PRCheckRunDetails | null> {
  const jobId = args.check.giteaJobId
  if (!jobId) {
    return null
  }
  // The shared adapter keys the job entry off gitlabJobId; the status rules are provider-neutral.
  const traceCheck: PRCheckDetail = { ...args.check, gitlabJobId: jobId }
  if (!gitLabJobCanHaveTrace(traceCheck)) {
    return gitLabJobTraceToCheckRunDetails(traceCheck, '', emptyTraceStrings())
  }
  const result = await withJobTraceTimeout(
    giteaApiFor(args).jobTrace({
      repoPath: args.repoPath,
      repoId: args.repoId,
      jobId,
      projectRef: args.projectRef ?? null,
      logExcerpt: true
    })
  )
  if (!result?.ok) {
    throw new Error(
      (result ? codeHostErrorText(result) : undefined)?.trim() ||
        translate(
          'auto.runtime.giteaJobTraceClient.loadFailed',
          'Failed to load the Gitea job log.'
        )
    )
  }
  return gitLabJobTraceToCheckRunDetails(traceCheck, result.trace, emptyTraceStrings())
}

function withJobTraceTimeout<T>(pending: Promise<T>): Promise<T> {
  return withGitLabIpcTimeout(pending, {
    timeoutMs: GITEA_JOB_TRACE_TIMEOUT_MS,
    message: translate(
      'auto.runtime.giteaJobTraceClient.timedOut',
      'Timed out loading the Gitea job log.'
    )
  })
}

// Called per-request, not at module scope, so the active locale applies.
function emptyTraceStrings(): { emptyTrace: string } {
  return {
    emptyTrace: translate(
      'auto.runtime.giteaJobTraceClient.emptyTrace',
      'No log is available for this Gitea job.'
    )
  }
}
