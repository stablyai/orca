import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/work-items/github/github-work-item-source-lookup'
import { useAppStore } from '@/store/index'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { githubRepoIdentityKey } from '../../../../../../shared/github/repositories/repository-identity-key'
import { buildTaskSourceContextFromRepo } from '../../../../../../shared/work-items/task-source-context'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'
import {
  findGitHubPreviewRouteRepo,
  githubPreviewRouteCandidates
} from './native-chat-github-route-repo'

const previews = createHoverPreviewCache<GitHubWorkItem>({ freshMs: 60_000, maxEntries: 200 })

/** Repo ids repeat across hosts, and each host answers with its own GitHub account. */
export function githubLinkPreviewKey(repo: Repo, link: GitHubIssueOrPRLink): string {
  return `${getRepoExecutionHostId(repo)}:${repo.id}:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}`
}

async function lookup(
  repo: Repo,
  link: GitHubIssueOrPRLink,
  type: 'issue' | 'pr'
): Promise<GitHubWorkItem | null> {
  return lookupGitHubWorkItemByOwnerRepoForSource({
    repoPath: repo.path,
    repoId: repo.id,
    sourceContext: buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: repo.id,
      repo
    }),
    owner: link.slug.owner,
    repo: link.slug.repo,
    host: link.slug.host,
    number: link.number,
    type,
    preview: true
  })
}

async function fetchPreview(repo: Repo, link: GitHubIssueOrPRLink): Promise<GitHubWorkItem | null> {
  const item = await lookup(repo, link, link.type)
  // Hosts without the preview lookup answer null for a PR asked for as an issue (bare #N links).
  return item || link.type !== 'issue' ? item : lookup(repo, link, 'pr')
}

/** Lets a reopened card paint its last answer without a loading frame. */
export function readCachedGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): GitHubWorkItem | null {
  return previews.read(githubLinkPreviewKey(repo, link))
}

export function loadGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): Promise<GitHubWorkItem | null> {
  return previews.load(githubLinkPreviewKey(repo, link), () => fetchPreview(repo, link))
}

/** Asks again even while the last answer is fresh: the pull request may have just changed. */
export function reloadGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): Promise<GitHubWorkItem | null> {
  previews.expire(githubLinkPreviewKey(repo, link))
  return loadGitHubLinkPreview(repo, link)
}

/** Candidate changes must rerun route selection before reusing an answer from another repo/account. */
export function routedGitHubLinkPreviewKey(
  hostId: string,
  link: GitHubIssueOrPRLink,
  repos: readonly Repo[] = useAppStore.getState().repos
): string {
  const routes = githubPreviewRouteCandidates(repos, hostId).map((repo) => [
    repo.id,
    repo.path,
    repo.connectionId ?? null,
    repo.ghAccount?.host ?? null,
    repo.ghAccount?.user ?? null,
    repo.upstream ?? null,
    repo.gitRemoteIdentity ?? null
  ])
  return `${hostId}:routed:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}:${JSON.stringify(routes)}`
}

export function readCachedRoutedGitHubLinkPreview(
  hostId: string,
  link: GitHubIssueOrPRLink
): GitHubWorkItem | null {
  return previews.read(routedGitHubLinkPreviewKey(hostId, link))
}

export function loadRoutedGitHubLinkPreview(
  hostId: string,
  link: GitHubIssueOrPRLink
): Promise<GitHubWorkItem | null> {
  return previews.load(routedGitHubLinkPreviewKey(hostId, link), async () => {
    const repo = await findGitHubPreviewRouteRepo(useAppStore.getState().repos, hostId, link)
    return repo ? fetchPreview(repo, link) : null
  })
}
