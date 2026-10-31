import { normalizeGhAccountBinding } from '../../../shared/github/account-binding'

import { getTaskPageRepoSourceContext } from './task-repo-source-context'

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
    repo.projectHostSetupMethod,
    repo.issueSourcePreference,
    repo.gitRemoteIdentity?.canonicalKey,
    repo.gitRemoteIdentity?.remoteUrl
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
export type ObservedGitHubWorkItem = GitHubWorkItem & { githubObservation?: GitHubTaskObservation }
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
  owner: GitHubTaskObservation | undefined
): ObservedGitHubWorkItem {
  return owner ? { ...item, githubObservation: owner } : item
}
