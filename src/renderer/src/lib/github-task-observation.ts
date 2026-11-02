import { getTaskPageRepoSourceContext } from './task-repo-source-context'

import type { Repo } from '../../../shared/repo-types'

import type { TaskSourceContext } from '../../../shared/task-source-context'

import {
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope,
  areTaskSourceContextsEqual
} from '../../../shared/task-source-context'

import { getRepoExecutionHostId } from '../../../shared/execution-host'

import { parseHostAuthorityKey } from '../../../shared/host-authority'

import { hostRouteForAuthority } from '@/runtime/runtime-client-target'

import { captureHostIdentityFence } from '@/store/host-catalog-fencing'

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

/** The repo binding a read or write was captured under, plus every Tasks source scope its rows live in. */
export function captureGitHubTaskObservation(
  repo: Repo,
  source: TaskSourceContext | null | undefined
) {
  const hostId = getRepoExecutionHostId(repo)
  const authority = parseHostAuthorityKey(hostId)
  if (!authority) {
    return undefined
  }
  const fence = captureHostIdentityFence(hostRouteForAuthority(authority))
  // SAFETY: registered repo IDs produce a context; preserve the existing failure for an invalid ID.
  const context =
    source ?? buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })!
  const legacy = buildTaskSourceContextFromRepo({ provider: 'github', projectId: repo.id, repo })
  const ordinary = getTaskPageRepoSourceContext(repo, 'github')
  const sources = areTaskSourceContextsEqual(context, legacy)
    ? [context, ordinary]
    : areTaskSourceContextsEqual(context, ordinary)
      ? [context, legacy]
      : [context]
  return {
    repoId: repo.id,
    hostId,
    source: context,
    fence,
    associations: sources.flatMap((entry) =>
      entry ? [{ source: entry, scope: getTaskSourceCacheScope(entry) }] : []
    )
  }
}

export type GitHubTaskObservation = NonNullable<ReturnType<typeof captureGitHubTaskObservation>>
