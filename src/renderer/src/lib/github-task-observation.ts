import { normalizeGhAccountBinding } from '../../../shared/github/account-binding'

import { getTaskPageRepoSourceContext } from './task-repo-source-context'

import { getGitHubRepoLookupIndex } from '@/store/slices/github-repo-lookup-index'

import type { Repo } from '../../../shared/repo-types'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import type { TaskSourceContext } from '../../../shared/task-source-context'

import {
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope,
  areTaskSourceContextsEqual
} from '../../../shared/task-source-context'

import { getRepoExecutionHostId } from '../../../shared/execution-host'

import { parseHostAuthorityKey } from '../../../shared/host-authority'

import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

import { hostRouteForAuthority } from '@/runtime/runtime-client-target'

import { captureHostIdentityFence, isHostIdentityFenceCurrent } from '@/store/host-catalog-fencing'

export function githubTaskBinding(repo: Repo): string {
  return JSON.stringify([
    repo.id,
    repo.path,
    repo.connectionId,
    repo.executionHostId,
    repo.ghAccount?.host.trim().toLowerCase(),
    repo.ghAccount?.user.trim().toLowerCase(),
    repo.projectHostSetupMethod
  ])
}

export function captureGitHubTaskObservation(
  repo: Repo,
  source: TaskSourceContext | null | undefined,
  target?: RuntimeClientTarget
) {
  const account = normalizeGhAccountBinding(repo.ghAccount)
  const hostId = getRepoExecutionHostId(repo)
  const authority = parseHostAuthorityKey(hostId)
  if (!authority) {
    return undefined
  }
  const route = hostRouteForAuthority(authority)
  const dispatch =
    target?.kind === 'environment'
      ? { kind: 'environment' as const, environmentId: target.environmentId }
      : target
  const fence = captureHostIdentityFence(dispatch ? { ...route, target: dispatch } : route)
  // SAFETY: registered repo IDs produce a context; preserve the existing failure for an invalid ID.
  const context =
    source ?? buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
  const binding = githubTaskBinding(repo)
  const legacy = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })
  const ordinary = getTaskPageRepoSourceContext(repo, 'github')
  const sources = areTaskSourceContextsEqual(context, legacy)
    ? [context, ordinary]
    : areTaskSourceContextsEqual(context, ordinary)
      ? [context, legacy]
      : [context]
  const keyFor = (scope: string) =>
    JSON.stringify([
      binding,
      scope,
      fence.route,
      fence.runtimeConnectionGeneration,
      fence.sshTargetConnectionGeneration
    ])
  const associations = sources.flatMap((source) =>
    source
      ? [
          {
            source,
            scope: getTaskSourceCacheScope(source),
            key: keyFor(getTaskSourceCacheScope(source))
          }
        ]
      : []
  )
  return {
    repoId: repo.id,
    path: repo.path,
    hostId,
    source: context,
    binding,
    account: repo.ghAccount
      ? account
        ? { host: account.host, user: account.user.toLowerCase() }
        : undefined
      : null,
    fence,
    key: keyFor(getTaskSourceCacheScope(context)),
    associations,
    aliases: [...new Set(associations.map((association) => association.key))]
  }
}

export type GitHubTaskObservation = NonNullable<ReturnType<typeof captureGitHubTaskObservation>>
export type GitHubTaskFamily = 'state' | 'autoMerge' | 'assignees' | 'reviewRequests'
export type GitHubTaskValueOrigin = {
  kind: 'ordinary' | 'scalar' | 'list' | 'pending'
  owner?: GitHubTaskObservation
  coordinate?: string
  generation?: number
  completeFamily?: true
  listLifetime?: object
}
export type ObservedGitHubWorkItem = GitHubWorkItem & {
  githubObservation?: GitHubTaskObservation
  githubValueOrigins?: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin>>
}

export function getGitHubTaskObservation(item: ObservedGitHubWorkItem) {
  return item.githubObservation
}

export function isGitHubTaskObservationCurrent(
  owner: GitHubTaskObservation,
  repo: Repo | undefined
): boolean {
  return (
    !!repo && githubTaskBinding(repo) === owner.binding && isHostIdentityFenceCurrent(owner.fence)
  )
}

export function observeGitHubWorkItem(
  item: GitHubWorkItem,
  owner: GitHubTaskObservation | undefined,
  full = false
): ObservedGitHubWorkItem {
  if (!owner) {
    return item
  }
  const observed = { ...item, githubObservation: owner }
  return full ? qualifyGitHubTaskLists(observed, owner) : observed
}

export function qualifyGitHubTaskLists<T extends Omit<ObservedGitHubWorkItem, 'repoId'>>(
  item: T,
  owner: GitHubTaskObservation | undefined
): T {
  if (!owner) {
    return item
  }
  const origins = { ...item.githubValueOrigins }
  for (const family of ['assignees', 'reviewRequests'] as const) {
    if (item[family] !== undefined && (!origins[family] || origins[family]?.kind === 'ordinary')) {
      origins[family] = { kind: 'ordinary', owner, completeFamily: true }
    }
  }
  return { ...item, githubValueOrigins: origins }
}

export function gitHubTaskFamilyOrigin(
  item: Partial<ObservedGitHubWorkItem>,
  family: GitHubTaskFamily
): GitHubTaskValueOrigin | undefined {
  return (
    item.githubValueOrigins?.[family] ??
    (item.githubObservation ? { kind: 'ordinary', owner: item.githubObservation } : undefined)
  )
}

export function patchObservedGitHubWorkItem(
  item: ObservedGitHubWorkItem,
  patch: Partial<ObservedGitHubWorkItem>,
  origins: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin | undefined>>
): ObservedGitHubWorkItem {
  const nextOrigins = { ...item.githubValueOrigins, ...origins }
  for (const family of ['assignees', 'reviewRequests'] as const) {
    if (family in patch && !(family in origins)) {
      const previous = gitHubTaskFamilyOrigin(item, family)
      nextOrigins[family] = { kind: 'ordinary', owner: previous?.owner }
    }
  }
  return { ...item, ...patch, githubValueOrigins: nextOrigins }
}

export function plainGitHubWorkItem(item: ObservedGitHubWorkItem): GitHubWorkItem {
  const { githubObservation: _observation, githubValueOrigins: _origins, ...plain } = item
  return plain
}

export function createGitHubTaskObservationIndex(
  repos: readonly Repo[],
  sourceForRepo: (repo: Repo) => TaskSourceContext | null
) {
  const lookup = getGitHubRepoLookupIndex(repos)
  const observations = new Map<string, GitHubTaskObservation | undefined>()
  const defaults = new Map<Repo, TaskSourceContext | null>()
  return (
    item: Pick<GitHubWorkItem, 'repoId' | 'repoHostId'> &
      Pick<ObservedGitHubWorkItem, 'githubObservation'>,
    source?: TaskSourceContext | null
  ) => {
    const hostId = item.repoHostId ?? item.githubObservation?.hostId ?? source?.hostId
    const candidate = hostId
      ? lookup.findByHostAndId(hostId, item.repoId)
      : lookup.findById(item.repoId)
    const repo = hostId || candidate === lookup.findForWorkItem(item) ? candidate : undefined
    if (!repo) {
      return undefined
    }
    if (!source && !defaults.has(repo)) {
      defaults.set(repo, sourceForRepo(repo))
    }
    // SAFETY: the selected registered repo supplies its source; null retains the existing encoder failure.
    const context = (source ?? defaults.get(repo) ?? null)!
    const key = JSON.stringify([
      getRepoExecutionHostId(repo),
      repo.id,
      getTaskSourceCacheScope(context)
    ])
    if (!observations.has(key)) {
      observations.set(key, captureGitHubTaskObservation(repo, context))
    }
    return observations.get(key)
  }
}

export function sameGitHubTaskObservation(
  left: GitHubTaskObservation | undefined,
  right: GitHubTaskObservation | undefined
): boolean {
  return left?.key === right?.key || (!!left && !!right && left.aliases.includes(right.key))
}
