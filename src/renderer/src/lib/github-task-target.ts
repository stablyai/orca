import { githubTaskBinding, captureGitHubTaskObservation } from './github-task-observation'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  getTaskSourceCacheScope,
  areTaskSourceContextsEqual,
  buildTaskSourceContextFromRepo
} from '../../../shared/task-source-context'
import { parseGitHubIssueOrPRLink } from '../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { parseHostAuthorityKey } from '../../../shared/host-authority'
import type { AppState } from '@/store/types'
import { getGitHubRepoLookupIndex } from '@/store/slices/github-repo-lookup-index'
import { getGitHubSourceRuntimeTarget } from './github-source-runtime-context'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import { captureHostIdentityFence, isHostIdentityFenceCurrent } from '@/store/host-catalog-fencing'

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
export function githubTaskWriteKey(
  item: Pick<GitHubWorkItem, 'url'>,
  source?: TaskSourceContext | null
): string {
  return `${JSON.stringify(getGitHubSourceRuntimeTarget(source))}\0${githubTaskIdentity(item)}`
}
export function githubTaskExecutionIdentity(repo: Repo | undefined): string {
  const authority = repo && parseHostAuthorityKey(getRepoExecutionHostId(repo))
  if (!authority) {
    return ''
  }
  const fence = captureHostIdentityFence(hostRouteForAuthority(authority))
  return JSON.stringify([fence.runtimeConnectionGeneration, fence.sshTargetConnectionGeneration])
}
export function captureGitHubTaskTarget(
  get: () => Pick<AppState, 'repos' | 'runtimeStatusByEnvironmentId'>,
  item: GitHubWorkItem,
  source: TaskSourceContext,
  taskPageSource: TaskSourceContext | null
) {
  const resolve = () =>
    getGitHubRepoLookupIndex(get().repos).findForWorkItem({
      repoId: item.repoId,
      repoHostId: item.repoHostId ?? source.hostId
    })
  const repo = resolve()
  const ownerRepo = parseGitHubIssueOrPRLink(item.url)?.slug
  if (!repo || !ownerRepo) {
    return null
  }
  const hostId = getRepoExecutionHostId(repo)
  if (hostId !== source.hostId) {
    return null
  }
  const unstamped = getGitHubRepoLookupIndex(get().repos).findForWorkItem({ repoId: item.repoId })
  const authority = parseHostAuthorityKey(hostId)
  if (!authority) {
    return null
  }
  const fence = captureHostIdentityFence(hostRouteForAuthority(authority))
  const binding = (row: typeof repo | undefined) => row && githubTaskBinding(row)
  const legacySource = buildTaskSourceContextFromRepo({
    provider: 'github',
    projectId: repo.id,
    repo
  })
  const ordinarySource = areTaskSourceContextsEqual(source, legacySource) ? taskPageSource : null
  const sources =
    ordinarySource && !areTaskSourceContextsEqual(ordinarySource, source)
      ? [source, ordinarySource]
      : [source]
  const identity = githubTaskIdentity(item)
  const key = `${githubTaskSourceKey(source)}\0${binding(repo)}\0${githubTaskExecutionIdentity(repo)}\0${githubTaskIdentity(item)}`
  return {
    item,
    source,
    sources,
    observations: sources.map((context) => captureGitHubTaskObservation(repo, context)),
    observation: captureGitHubTaskObservation(repo, source),
    repo,
    ownerRepo,
    hostId,
    key,
    current: () => binding(resolve()) === binding(repo) && isHostIdentityFenceCurrent(fence),
    rpcOptions: {
      expectedEnvironmentPairingRevision: fence.pairingRevision,
      expectedEnvironmentRuntimeId:
        fence.route.target.kind === 'environment'
          ? get().runtimeStatusByEnvironmentId.get(fence.route.target.environmentId)?.status
              ?.runtimeId
          : undefined
    },
    matches: (row: GitHubWorkItem) =>
      row.repoId === item.repoId &&
      (row.repoHostId
        ? row.repoHostId === hostId
        : !!unstamped && getRepoExecutionHostId(unstamped) === hostId) &&
      githubTaskIdentity(row) === identity
  }
}

export type GitHubTaskTarget = NonNullable<ReturnType<typeof captureGitHubTaskTarget>>
export type GitHubTaskRefreshHandler = (item: GitHubWorkItem, target: GitHubTaskTarget) => void
