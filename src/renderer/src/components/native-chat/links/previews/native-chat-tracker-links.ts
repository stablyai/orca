import {
  parseGitHubIssueOrPRLink,
  type GitHubIssueOrPRLink
} from '../../../../../../shared/github/links'
import { parseGitLabIssueOrMRLink } from '../../../../../../shared/new-workspace/gitlab-links'
import {
  getMatchingJiraSites,
  parseJiraIssueUrl
} from '../../../../../../shared/jira/jira-issue-url'
import { parseLinearIssueUrl } from '../../../../../../shared/linear/linear-reference-links'
import type { Repo } from '../../../../../../shared/repo-types'
import type { NativeChatLinkPeek } from './native-chat-link-peek-context'
import { resolveGitHubPeekLink } from './NativeChatGitHubLinkPeek'
import type { GitLabChatLink } from './native-chat-tracker-link-previews'

/** An issue, pull request or merge request a chat link points to, on a tracker Orca can read. */
export type NativeChatTrackerLink =
  | { kind: 'linear'; identifier: string }
  | { kind: 'jira'; siteId: string; issueKey: string }
  | { kind: 'github'; repo: Repo; link: GitHubIssueOrPRLink; ownRepo: boolean }
  | { kind: 'gitlab'; repo: Repo; link: GitLabChatLink }

export function resolveNativeChatTrackerLink(
  peek: NativeChatLinkPeek,
  href: string | undefined
): NativeChatTrackerLink | null {
  if (!href) {
    return null
  }
  const linear = peek.linearConnected ? parseLinearIssueUrl(href) : null
  if (linear) {
    return { kind: 'linear', identifier: linear.identifier }
  }
  const jiraUrl = peek.jiraSites.length > 0 ? parseJiraIssueUrl(href) : null
  const jiraSite = jiraUrl ? getMatchingJiraSites(jiraUrl, peek.jiraSites)[0] : undefined
  if (jiraUrl && jiraSite) {
    return { kind: 'jira', siteId: jiraSite.id, issueKey: jiraUrl.issueKey }
  }
  const github = peek.githubRepo ? resolveGitHubPeekLink(peek.githubRepo, href) : null
  if (peek.githubRepo && github && parseGitHubIssueOrPRLink(href)) {
    return { kind: 'github', repo: peek.githubRepo.repo, ...github }
  }
  const gitLab = peek.gitLabLookupRepo ? parseGitLabIssueOrMRLink(href) : null
  if (peek.gitLabLookupRepo && gitLab) {
    return { kind: 'gitlab', repo: peek.gitLabLookupRepo, link: gitLab }
  }
  return null
}

/** The ID a reply would write for this link: `ENG-12`, `repo#12`, `group/project!12`. */
export function trackerLinkLabel(link: NativeChatTrackerLink): string {
  switch (link.kind) {
    case 'linear':
      return link.identifier
    case 'jira':
      return link.issueKey
    case 'github':
      return `${link.link.slug.repo}#${link.link.number}`
    case 'gitlab':
      return `${link.link.slug.path.split('/').at(-1) ?? link.link.slug.path}${link.link.type === 'mr' ? '!' : '#'}${link.link.number}`
  }
}
