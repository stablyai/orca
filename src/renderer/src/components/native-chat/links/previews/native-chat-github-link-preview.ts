import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/work-items/github/github-work-item-source-lookup'
import { useAppStore } from '@/store/index'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { githubRepoIdentityKey } from '../../../../../../shared/github/repositories/repository-identity-key'
import { buildTaskSourceContextFromRepo } from '../../../../../../shared/work-items/task-source-context'
import type { HostAuthorityKey } from '../../../../../../shared/host-authority'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'
import {
  findGitHubPreviewRouteRepo,
  githubPreviewRepoAuthorityKey,
  githubPreviewRepoIdentity,
  githubPreviewRouteCandidates,
  readGitHubPreviewRouteRepo
} from './native-chat-github-route-repo'

const previews = createHoverPreviewCache<GitHubWorkItem>({ freshMs: 60_000, maxEntries: 200 })

/** Repo ids repeat across hosts, and each host answers with its own GitHub account. */
export function githubLinkPreviewKey(repo: Repo, link: GitHubIssueOrPRLink): string {
  return `${githubPreviewRepoIdentity(repo)}:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}`
}

async function lookup(
  repo: Repo,
  link: GitHubIssueOrPRLink,
  type: 'issue' | 'pr',
  accepts?: () => boolean
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
    preview: true,
    accepts
  })
}

async function fetchPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink,
  accepts?: () => boolean
): Promise<GitHubWorkItem | null> {
  const item = await lookup(repo, link, link.type, accepts)
  // Hosts without the preview lookup answer null for a PR asked for as an issue (bare #N links).
  return item || link.type !== 'issue' ? item : lookup(repo, link, 'pr', accepts)
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
  const authority = githubPreviewRepoAuthorityKey(repo)
  if (!authority) {
    return Promise.resolve(null)
  }
  const identity = githubPreviewRepoIdentity(repo)
  const read = (repos: readonly Repo[]) =>
    repos.find((row) => githubPreviewRepoIdentity(row) === identity) ?? null
  return loadPreviewFromCatalog(authority, link, async (repos) => read(repos), read)
}

/** Asks again even while the last answer is fresh: the pull request may have just changed. */
export function reloadGitHubLinkPreview(
  repo: Repo,
  link: GitHubIssueOrPRLink
): Promise<GitHubWorkItem | null> {
  previews.expire(githubLinkPreviewKey(repo, link))
  return loadGitHubLinkPreview(repo, link)
}

/** The same selected route identity names synchronous reads, requests and cache commits. */
export function routedGitHubLinkPreviewKey(
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink,
  repos: readonly Repo[] = useAppStore.getState().repos
): string {
  const repo = readGitHubPreviewRouteRepo(repos, routeAuthority, link)
  return repo
    ? githubLinkPreviewKey(repo, link)
    : `${routeAuthority}:unrouted:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}`
}

export function readCachedRoutedGitHubLinkPreview(
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink
): GitHubWorkItem | null {
  return previews.read(routedGitHubLinkPreviewKey(routeAuthority, link))
}

export function loadRoutedGitHubLinkPreview(
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink
): Promise<GitHubWorkItem | null> {
  return loadPreviewFromCatalog(
    routeAuthority,
    link,
    (repos) => findGitHubPreviewRouteRepo(repos, routeAuthority, link),
    (repos) => readGitHubPreviewRouteRepo(repos, routeAuthority, link)
  )
}

async function loadPreviewFromCatalog(
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink,
  select: (repos: readonly Repo[]) => Promise<Repo | null>,
  read: (repos: readonly Repo[]) => Repo | null
): Promise<GitHubWorkItem | null> {
  const repos = useAppStore.getState().repos
  const captured = new Set(
    githubPreviewRouteCandidates(repos, routeAuthority).map(githubPreviewRepoIdentity)
  )
  const retired = new Set<string>()
  const stop = useAppStore.subscribe((state, previous) => {
    if (state.repos === previous.repos) {
      return
    }
    const live = new Set(
      githubPreviewRouteCandidates(state.repos, routeAuthority).map(githubPreviewRepoIdentity)
    )
    // Restoring a retired binding cannot revive its old request.
    for (const identity of captured) {
      if (!live.has(identity)) {
        retired.add(identity)
      }
    }
  })
  try {
    const repo = await select(repos)
    if (!repo) {
      return null
    }
    const identity = githubPreviewRepoIdentity(repo)
    const accepts = () => {
      const currentRepos = useAppStore.getState().repos
      const currentRepo = read(currentRepos)
      return (
        captured.has(identity) &&
        !retired.has(identity) &&
        currentRepo !== null &&
        githubPreviewRepoIdentity(currentRepo) === identity
      )
    }
    if (!accepts()) {
      return null
    }
    const item = await previews.load(
      githubLinkPreviewKey(repo, link),
      () => fetchPreview(repo, link, accepts),
      accepts
    )
    return accepts() ? item : null
  } finally {
    stop()
  }
}
