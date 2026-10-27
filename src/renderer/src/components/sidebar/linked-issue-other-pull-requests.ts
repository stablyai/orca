import type {
  IssueInfo,
  LinkedPullRequestSummary
} from '../../../../shared/github/pull-request-types'

/** Open PRs for the linked issue that aren't this workspace's own, by number or head branch. */
export function otherOpenLinkedPullRequests(
  issue: Pick<IssueInfo, 'openLinkedPullRequests'>,
  workspace: { ownReviewNumber: number | null | undefined; branch: string | null | undefined }
): LinkedPullRequestSummary[] {
  const branch = workspace.branch?.replace(/^refs\/heads\//, '')
  return (issue.openLinkedPullRequests ?? []).filter(
    (pr) => pr.number !== workspace.ownReviewNumber && (!branch || pr.headRefName !== branch)
  )
}
