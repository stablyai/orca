import { foldComparableGitHubHost } from '../../../shared/git-remote-host-alias'
import {
  matchGitRemoteKeyParts,
  splitGitRemoteKey,
  type GitRemoteKeyParts
} from '../../../shared/git-remote-identity'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import {
  parseGitHubIssueOrPRLink,
  type GitHubIssueOrPRLink,
  type RepoSlug
} from '../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { parseGitLabIssueOrMRLink } from '../../../shared/new-workspace/gitlab-links'
import { parseJiraIssueUrl, type ParsedJiraIssueUrl } from '../../../shared/jira-issue-url'
import { parseLinearIssueUrlIntent, type LinearIssueUrlIntent } from '../../../shared/linear/links'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { normalizeLinearIdentifier } from './linear-issue-workspace-attachment'
import {
  worktreeMatchesGitLabUrl,
  type GitLabIssueOrMRLink
} from './worktree-palette-gitlab-url-match'
import { isWorktreePaletteQueryTooLarge } from './worktree-palette-query-bounds'
import { buildWorktreePaletteTaskUrlResult } from './worktree-palette-task-url-result'
import type { PaletteSearchResult } from './worktree-palette-search'

export type CmdJTaskSourceUrl =
  | { provider: 'github'; link: GitHubIssueOrPRLink }
  | { provider: 'linear'; intent: LinearIssueUrlIntent }
  | { provider: 'gitlab'; link: GitLabIssueOrMRLink }
  | { provider: 'jira'; parsed: ParsedJiraIssueUrl }

export type CmdJTaskUrlCreatePreview = {
  provider: 'github' | 'gitlab' | 'jira'
  identifier: string
  subtitle: string
  createLabel: string
  kindLabel: string
  loading?: boolean
}

export function withResolvedCmdJGitHubPreview(
  preview: CmdJTaskUrlCreatePreview,
  resolvedTitle: string | null,
  loading: boolean
): CmdJTaskUrlCreatePreview {
  if (preview.provider !== 'github') {
    return preview
  }
  if (resolvedTitle) {
    return {
      ...preview,
      subtitle: resolvedTitle,
      createLabel: `${preview.createLabel}: ${resolvedTitle}`,
      loading: false
    }
  }
  return loading ? { ...preview, loading: true } : preview
}

function githubIdentityKey(slug: RepoSlug): string {
  return githubRepoIdentityKey({
    owner: slug.owner,
    repo: slug.repo,
    host: slug.host?.replace(/^www\./i, '')
  })
}

function githubLinksEqual(left: GitHubIssueOrPRLink, right: GitHubIssueOrPRLink): boolean {
  return (
    left.type === right.type &&
    left.number === right.number &&
    githubIdentityKey(left.slug) === githubIdentityKey(right.slug)
  )
}

function parseOwnerRepoDisplayName(value: string | null | undefined): RepoSlug | null {
  const match = /^([^/]+)\/([^/]+)$/.exec(value?.trim() ?? '')
  if (!match) {
    return null
  }
  return { owner: match[1], repo: match[2] }
}

/** Host + `owner/repo` tail, matching how `GitRemoteIdentity.canonicalKey` is built. */
function githubRemoteKeyParts(slug: RepoSlug): GitRemoteKeyParts {
  return {
    host: foldComparableGitHubHost((slug.host || 'github.com').replace(/:\d+$/, '')),
    tail: `${slug.owner.toLowerCase()}/${slug.repo.replace(/\.git$/i, '').toLowerCase()}`
  }
}

function remoteIdentityMatchesGitHubSlug(repo: Repo, slug: RepoSlug): boolean | 'unknown' {
  const identity = repo.gitRemoteIdentity
  const identityParts = splitGitRemoteKey(identity?.canonicalKey, foldComparableGitHubHost)
  if (!identityParts) {
    return 'unknown'
  }
  const verdict = matchGitRemoteKeyParts(identityParts, githubRemoteKeyParts(slug))
  if (verdict !== false) {
    return verdict
  }
  // Why not false: identity keeps only one remote, so an `upstream` pick means a fork's `origin`
  // existed and is invisible here, and rejecting would drop URLs from the fork itself. GitLab makes
  // the opposite trade (STA-4450); aligning the two is left to a twin ticket.
  return identity?.remoteName === 'upstream' ? 'unknown' : false
}

/** Tri-state: `'unknown'` stays permissive for forks and host aliases. */
function repoMatchesGitHubSlug(repo: Repo | undefined, slug: RepoSlug): boolean | 'unknown' {
  if (!repo) {
    return 'unknown'
  }
  // Why displayName first: it is compared host-agnostically, so mirrors and host aliases of the
  // same owner/repo keep matching; the probed remote only fills in where no name evidence exists.
  const fromName = parseOwnerRepoDisplayName(repo.displayName)
  if (fromName) {
    return githubIdentityKey({ ...fromName, host: slug.host }) === githubIdentityKey(slug)
  }
  if (repo.upstream?.owner && repo.upstream.repo) {
    return githubIdentityKey(repo.upstream) === githubIdentityKey(slug)
  }
  // Why: a basename-only displayName is the common non-fork case, and issue/PR numbers are
  // per-repo, so a bare number must still clear the remote the repo actually points at.
  return remoteIdentityMatchesGitHubSlug(repo, slug)
}

export function parseCmdJTaskSourceUrl(query: string): CmdJTaskSourceUrl | null {
  const trimmed = query.trim()
  if (!trimmed || isWorktreePaletteQueryTooLarge(trimmed)) {
    return null
  }

  const linear = parseLinearIssueUrlIntent(trimmed)
  if (linear) {
    return { provider: 'linear', intent: linear }
  }

  const github = parseGitHubIssueOrPRLink(trimmed)
  if (github) {
    return { provider: 'github', link: github }
  }

  const gitlab = parseGitLabIssueOrMRLink(trimmed)
  if (gitlab) {
    return { provider: 'gitlab', link: gitlab }
  }

  const jira = parseJiraIssueUrl(trimmed)
  if (jira) {
    return { provider: 'jira', parsed: jira }
  }

  return null
}

export function getCmdJTaskUrlCreatePreview(
  intent: CmdJTaskSourceUrl
): CmdJTaskUrlCreatePreview | null {
  if (intent.provider === 'linear') {
    return null
  }
  if (intent.provider === 'github') {
    const { slug, number, type } = intent.link
    const repo = `${slug.owner}/${slug.repo}`
    const kindLabel = type === 'pr' ? 'GitHub pull request' : 'GitHub issue'
    return {
      provider: 'github',
      identifier: `#${number}`,
      subtitle: repo,
      kindLabel,
      createLabel: `Create worktree from ${kindLabel} ${repo}#${number}`
    }
  }
  if (intent.provider === 'gitlab') {
    const { slug, number, type } = intent.link
    const project = `${slug.host}/${slug.path}`
    const kindLabel = type === 'mr' ? 'GitLab merge request' : 'GitLab issue'
    const identifier = type === 'mr' ? `!${number}` : `#${number}`
    return {
      provider: 'gitlab',
      identifier,
      subtitle: project,
      kindLabel,
      createLabel: `Create worktree from ${kindLabel} ${project}${identifier}`
    }
  }
  return {
    provider: 'jira',
    identifier: intent.parsed.issueKey,
    subtitle: intent.parsed.origin.replace(/^https?:\/\//, ''),
    kindLabel: 'Jira issue',
    createLabel: `Create worktree from Jira issue ${intent.parsed.issueKey}`
  }
}

function worktreeMatchesGitHubUrl(
  worktree: Worktree,
  link: GitHubIssueOrPRLink,
  repo: Repo | undefined,
  review: HostedReviewInfo | null | undefined
): boolean {
  const linkedUrl = worktree.linkedWorkItem?.url
    ? parseGitHubIssueOrPRLink(worktree.linkedWorkItem.url)
    : null
  if (linkedUrl && githubLinksEqual(linkedUrl, link)) {
    return true
  }

  const reviewUrl = review?.url ? parseGitHubIssueOrPRLink(review.url) : null
  if (reviewUrl && githubLinksEqual(reviewUrl, link)) {
    return true
  }

  const linkedItem = worktree.linkedWorkItem
  const linkedItemMatches =
    linkedItem?.provider === 'github' &&
    linkedItem.type === link.type &&
    linkedItem.number === link.number
  const numberMatches =
    linkedItemMatches ||
    (link.type === 'pr' ? worktree.linkedPR === link.number : worktree.linkedIssue === link.number)
  if (!numberMatches) {
    return false
  }

  return repoMatchesGitHubSlug(repo, link.slug) !== false
}

function worktreeMatchesLinearUrl(worktree: Worktree, intent: LinearIssueUrlIntent): boolean {
  const identifier = normalizeLinearIdentifier(intent.identifier)
  const linkedIdentifier =
    normalizeLinearIdentifier(worktree.linkedLinearIssue) ??
    normalizeLinearIdentifier(worktree.linkedWorkItem?.linearIdentifier)
  if (!identifier || linkedIdentifier !== identifier) {
    const linkedUrl = worktree.linkedWorkItem?.url
      ? parseLinearIssueUrlIntent(worktree.linkedWorkItem.url)
      : null
    if (
      !linkedUrl ||
      linkedUrl.identifier !== intent.identifier ||
      linkedUrl.organizationUrlKey.toLowerCase() !== intent.organizationUrlKey.toLowerCase()
    ) {
      return false
    }
  }

  const worktreeOrg = worktree.linkedLinearIssueOrganizationUrlKey?.trim().toLowerCase()
  if (worktreeOrg && worktreeOrg !== intent.organizationUrlKey.toLowerCase()) {
    return false
  }
  return true
}

function worktreeMatchesJiraUrl(worktree: Worktree, parsed: ParsedJiraIssueUrl): boolean {
  const linkedUrl = worktree.linkedWorkItem?.url
    ? parseJiraIssueUrl(worktree.linkedWorkItem.url)
    : null
  // Why url first: issue keys are per-project, not per-tenant, so two Jira sites
  // routinely both have a PROJ-123. The stored URL is the only tenant evidence
  // here, so where it exists it decides — matching on the bare identifier would
  // jump to another tenant's worktree.
  if (linkedUrl) {
    return (
      linkedUrl.issueKey === parsed.issueKey &&
      linkedUrl.origin === parsed.origin &&
      linkedUrl.sitePath === parsed.sitePath
    )
  }
  return worktree.linkedWorkItem?.jiraIdentifier?.toUpperCase() === parsed.issueKey
}

export function matchWorktreePaletteTaskUrl(args: {
  worktree: Worktree
  intent: CmdJTaskSourceUrl
  repo?: Repo
  review?: HostedReviewInfo | null
}): PaletteSearchResult | null {
  const { worktree, intent, repo, review } = args
  if (intent.provider === 'github') {
    if (!worktreeMatchesGitHubUrl(worktree, intent.link, repo, review)) {
      return null
    }
    return buildWorktreePaletteTaskUrlResult({
      worktreeId: worktree.id,
      ...(worktree.hostId ? { worktreeHostId: worktree.hostId } : {}),
      labelKind: intent.link.type === 'pr' ? 'pr' : 'issue',
      text: `${intent.link.type === 'pr' ? 'PR' : 'Issue'} #${intent.link.number}`
    })
  }
  if (intent.provider === 'linear') {
    if (!worktreeMatchesLinearUrl(worktree, intent.intent)) {
      return null
    }
    return buildWorktreePaletteTaskUrlResult({
      worktreeId: worktree.id,
      ...(worktree.hostId ? { worktreeHostId: worktree.hostId } : {}),
      labelKind: 'issue',
      text: intent.intent.identifier
    })
  }
  if (intent.provider === 'gitlab') {
    if (!worktreeMatchesGitLabUrl(worktree, intent.link, repo, review)) {
      return null
    }
    return buildWorktreePaletteTaskUrlResult({
      worktreeId: worktree.id,
      ...(worktree.hostId ? { worktreeHostId: worktree.hostId } : {}),
      labelKind: intent.link.type === 'mr' ? 'mr' : 'issue',
      text: `${intent.link.type === 'mr' ? 'MR' : 'Issue'} #${intent.link.number}`
    })
  }
  if (!worktreeMatchesJiraUrl(worktree, intent.parsed)) {
    return null
  }
  return buildWorktreePaletteTaskUrlResult({
    worktreeId: worktree.id,
    ...(worktree.hostId ? { worktreeHostId: worktree.hostId } : {}),
    labelKind: 'issue',
    text: intent.parsed.issueKey
  })
}
