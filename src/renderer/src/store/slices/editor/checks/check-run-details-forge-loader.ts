import type { AppState } from '../../../types'
import { loadGitLabJobLogDetails } from '@/runtime/repository-gitlab/gitlab-job-trace-client'
import { loadGiteaJobLogDetails } from '@/runtime/repository-gitea/gitea-job-trace-client'
import type { OpenCheckRunDetailsState } from '../../../../../../shared/editor/views/editor-tab-view-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'

type LoaderInput = {
  repo: Pick<Repo, 'id' | 'path'>
  repoOwnerExecutionHostId: Parameters<
    typeof loadGitLabJobLogDetails
  >[0]['repoOwnerExecutionHostId']
  check: OpenCheckRunDetailsState['check']
  checkRunDetails: OpenCheckRunDetailsState
  fetchPRCheckDetails: AppState['fetchPRCheckDetails']
}

/** GitLab/Gitea jobs need their own trace; GitHub check-runs returns null and blanks the refreshed tab. */
export function loadCheckRunDetailsForForge({
  repo,
  repoOwnerExecutionHostId,
  check,
  checkRunDetails,
  fetchPRCheckDetails
}: LoaderInput) {
  if (check.giteaJobId) {
    return loadGiteaJobLogDetails({
      repoPath: repo.path,
      repoId: repo.id,
      repoOwnerExecutionHostId,
      check
    })
  }
  if (check.gitlabJobId) {
    return loadGitLabJobLogDetails({
      repoPath: repo.path,
      repoId: repo.id,
      repoOwnerExecutionHostId,
      check,
      // Why: a fork MR's job lives in the source project, not the repo's own.
      projectRef: checkRunDetails.gitlabProjectRef ?? null
    })
  }
  return fetchPRCheckDetails(
    repo.path,
    {
      checkRunId: check.checkRunId,
      workflowRunId: check.workflowRunId,
      checkName: check.name,
      url: check.url,
      prRepo: checkRunDetails.githubRepository ?? null
    },
    { repoId: repo.id, repoOwnerExecutionHostId }
  )
}
