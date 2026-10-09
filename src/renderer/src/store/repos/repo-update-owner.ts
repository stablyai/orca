import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '../types'
import type { RepoUpdateOwnerOptions } from './repo-state'
import {
  findRepoForHost,
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../slices/repo-host-identity'
import { getRepoCatalogOwnerHostId } from '../projects/project-catalog-owner'
import { getProjectSetupRuntimeTarget } from '../projects/project-host-routing'
import { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '../../runtime/runtime-environment-revision'
import { settingsForRepoOwner } from './owner-routing'

function ownerRuntimeId(state: AppState, environmentId: string): string | undefined {
  return (
    state.runtimeEnvironments.find((environment) => environment.id === environmentId)?.runtimeId ??
    state.runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId ??
    undefined
  )
}

export function captureRepoUpdateOwner(
  state: AppState,
  repoId: string,
  options?: RepoUpdateOwnerOptions
) {
  if (
    Object.values(options ?? {}).some(
      (hostId) =>
        hostId !== undefined &&
        (typeof hostId !== 'string' || parseExecutionHostId(hostId)?.id !== hostId)
    )
  ) {
    return null
  }
  const hasSelector = Boolean(
    options?.hostId || options?.authoritativeExecutionHostId || options?.catalogOwnerHostId
  )
  const candidates = hasSelector
    ? state.repos.filter(
        (repo) =>
          repo.id === repoId &&
          (!options?.hostId || getRepoExecutionHostId(repo) === options.hostId) &&
          (!options?.authoritativeExecutionHostId ||
            (repo.authoritativeExecutionHostId ?? getRepoExecutionHostId(repo)) ===
              options.authoritativeExecutionHostId) &&
          (!options?.catalogOwnerHostId ||
            getRepoCatalogOwnerHostId(repo) === options.catalogOwnerHostId)
      )
    : [findRepoForHost(state.repos, repoId, { settings: state.settings })].filter(
        (repo): repo is Repo => repo !== null
      )
  if (candidates.length !== 1) {
    return null
  }
  const repo = candidates[0]
  const hostId = getRepoExecutionHostId(repo)
  const publisherHost = parseExecutionHostId(getRepoCatalogOwnerHostId(repo))
  const rawHost = parseExecutionHostId(repo.authoritativeExecutionHostId ?? hostId)
  if (
    !publisherHost ||
    !rawHost ||
    publisherHost.id !== getRepoCatalogOwnerHostId(repo) ||
    rawHost.id !== (repo.authoritativeExecutionHostId ?? hostId)
  ) {
    return null
  }
  const explicitHost = Boolean(
    options?.hostId || repo.executionHostId?.trim() || repo.connectionId?.trim()
  )
  const target =
    repo.catalogOwnerHostId || repo.authoritativeExecutionHostId
      ? getProjectSetupRuntimeTarget(publisherHost.id)
      : explicitHost
        ? getProjectSetupRuntimeTarget(hostId)
        : getActiveRuntimeTarget(settingsForRepoOwner(state, repoId))
  const qualified = target.kind === 'environment' && repo.authoritativeExecutionHostId !== undefined
  return {
    repo,
    hostId,
    publisherHostId: publisherHost.id,
    rawHostId: rawHost.id,
    qualified,
    hasRawOwner: repo.authoritativeExecutionHostId !== undefined,
    explicitHost,
    target,
    queueKey: JSON.stringify([getRepoHostIdentity(repo), target]),
    legacyQueueKey: JSON.stringify([getRepoHostIdentityForParts(repo.id, hostId), target]),
    pairingRevision:
      target.kind === 'environment'
        ? getRuntimeEnvironmentRevision(target.environmentId)
        : undefined,
    runtimeId:
      target.kind === 'environment' ? ownerRuntimeId(state, target.environmentId) : undefined
  }
}

export type RepoUpdateOwner = NonNullable<ReturnType<typeof captureRepoUpdateOwner>>

export function findCapturedRepoUpdateOwner(state: AppState, owner: RepoUpdateOwner): Repo | null {
  const candidates = state.repos.filter(
    (repo) =>
      repo.id === owner.repo.id &&
      getRepoExecutionHostId(repo) === owner.hostId &&
      getRepoCatalogOwnerHostId(repo) === owner.publisherHostId &&
      (!owner.hasRawOwner || getRepoHostIdentity(repo) === getRepoHostIdentity(owner.repo))
  )
  if (
    candidates.length !== 1 ||
    candidates[0].path !== owner.repo.path ||
    candidates[0].addedAt !== owner.repo.addedAt
  ) {
    return null
  }
  if (owner.target.kind === 'environment') {
    const id = owner.target.environmentId
    const expectedRevision =
      owner.pairingRevision === undefined
        ? undefined
        : resolveContinuedRuntimeEnvironmentRevision(id, owner.pairingRevision)
    if (
      getRuntimeEnvironmentRevision(id) !== expectedRevision ||
      (owner.runtimeId !== undefined && ownerRuntimeId(state, id) !== owner.runtimeId)
    ) {
      return null
    }
  }
  return candidates[0]
}

export function repoUpdateResponseMatchesOwner(repo: Repo, owner: RepoUpdateOwner): boolean {
  return (
    repo.id === owner.repo.id &&
    ((!owner.qualified && (owner.target.kind === 'environment' || !owner.explicitHost)) ||
      (getRepoExecutionHostId(repo) === owner.rawHostId &&
        (repo.authoritativeExecutionHostId === undefined ||
          repo.authoritativeExecutionHostId === owner.rawHostId)))
  )
}
