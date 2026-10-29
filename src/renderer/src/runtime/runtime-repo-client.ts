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

/**
 * Loads the repo's default base ref and, when a stopped WSL distro refused it (E9), loads it again
 * once main reports that distro running. Returns a cancel.
 */
export function watchRuntimeRepoBaseRefDefault(
  hostId: ExecutionHostId,
  repoId: string,
  handlers: {
    onResult: (result: RuntimeRepoBaseRefDefault) => void
    onError: (error: unknown) => void
  }
): () => void {
  let cancelled = false
  let stopRetry: (() => void) | null = null
  const load = (): void => {
    getRuntimeRepoBaseRefDefault(hostId, repoId).then(
      (result) => {
        if (cancelled) {
          return
        }
        handlers.onResult(result)
        const refused = result.refusedWslDistro?.toLowerCase()
        const onDistroRunning = window.api.preflight?.onWslDistroRunning
        if (refused && typeof onDistroRunning === 'function') {
          stopRetry = onDistroRunning((distro) => {
            if (distro.toLowerCase() === refused) {
              stopRetry?.()
              stopRetry = null
              load()
            }
          })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          handlers.onError(error)
        }
      }
    )
  }
  load()
  return () => {
    cancelled = true
    stopRetry?.()
  }
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
