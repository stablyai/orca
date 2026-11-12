import {
  parseGitHubIssueOrPRLink,
  type GitHubIssueOrPRLink
} from '../../../../../../shared/github/repositories/links'
import { parseGitLabIssueOrMRLink } from '../../../../../../shared/new-workspace/gitlab-links'
import {
  getMatchingJiraSites,
  parseJiraIssueUrl
} from '../../../../../../shared/jira/jira-issue-url'
import { parseLinearIssueUrl } from '../../../../../../shared/linear/linear-reference-links'
import { foldComparableGitLabHost } from '../../../../../../shared/git/remotes/git-remote-host-alias'
import { splitGitRemoteKey } from '../../../../../../shared/git/remotes/git-remote-identity'
import type { Repo } from '../../../../../../shared/repo-types'
import type { NativeChatLinkPeek } from './native-chat-link-peek-context'
import { resolveGitHubPeekLink } from './NativeChatGitHubLinkPeek'
import type { GitLabChatLink, JiraChatLink } from './native-chat-tracker-link-previews'
import type { LinearChatLink } from './native-chat-linear-link-preview'

/** An issue, pull request or merge request a chat link points to, on a tracker Orca can read. */
export type NativeChatTrackerLink =
  | ({ kind: 'linear' } & LinearChatLink)
  | ({ kind: 'jira' } & JiraChatLink)
  | { kind: 'github'; repo: Repo; link: GitHubIssueOrPRLink; ownRepo: boolean }
  | { kind: 'gitlab'; repo: Repo; link: GitLabChatLink }

const GITLAB_COM = 'gitlab.com'

/** Hosts a GitLab link may be looked up on: gitlab.com, plus hosts registered repos already use.
 *  A lookup sends a GitLab sign-in to the link's host, so a host nobody chose never gets one. */
export function trustedGitLabHosts(repos: readonly Repo[]): ReadonlySet<string> {
  const hosts = new Set([GITLAB_COM])
  for (const repo of repos) {
    const host = splitGitRemoteKey(
      repo.gitRemoteIdentity?.canonicalKey,
      foldComparableGitLabHost
    )?.host
    if (host && host !== 'github.com') {
      hosts.add(host)
    }
  }
  return hosts
}

/** Remote identities drop ports, so a link host with a port can't be matched and is refused. */
export function isTrustedGitLabHost(host: string, trusted: ReadonlySet<string>): boolean {
  const hasPort = /:\d+$/.test(host)
  return !hasPort && trusted.has(foldComparableGitLabHost(host.toLowerCase()))
}

/** The tracker item a chat link points to, or null when Orca can't read it through a connection. */
export function resolveNativeChatTrackerLink(
  peek: NativeChatLinkPeek,
  href: string | undefined
): NativeChatTrackerLink | null {
  if (!href) {
    return null
  }
  const linear = peek.linearConnected ? parseLinearIssueUrl(href) : null
  if (linear) {
    return { kind: 'linear', orgUrlKey: linear.orgUrlKey, identifier: linear.identifier }
  }
  const jiraUrl = peek.jiraSites.length > 0 ? parseJiraIssueUrl(href) : null
  const jiraSite = jiraUrl ? getMatchingJiraSites(jiraUrl, peek.jiraSites)[0] : undefined
  if (jiraUrl && jiraSite) {
    return {
      kind: 'jira',
      hostId: peek.trackerHostId,
      siteId: jiraSite.id,
      issueKey: jiraUrl.issueKey
    }
  }
  const github = peek.githubRepo ? resolveGitHubPeekLink(peek.githubRepo, href) : null
  if (peek.githubRepo && github && parseGitHubIssueOrPRLink(href)) {
    return { kind: 'github', repo: peek.githubRepo.repo, ...github }
  }
  const gitLab = peek.gitLabLookupRepo ? parseGitLabIssueOrMRLink(href) : null
  const gitLabHostTrusted = gitLab ? isTrustedGitLabHost(gitLab.slug.host, peek.gitLabHosts) : false
  if (peek.gitLabLookupRepo && gitLab && gitLabHostTrusted) {
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
