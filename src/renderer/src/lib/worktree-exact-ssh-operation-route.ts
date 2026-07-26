import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/types'
import type { WorktreeOperationRouteResolution } from './worktree-operation-route'

type ExactSshRouteRepo = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

type ExactSshRouteOwner = {
  repoId: string
  hostId?: ExecutionHostId
}

export function resolveRepoRouteForExactSshOwner(
  repos: readonly ExactSshRouteRepo[] | undefined,
  owner: ExactSshRouteOwner
): WorktreeOperationRouteResolution {
  const parsedHost = parseExecutionHostId(owner.hostId)
  if (!repos || parsedHost?.kind !== 'ssh') {
    return { kind: 'missing' }
  }

  let hasExactSshRepo = false
  const pairedRuntimeHosts = new Set<ExecutionHostId>()
  for (const repo of repos) {
    if (repo.id !== owner.repoId) {
      continue
    }
    const repoHostId = getRepoExecutionHostId(repo)
    if (repoHostId === parsedHost.id) {
      hasExactSshRepo = true
      continue
    }
    if (
      repo.connectionId?.trim() === parsedHost.targetId &&
      parseExecutionHostId(repoHostId)?.kind === 'runtime'
    ) {
      pairedRuntimeHosts.add(repoHostId)
    }
  }

  const pairedRuntimeHost = pairedRuntimeHosts.values().next().value
  if (pairedRuntimeHosts.size === 1 && pairedRuntimeHost) {
    const parsedRuntimeHost = parseExecutionHostId(pairedRuntimeHost)
    return {
      kind: 'resolved',
      route: {
        executionHostId: parsedHost.id,
        runtimeEnvironmentId:
          parsedRuntimeHost?.kind === 'runtime' ? parsedRuntimeHost.environmentId : null
      }
    }
  }
  if (pairedRuntimeHosts.size > 1) {
    return { kind: 'ambiguous' }
  }
  if (hasExactSshRepo) {
    return {
      kind: 'resolved',
      route: { executionHostId: parsedHost.id, runtimeEnvironmentId: null }
    }
  }
  return { kind: 'missing' }
}
