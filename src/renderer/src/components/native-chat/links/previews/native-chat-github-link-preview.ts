import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/work-items/github/github-work-item-source-lookup'
import { useAppStore } from '@/store/index'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { githubRepoIdentityKey } from '../../../../../../shared/github/repositories/repository-identity-key'
import { buildTaskSourceContextFromRepo } from '../../../../../../shared/work-items/task-source-context'
import type { HostAuthorityKey } from '../../../../../../shared/execution-host/host-authority'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'
import type { GitHubPreviewRouteStore } from './native-chat-github-route-store'
import {
  findGitHubPreviewRouteRepo,
  githubPreviewRouteCandidates,
  readGitHubPreviewRouteRepo
} from './native-chat-github-route-repo'
import {
  repoRouteAuthorityKey,
  repoRouteIdentity
} from '@/lib/workspace/ownership/worktree-owner-repo'

const previews = createHoverPreviewCache<GitHubWorkItem>({ freshMs: 60_000, maxEntries: 200 })
const RESTARTED = Symbol('restarted')

/** Repo ids repeat across hosts, and each host answers with its own GitHub account. */
export function githubLinkPreviewKey(repo: Repo, link: GitHubIssueOrPRLink): string {
  return `${repoRouteIdentity(repo)}:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}`
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
  const authority = repoRouteAuthorityKey(repo)
  if (!authority) {
    return Promise.resolve(null)
  }
  const identity = repoRouteIdentity(repo)
  const read = (repos: readonly Repo[]) =>
    repos.find((row) => repoRouteIdentity(row) === identity) ?? null
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
  route: readonly Repo[] | Repo | null = useAppStore.getState().repos
): string {
  const repo =
    route === null
      ? null
      : 'id' in route
        ? route
        : readGitHubPreviewRouteRepo(route, routeAuthority, link)
  return repo
    ? githubLinkPreviewKey(repo, link)
    : `${routeAuthority}:unrouted:${githubRepoIdentityKey(link.slug)}#${link.number}:${link.type}`
}

export function readCachedRoutedGitHubLinkPreview(
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink,
  route?: GitHubPreviewRouteStore
): GitHubWorkItem | null {
  return previews.read(routedGitHubLinkPreviewKey(routeAuthority, link, route?.read()))
}

export async function loadRoutedGitHubLinkPreview(
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink,
  route?: GitHubPreviewRouteStore
): Promise<GitHubWorkItem | null> {
  const snapshot = route?.repos === useAppStore.getState().repos ? route : undefined
  // Keep routing current until a pending request settles, including after its card unmounts.
  const stop = snapshot?.retain()
  try {
    return await loadPreviewFromCatalog(
      routeAuthority,
      link,
      (repos) =>
        snapshot?.repos === repos
          ? snapshot.find()
          : findGitHubPreviewRouteRepo(repos, routeAuthority, link),
      (repos) =>
        snapshot?.repos === repos
          ? snapshot.read()
          : readGitHubPreviewRouteRepo(repos, routeAuthority, link),
      snapshot?.identities
    )
  } finally {
    stop?.()
  }
}

async function loadPreviewFromCatalog(
  routeAuthority: HostAuthorityKey,
  link: GitHubIssueOrPRLink,
  select: (repos: readonly Repo[]) => Promise<Repo | null>,
  read: (repos: readonly Repo[]) => Repo | null,
  capturedIdentities?: ReadonlySet<string>
): Promise<GitHubWorkItem | null> {
  const repos = useAppStore.getState().repos
  const captured =
    capturedIdentities ??
    new Set(githubPreviewRouteCandidates(repos, routeAuthority).map(repoRouteIdentity))
  const retired = new Set<string>()
  // The selected binding, once known; a request under it that was retired and is current again
  // starts over right away instead of waiting on, or failing with, the retired request.
  let selected: string | null = null
  let restart = (): void => {}
  const restarted = new Promise<typeof RESTARTED>((resolve) => {
    restart = () => resolve(RESTARTED)
  })
  const restored = (): boolean => {
    const current = selected && retired.has(selected) && read(useAppStore.getState().repos)
    return !!current && repoRouteIdentity(current) === selected
  }
  const stop = useAppStore.subscribe((state, previous) => {
    if (state.repos === previous.repos) {
      return
    }
    const live = new Set(
      githubPreviewRouteCandidates(state.repos, routeAuthority).map(repoRouteIdentity)
    )
    // Restoring a retired binding cannot revive its old request.
    for (const identity of captured) {
      if (!live.has(identity)) {
        retired.add(identity)
      }
    }
    if (restored()) {
      restart()
    }
  })
  try {
    const repo = await select(repos)
    if (!repo) {
      return null
    }
    const identity = repoRouteIdentity(repo)
    selected = identity
    const accepts = () => {
      const currentRepos = useAppStore.getState().repos
      const currentRepo = read(currentRepos)
      return (
        captured.has(identity) &&
        !retired.has(identity) &&
        currentRepo !== null &&
        repoRouteIdentity(currentRepo) === identity
      )
    }
    if (accepts()) {
      const item = await Promise.race([
        previews.load(
          githubLinkPreviewKey(repo, link),
          () => fetchPreview(repo, link, accepts),
          accepts
        ),
        restarted
      ])
      if (item !== RESTARTED && accepts()) {
        return item
      }
    }
  } catch (error) {
    if (!restored()) {
      throw error
    }
  } finally {
    stop()
  }
  // The card keeps its key across a binding that changed and came back, so nothing else asks again.
  return restored() ? loadPreviewFromCatalog(routeAuthority, link, select, read) : null
}
