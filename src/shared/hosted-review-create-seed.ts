import { escapeRegex } from './string-utils'
import { JIRA_ISSUE_KEY_PATTERN } from './jira/jira-issue-url'
import { prefixJiraReviewTitle } from './jira/jira-review-title'
import { humanizeBranchSlug } from './branch-name-from-work'
import type { HostedReviewCreationEligibility } from './hosted-review'
import { normalizeHostedReviewHeadRef } from './hosted-review-refs'

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

export type CreateReviewSeedCommit = { subject: string; body?: string }

/**
 * GitHub's own default for a new pull request: one commit gives its subject and body; several give
 * the branch title and a list of their subjects. Commits are oldest first. Desktop still seeds from
 * the branch alone through resolveCreateReviewSeedText.
 */
export function resolveCreateReviewSeedFromCommits({
  commits,
  ...input
}: Parameters<typeof resolveCreateReviewSeedText>[0] & {
  commits: readonly CreateReviewSeedCommit[]
}): { title: string; body: string } {
  const seed = resolveCreateReviewSeedText(input)
  const hostTitle = input.eligibility?.title?.trim()
  const subjects = commits.map((commit) => commit.subject.trim()).filter(Boolean)
  if (subjects.length === 0) {
    return seed
  }
  if (subjects.length === 1) {
    const reviewJiraIssueKey =
      input.eligibility?.provider === 'github' || input.eligibility?.provider === 'gitlab'
        ? input.jiraIssueKey
        : null
    return {
      title: hostTitle ? seed.title : prefixJiraReviewTitle(subjects[0], reviewJiraIssueKey),
      body: seed.body.trim() ? seed.body : (commits[0].body?.trim() ?? '')
    }
  }
  return {
    title: seed.title,
    body: seed.body.trim() ? seed.body : subjects.map((subject) => `- ${subject}`).join('\n')
  }
}
