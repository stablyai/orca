import type { BaseRefSearchResult } from '../../../shared/repo-types'
import { legacyBaseRefSearchResult } from '../../../shared/base-ref-search-result'
import { callRuntimeRpc } from './runtime-rpc-client'
import { ipcOrRuntimeTargetForHostId } from './runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { isRuntimeRepoRefSearchQueryWithinLimit } from './runtime-repo-search-bounds'
import { REFUSED_WSL_READ_REPOLL_MS, watchRefusedWslRead } from './wsl-refused-read-watch'
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
  refusedWslDistro?: string
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

/** How often a refused default is re-asked from a host whose running signal cannot reach us. */
export const REFUSED_BASE_REF_REPOLL_MS = REFUSED_WSL_READ_REPOLL_MS

/** Loads the repo's default base ref, re-asking once a stopped WSL distro that refused it runs. */
export function watchRuntimeRepoBaseRefDefault(
  hostId: ExecutionHostId,
  repoId: string,
  handlers: {
    onResult: (result: RuntimeRepoBaseRefDefault) => void
    onError: (error: unknown) => void
  }
): () => void {
  return watchRefusedWslRead({
    hostId,
    read: () => getRuntimeRepoBaseRefDefault(hostId, repoId),
    refusedDistro: (result) => result.refusedWslDistro,
    ...handlers
  })
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
