import type { BaseRefSearchResult } from '../../../shared/repo-types'
import { legacyBaseRefSearchResult } from '../../../shared/base-ref-search-result'
import { callRuntimeRpc } from './runtime-rpc-client'
import { ipcOrRuntimeTargetForHostId } from './runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { isRuntimeRepoRefSearchQueryWithinLimit } from './runtime-repo-search-bounds'
import type { ExecutionHostId } from '../../../shared/execution-host'

/** The repo's own host: a server's runtime, or this app (with `hostId`) for local and SSH repos. */
function repoHostTarget(hostId: ExecutionHostId): RuntimeClientTarget {
  const target = ipcOrRuntimeTargetForHostId(hostId)
  if (!target) {
    throw new Error('The project host is unresolved.')
  }
  return target
}

export type RuntimeRepoBaseRefDefault = {
  defaultBaseRef: string | null
  remoteCount: number
}

export async function getRuntimeRepoBaseRefDefault(
  hostId: ExecutionHostId,
  repoId: string
): Promise<RuntimeRepoBaseRefDefault> {
  const target = repoHostTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.repos.getBaseRefDefault({ repoId, hostId })
  }
  return callRuntimeRpc<RuntimeRepoBaseRefDefault>(
    target,
    'repo.baseRefDefault',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function searchRuntimeRepoBaseRefs(
  hostId: ExecutionHostId,
  repoId: string,
  query: string,
  limit: number
): Promise<string[]> {
  if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
    return []
  }
  const target = repoHostTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.repos.searchBaseRefs({ repoId, query, limit, hostId })
  }
  const result = await callRuntimeRpc<{ refs: string[]; truncated: boolean }>(
    target,
    'repo.searchRefs',
    { repo: repoId, query, limit },
    { timeoutMs: 15_000 }
  )
  return result.refs
}

export async function searchRuntimeRepoBaseRefDetails(
  hostId: ExecutionHostId,
  repoId: string,
  query: string,
  limit: number
): Promise<BaseRefSearchResult[]> {
  if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
    return []
  }
  const target = repoHostTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.repos.searchBaseRefDetails({
      repoId,
      query,
      limit,
      hostId
    })
  }
  const result = await callRuntimeRpc<{
    refs: string[]
    refDetails?: BaseRefSearchResult[]
    truncated: boolean
  }>(target, 'repo.searchRefs', { repo: repoId, query, limit }, { timeoutMs: 15_000 })
  return result.refDetails ?? result.refs.map(legacyBaseRefSearchResult)
}
