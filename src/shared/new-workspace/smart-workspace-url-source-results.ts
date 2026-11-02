import { parseGitHubIssueOrPRLink, type GitHubIssueOrPRLink } from '../github/links'
import { githubRepoIdentityKey } from '../github/repository-identity-key'
import type { GitHubWorkItem } from '../github/work-item-types'
import type { GitLabWorkItem } from '../gitlab-types'
import type { LinearIssue } from '../linear/issue-types'
import { parseGitLabIssueOrMRLink } from './gitlab-links'
import {
  isSmartWorkspaceLinearIssueIntentMatch,
  parseBoundedSmartWorkspaceLinearIssueUrlIntent
} from './smart-workspace-linear-intent'

export type SmartWorkspaceGitLabUrlIntent = NonNullable<ReturnType<typeof parseGitLabIssueOrMRLink>>

type SmartWorkspaceUrlSourceMode =
  | 'smart'
  | 'github'
  | 'gitlab'
  | 'branches'
  | 'linear'
  | 'jira'
  | 'text'

export type SmartWorkspaceUrlSourceRow =
  | { kind: 'use-name'; value: 'use-name'; name: string }
  | { kind: 'github'; value: string; item: GitHubWorkItem }
  | { kind: 'gitlab'; value: string; item: GitLabWorkItem }
  | { kind: 'linear'; value: string; issue: LinearIssue }

function toGitHubSourceRow(item: GitHubWorkItem): SmartWorkspaceUrlSourceRow {
  return { kind: 'github', value: `github-${item.repoId}-${item.type}-${item.number}`, item }
}

function withSmartNameFallback(
  mode: SmartWorkspaceUrlSourceMode,
  name: string,
  rows: SmartWorkspaceUrlSourceRow[]
): SmartWorkspaceUrlSourceRow[] {
  return name && mode === 'smart' ? [{ kind: 'use-name', value: 'use-name', name }, ...rows] : rows
}

function isGitHubLinkIntentMatch(intent: GitHubIssueOrPRLink, item: GitHubWorkItem): boolean {
  const itemLink = parseGitHubIssueOrPRLink(item.url)
  return (
    itemLink !== null &&
    itemLink.type === intent.type &&
    itemLink.number === intent.number &&
    githubRepoIdentityKey(itemLink.slug) === githubRepoIdentityKey(intent.slug)
  )
}

function isGitLabLinkIntentMatch(
  intent: SmartWorkspaceGitLabUrlIntent,
  item: GitLabWorkItem
): boolean {
  const itemLink = parseGitLabIssueOrMRLink(item.url)
  return (
    itemLink !== null &&
    itemLink.type === intent.type &&
    itemLink.number === intent.number &&
    itemLink.slug.host.toLowerCase() === intent.slug.host.toLowerCase() &&
    itemLink.slug.path.toLowerCase() === intent.slug.path.toLowerCase()
  )
}

export function buildSmartWorkspaceUrlSourceRows({
  githubItems,
  githubUrlIntent,
  gitlabAvailable,
  gitlabItems,
  gitlabUrlIntent,
  linearAvailable,
  linearIssues,
  linearUrlIntentOwnsResults,
  mode,
  resultLimit,
  value
}: {
  githubItems: GitHubWorkItem[]
  githubUrlIntent?: GitHubIssueOrPRLink | null
  gitlabAvailable: boolean
  gitlabItems: GitLabWorkItem[]
  gitlabUrlIntent?: SmartWorkspaceGitLabUrlIntent | null
  linearAvailable: boolean
  linearIssues: LinearIssue[]
  linearUrlIntentOwnsResults: boolean
  mode: SmartWorkspaceUrlSourceMode
  resultLimit: number
  value: string
}): SmartWorkspaceUrlSourceRow[] | null {
  const trimmed = value.trim()
  if (githubUrlIntent && (mode === 'smart' || mode === 'github')) {
    const rows = githubItems
      .filter((item) => isGitHubLinkIntentMatch(githubUrlIntent, item))
      .map(toGitHubSourceRow)
      .slice(0, resultLimit)
    return withSmartNameFallback(mode, trimmed, rows)
  }
  if (gitlabUrlIntent && (mode === 'smart' || mode === 'gitlab')) {
    const rows = gitlabAvailable
      ? gitlabItems
          .filter((item) => isGitLabLinkIntentMatch(gitlabUrlIntent, item))
          .map((item) => ({
            kind: 'gitlab' as const,
            value: `gitlab-${item.repoId}-${item.type}-${item.number}`,
            item
          }))
          .slice(0, resultLimit)
      : []
    return withSmartNameFallback(mode, trimmed, rows)
  }
  const linearUrlIntent = parseBoundedSmartWorkspaceLinearIssueUrlIntent(trimmed)
  if (linearUrlIntentOwnsResults && linearUrlIntent && (mode === 'smart' || mode === 'linear')) {
    const rows = linearAvailable
      ? linearIssues
          .filter((issue) => isSmartWorkspaceLinearIssueIntentMatch(linearUrlIntent, issue))
          .map((issue) => ({
            kind: 'linear' as const,
            value: `linear-${issue.id}`,
            issue
          }))
          .slice(0, resultLimit)
      : []
    return withSmartNameFallback(mode, trimmed, rows)
  }
  return null
}
