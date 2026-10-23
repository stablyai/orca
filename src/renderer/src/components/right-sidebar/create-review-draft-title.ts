import { escapeRegex } from '../../../../shared/string-utils'
import { JIRA_ISSUE_KEY_PATTERN } from '../../../../shared/jira-issue-url'
import { prefixJiraReviewTitle } from '../../../../shared/jira-review-title'
import { humanizeBranchSlug } from '../../../../shared/branch-name-from-work'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { normalizeHostedReviewHeadRef } from '../../../../shared/hosted-review-refs'

export function resolveCreateReviewDraftTitle({
  branch,
  eligibilityTitle,
  jiraIssueKey
}: {
  branch: string
  eligibilityTitle?: string | null
  jiraIssueKey?: string | null
}): string {
  const title = eligibilityTitle?.trim()
  if (title) {
    return title
  }
  const normalizedBranch = normalizeHostedReviewHeadRef(branch)
  let branchLeaf = normalizedBranch.split('/').pop() ?? ''
  if (jiraIssueKey && JIRA_ISSUE_KEY_PATTERN.test(jiraIssueKey)) {
    branchLeaf = branchLeaf.replace(
      new RegExp(`^${escapeRegex(jiraIssueKey)}(?:[-_\\s]+|$)`, 'i'),
      ''
    )
  }
  branchLeaf = branchLeaf.replace(/_/g, '-')
  return humanizeBranchSlug(branchLeaf) || normalizedBranch
}

/** The title and body the composer seeds for a branch, before any edit or generation. */
export function resolveCreateReviewSeedText({
  branch,
  eligibility,
  jiraIssueKey
}: {
  branch: string
  eligibility:
    | (Pick<HostedReviewCreationEligibility, 'title' | 'body'> &
        Partial<Pick<HostedReviewCreationEligibility, 'provider'>>)
    | null
  jiraIssueKey?: string | null
}): { title: string; body: string } {
  const reviewJiraIssueKey =
    eligibility?.provider === 'github' || eligibility?.provider === 'gitlab' ? jiraIssueKey : null
  return {
    title: prefixJiraReviewTitle(
      resolveCreateReviewDraftTitle({
        branch,
        eligibilityTitle: eligibility?.title,
        jiraIssueKey: reviewJiraIssueKey
      }),
      reviewJiraIssueKey
    ),
    body: eligibility?.body ?? ''
  }
}
