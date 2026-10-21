import type { GitLabProjectRef } from '../../../../shared/gitlab-types'
import type { OpenCheckRunDetailsState } from '../../../../shared/editor-tab-view-types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'

export type CheckRunDetailsTabPatch = Pick<
  OpenCheckRunDetailsState,
  'requestId' | 'details' | 'loading' | 'error' | 'githubRepository' | 'gitlabProjectRef'
>

let nextCheckRunDetailsRequestId = 0

export function createCheckRunDetailsRequestId(): number {
  nextCheckRunDetailsRequestId += 1
  return nextCheckRunDetailsRequestId
}

export function isSameGitLabProjectRef(
  a: GitLabProjectRef | null,
  b: GitLabProjectRef | null
): boolean {
  return a === b || (a?.host === b?.host && a?.path === b?.path)
}

export function isSameGitHubRepository(
  a: GitHubRepositoryIdentity | null,
  b: GitHubRepositoryIdentity | null
): boolean {
  return a === b || (a?.owner === b?.owner && a?.repo === b?.repo && a?.host === b?.host)
}

export function getCheckRunTabIdentity(check: PRCheckDetail): string {
  if (check.checkRunId) {
    return `check-run:${check.checkRunId}`
  }
  if (check.workflowRunId) {
    return `workflow-run:${check.workflowRunId}`
  }
  // Why: GitLab jobs reuse `stage: name` across pipeline runs and can lack a web_url,
  // so the numeric job id is the only stable per-job tab identity.
  if (check.gitlabJobId) {
    return `gitlab-job:${check.gitlabJobId}`
  }
  if (check.url) {
    return `url:${check.url}`
  }
  return `name:${check.name}`
}

export function buildCheckRunDetailsTabId(worktreeId: string, check: PRCheckDetail): string {
  // Why: one tab per hosted check identity keeps the center pane stable across
  // PR head refreshes; contextKey lives on the tab state instead of the tab id.
  return `${worktreeId}::check-details::${getCheckRunTabIdentity(check)}`
}

export function getCheckRunDetailsTabLabel(check: PRCheckDetail): string {
  return check.name
}
