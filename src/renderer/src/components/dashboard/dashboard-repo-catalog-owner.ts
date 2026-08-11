import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo, Worktree } from '../../../../shared/types'

type CatalogAuthority =
  | { kind: 'qualified'; hostId: ExecutionHostId }
  | { kind: 'legacy' }
  | { kind: 'invalid' }

export type DashboardRepoCatalogOwner = {
  repo: Repo
  repoExecutionHostId: ExecutionHostId
  transportExecutionHostId: ExecutionHostId
  hasRepoIdCollision: boolean
}

function repoAuthority(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): CatalogAuthority {
  const explicitValue = repo.executionHostId
  const explicitHost = parseExecutionHostId(explicitValue)
  if (explicitValue != null && !explicitHost) {
    return { kind: 'invalid' }
  }

  const connectionValue = repo.connectionId
  const connectionHost =
    connectionValue === null
      ? 'local'
      : typeof connectionValue === 'string' && connectionValue.trim()
        ? toSshExecutionHostId(connectionValue.trim())
        : null
  if (typeof connectionValue === 'string' && !connectionHost) {
    return { kind: 'invalid' }
  }
  if (explicitHost) {
    if (
      explicitHost.kind !== 'runtime' &&
      connectionValue !== undefined &&
      connectionHost !== explicitHost.id
    ) {
      return { kind: 'invalid' }
    }
    return { kind: 'qualified', hostId: explicitHost.id }
  }
  return connectionValue === undefined
    ? { kind: 'legacy' }
    : connectionHost
      ? { kind: 'qualified', hostId: connectionHost }
      : { kind: 'legacy' }
}

function worktreeAuthority(
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): CatalogAuthority {
  const hostValue = worktree.hostId
  const physicalHost = parseExecutionHostId(hostValue)
  if (hostValue != null && !physicalHost) {
    return { kind: 'invalid' }
  }

  const runtimeValue = worktree.runtimeOwnerEnvironmentId
  const runtimeEnvironmentId = runtimeValue?.trim()
  if (runtimeValue !== undefined && !runtimeEnvironmentId) {
    return { kind: 'invalid' }
  }
  if (runtimeEnvironmentId) {
    const runtimeHostId = toRuntimeExecutionHostId(runtimeEnvironmentId)
    if (physicalHost?.kind === 'runtime' && physicalHost.id !== runtimeHostId) {
      return { kind: 'invalid' }
    }
    return { kind: 'qualified', hostId: runtimeHostId }
  }
  return physicalHost ? { kind: 'qualified', hostId: physicalHost.id } : { kind: 'legacy' }
}

export function resolveDashboardRepoCatalogOwner(
  candidates: readonly Repo[],
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): DashboardRepoCatalogOwner | null {
  if (candidates.length === 0) {
    return null
  }
  const candidateAuthorities = candidates.map((repo) => ({ repo, authority: repoAuthority(repo) }))
  const worktreeOwner = worktreeAuthority(worktree)
  if (worktreeOwner.kind === 'invalid') {
    return null
  }

  let match: (typeof candidateAuthorities)[number] | undefined
  if (candidates.length === 1) {
    const only = candidateAuthorities[0]
    if (
      only.authority.kind === 'invalid' ||
      (only.authority.kind === 'qualified' &&
        worktreeOwner.kind === 'qualified' &&
        only.authority.hostId !== worktreeOwner.hostId)
    ) {
      return null
    }
    match = only
  } else {
    if (
      worktreeOwner.kind !== 'qualified' ||
      candidateAuthorities.some(({ authority }) => authority.kind !== 'qualified')
    ) {
      return null
    }
    const matches = candidateAuthorities.filter(
      ({ authority }) => authority.kind === 'qualified' && authority.hostId === worktreeOwner.hostId
    )
    if (matches.length !== 1) {
      return null
    }
    match = matches[0]
  }

  const repoExecutionHostId =
    match.authority.kind === 'qualified'
      ? match.authority.hostId
      : getRepoExecutionHostId(match.repo)
  const transportExecutionHostId =
    worktreeOwner.kind === 'qualified' ? worktreeOwner.hostId : repoExecutionHostId
  return {
    repo: match.repo,
    repoExecutionHostId,
    transportExecutionHostId,
    hasRepoIdCollision: candidates.length > 1
  }
}

export function dashboardRepoProjectId(owner: DashboardRepoCatalogOwner): string {
  return owner.hasRepoIdCollision
    ? `${owner.repo.id}@${encodeURIComponent(owner.repoExecutionHostId)}`
    : owner.repo.id
}
