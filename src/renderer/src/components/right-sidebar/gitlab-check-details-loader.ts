import type {
  GitLabJobTraceResult,
  PRCheckDetail,
  PRCheckRunDetails
} from '../../../../shared/types'
import { gitLabJobTraceToCheckRunDetails } from '../../../../shared/gitlab-job-trace-check-details'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

/**
 * Loads inline details for a GitLab pipeline job by fetching its trace via
 * `gitlab:jobTrace` and adapting it into the shared `PRCheckRunDetails` shape.
 * Shared by the Checks panel and the full-details editor tab so both surfaces
 * render GitLab jobs through the same GitHub-parity rendering path.
 *
 * Returns `null` when the check is not a GitLab job (no `gitlabJobId`); throws
 * on a failed trace fetch so callers can surface the GitLab error verbatim.
 */
export async function loadGitLabCheckRunDetails(args: {
  repoPath: string
  repoId?: string
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
  check: PRCheckDetail
}): Promise<PRCheckRunDetails | null> {
  const jobId = args.check.gitlabJobId
  if (!jobId) {
    return null
  }
  const target = getActiveRuntimeTarget(args.settings)
  const result =
    target.kind === 'environment'
      ? await callRuntimeRpc<GitLabJobTraceResult>(
          target,
          'gitlab.jobTrace',
          { repo: args.repoId ?? args.repoPath, jobId },
          { timeoutMs: 30_000 }
        )
      : ((await window.api.gl.jobTrace({
          repoPath: args.repoPath,
          repoId: args.repoId,
          jobId
        })) as GitLabJobTraceResult)
  if (!result.ok) {
    throw new Error(result.error || 'Failed to load GitLab job log.')
  }
  return gitLabJobTraceToCheckRunDetails(args.check, result.trace)
}
