import { parseGitHubIssueOrPRLink, type RepoSlug } from '../../../../../../shared/github/links'
import {
  parseGitLabIssueOrMRLink,
  type ProjectSlug
} from '../../../../../../shared/new-workspace/gitlab-links'
import { isLinkedIssueNumber } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-action-variables'
import type { Worktree } from '../../../../../../shared/worktree/types'

export type IssueReferenceProps = { githubRepo?: RepoSlug; gitlabProject?: ProjectSlug }

type Forge = 'github' | 'gitlab'

function currentIssueProvider(
  workspace: Pick<Worktree, 'linkedIssue' | 'linkedGitLabIssue'>
): Forge | null {
  const github = isLinkedIssueNumber(workspace.linkedIssue)
  const gitlab = isLinkedIssueNumber(workspace.linkedGitLabIssue)
  return github === gitlab ? null : github ? 'github' : 'gitlab'
}

function propsFromUrl(
  provider: string | undefined,
  url: string | undefined,
  current: Forge | null
): IssueReferenceProps | null {
  if (!url || (current && provider !== current)) {
    return null
  }
  if (provider === 'github') {
    const slug = parseGitHubIssueOrPRLink(url)?.slug
    return slug ? { githubRepo: slug } : null
  }
  if (provider === 'gitlab') {
    const slug = parseGitLabIssueOrMRLink(url)?.slug
    return slug ? { gitlabProject: slug } : null
  }
  return null
}

/** Where a bare `#123` in a workspace note resolves. Only a stored URL proves the host
 *  (GHES, self-hosted GitLab); a source that disagrees with the currently linked issue's
 *  forge is stale, so the note renders plain text rather than a wrong link. */
export function resolveWorkspaceIssueReferenceProps(
  workspace:
    | Pick<Worktree, 'linkedIssue' | 'linkedGitLabIssue' | 'linkedWorkItem'>
    | null
    | undefined,
  review: { provider: string; url?: string } | null | undefined
): IssueReferenceProps {
  if (!workspace) {
    return {}
  }
  const current = currentIssueProvider(workspace)
  const item = workspace.linkedWorkItem
  return (
    propsFromUrl(item?.provider, item?.url, current) ??
    propsFromUrl(review?.provider, review?.url, current) ??
    {}
  )
}
