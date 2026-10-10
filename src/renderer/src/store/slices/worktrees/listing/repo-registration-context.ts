import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoKind } from '../../../../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getRepoHostIdentity } from '../../repo-host-identity'
import { getRepoCatalogOwnerHostId } from '../../../projects/project-catalog-owner'

type CapturedRepoRegistration = Readonly<{
  ownerKey: string
  publisherHostId: string
  rawHostId: string
  path: string
  addedAt: number
  kind: 'git' | 'folder'
}>

export type RepoRegistrationContext = Readonly<{
  repoId: string
  executionHostId: ExecutionHostId
  registrations: readonly CapturedRepoRegistration[]
}>

const registrationsByRepos = new WeakMap<
  readonly Repo[],
  ReadonlyMap<string, readonly CapturedRepoRegistration[]>
>()
const NO_REGISTRATIONS: readonly CapturedRepoRegistration[] = []

function registrationGroupKey(repoId: string, executionHostId: ExecutionHostId): string {
  return JSON.stringify([repoId, executionHostId])
}

function repoRegistrationIndex(
  repos: readonly Repo[]
): ReadonlyMap<string, readonly CapturedRepoRegistration[]> {
  const cached = registrationsByRepos.get(repos)
  if (cached) {
    return cached
  }
  const index = new Map<string, CapturedRepoRegistration[]>()
  for (const repo of repos) {
    const key = registrationGroupKey(repo.id, getRepoExecutionHostId(repo))
    const rows = index.get(key) ?? []
    rows.push({
      ownerKey: getRepoHostIdentity(repo),
      publisherHostId: getRepoCatalogOwnerHostId(repo),
      rawHostId: repo.authoritativeExecutionHostId ?? getRepoExecutionHostId(repo),
      path: repo.path,
      addedAt: repo.addedAt,
      kind: getRepoKind(repo)
    })
    index.set(key, rows)
  }
  registrationsByRepos.set(repos, index)
  return index
}

export function captureRepoRegistrationContext(
  repos: readonly Repo[],
  repoId: string,
  executionHostId: ExecutionHostId
): RepoRegistrationContext {
  return {
    repoId,
    executionHostId,
    registrations:
      repoRegistrationIndex(repos).get(registrationGroupKey(repoId, executionHostId)) ??
      NO_REGISTRATIONS
  }
}

export function repoRegistrationContextKey(context: RepoRegistrationContext): string {
  return JSON.stringify([
    context.repoId,
    context.executionHostId,
    context.registrations.map((registration) => JSON.stringify(registration)).sort()
  ])
}

export function repoRegistrationContextIsCurrent(
  repos: readonly Repo[],
  context: RepoRegistrationContext
): boolean {
  return (
    repoRegistrationContextKey(context) ===
    repoRegistrationContextKey(
      captureRepoRegistrationContext(repos, context.repoId, context.executionHostId)
    )
  )
}
