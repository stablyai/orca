import { githubTaskBinding } from './github-task-observation'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { parseGitHubIssueOrPRLink } from '../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { parseHostAuthorityKey } from '../../../shared/host-authority'
import type { AppState } from '@/store/types'
import { getWorkItemRepo } from './work-item-repo-row'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import { captureHostIdentityFence, type HostIdentityFence } from '@/store/host-catalog-fencing'

export function githubTaskIdentity(item: Pick<GitHubWorkItem, 'url'>): string {
  const link = parseGitHubIssueOrPRLink(item.url)
  return link ? `${githubRepoIdentityKey(link.slug)}\0${link.type}:${link.number}` : item.url
}
export function githubTaskContent(
  item: Pick<
    GitHubWorkItem,
    'title' | 'state' | 'labels' | 'assignees' | 'author' | 'authorAvatarUrl' | 'updatedAt'
  >
): Partial<GitHubWorkItem> {
  const { title, state, labels, assignees, author, authorAvatarUrl, updatedAt } = item
  return {
    title,
    state,
    labels,
    ...(assignees === undefined ? {} : { assignees }),
    author,
    authorAvatarUrl,
    updatedAt
  }
}
export function addressedGitHubIssueItem(
  item: GitHubWorkItem,
  loaded: GitHubWorkItemDetails['item'] | undefined
): GitHubWorkItem {
  const address = parseGitHubIssueOrPRLink(item.url)
  const returned = loaded && parseGitHubIssueOrPRLink(loaded.url)
  return item.type === 'issue' &&
    loaded?.type === 'issue' &&
    address?.type === 'issue' &&
    returned?.type === 'issue' &&
    address.number === item.number &&
    returned.number === loaded.number &&
    loaded.number === item.number &&
    githubRepoIdentityKey(address.slug) === githubRepoIdentityKey(returned.slug)
    ? { ...item, ...githubTaskContent(loaded) }
    : item
}
export function githubTaskSourceKey(source?: TaskSourceContext | null): string {
  return source?.provider === 'github' ? getTaskSourceCacheScope(source) : ''
}
export function githubTaskExecutionIdentity(repo: Repo | undefined): string {
  const authority = repo && parseHostAuthorityKey(getRepoExecutionHostId(repo))
  if (!authority) {
    return ''
  }
  const fence = captureHostIdentityFence(hostRouteForAuthority(authority))
  return JSON.stringify([fence.runtimeConnectionGeneration, fence.sshTargetConnectionGeneration])
}
/** The issue a dialog edits or refreshes, keyed by its account/source binding, never one connection. */
export function captureGitHubTaskTarget(
  get: () => Pick<AppState, 'repos'>,
  item: GitHubWorkItem,
  source: TaskSourceContext
) {
  const repo = getWorkItemRepo(get().repos, {
    repoId: item.repoId,
    repoHostId: item.repoHostId ?? source.hostId
  })
  const ownerRepo = parseGitHubIssueOrPRLink(item.url)?.slug
  if (!repo || !ownerRepo || getRepoExecutionHostId(repo) !== source.hostId) {
    return null
  }
  return {
    item,
    source,
    repo,
    ownerRepo,
    key: `${githubTaskSourceKey(source)}\0${githubTaskBinding(repo)}\0${githubTaskIdentity(item)}`
  }
}
/** Pins a request to the machine and runtime its binding was captured on. */
export function githubTaskRpcOptions(
  get: () => Pick<AppState, 'runtimeStatusByEnvironmentId'>,
  { route, pairingRevision }: HostIdentityFence
) {
  return {
    expectedEnvironmentPairingRevision: pairingRevision,
    expectedEnvironmentRuntimeId:
      route.target.kind === 'environment'
        ? get().runtimeStatusByEnvironmentId.get(route.target.environmentId)?.status?.runtimeId
        : undefined
  }
}

export type GitHubTaskTarget = NonNullable<ReturnType<typeof captureGitHubTaskTarget>>
