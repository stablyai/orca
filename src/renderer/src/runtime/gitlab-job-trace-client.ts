import { translate } from '@/i18n/i18n'
import {
  gitLabJobCanHaveTrace,
  gitLabJobTraceToCheckRunDetails
} from '../../../shared/gitlab-job-trace-check-details'
import type { GitLabJobTraceResult, GitLabProjectRef } from '../../../shared/gitlab-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/types'
import { getActiveRuntimeTarget } from './runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'

const JOB_TRACE_TIMEOUT_MS = 30_000

/**
 * Load a GitLab pipeline job log as provider-neutral check details.
 *
 * Returns null for checks that are not GitLab jobs so callers can fall through to
 * their existing provider path. Throws on a GitLab-reported failure so the caller's
 * error handling surfaces the message instead of showing "no details available".
 */
export async function loadGitLabJobLogDetails(args: {
  repoPath: string
  repoId?: string
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
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
  const target = getActiveRuntimeTarget(args.settings)
  const result =
    target.kind === 'environment'
      ? await callRuntimeRpc<GitLabJobTraceResult>(
          target,
          'gitlab.jobTrace',
          {
            repo: args.repoId ?? args.repoPath,
            jobId,
            projectRef: args.projectRef ?? undefined,
            logExcerpt: true
          },
          { timeoutMs: JOB_TRACE_TIMEOUT_MS }
        )
      : await window.api.gl.jobTrace({
          repoPath: args.repoPath,
          repoId: args.repoId,
          jobId,
          projectRef: args.projectRef ?? null,
          logExcerpt: true
        })
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

// Called per-request, not at module scope, so the active locale applies.
function emptyTraceStrings(): { emptyTrace: string } {
  return {
    emptyTrace: translate(
      'auto.runtime.gitlabJobTraceClient.emptyTrace',
      'This GitLab job has not produced a log yet.'
    )
  }
}
