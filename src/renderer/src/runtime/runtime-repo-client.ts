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

/** How often a refused default is re-asked from a host whose running signal cannot reach us. */
export const REFUSED_BASE_REF_REPOLL_MS = 30_000

/**
 * Loads the repo's default base ref and, while a stopped WSL distro refuses it (E9), re-asks once
 * that distro runs: on main's running signal for this app's repos, or for a paired host (whose
 * signal never reaches this window) on window focus and every 30 s while visible. Returns a cancel.
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
  let inFlight = false
  let refused: string | null = null
  // Running signals that land while main is still answering would otherwise be missed.
  let ranDuringRead = new Set<string>()
  let repoll: ReturnType<typeof setInterval> | null = null
  const onDistroRunning = window.api.preflight?.onWslDistroRunning
  const hearsHostSignal =
    ipcOrRuntimeTargetForHostId(hostId)?.kind === 'local' && typeof onDistroRunning === 'function'

  const reaskFromPairedHost = (): void => {
    if (refused && !inFlight && document.visibilityState === 'visible') {
      load()
    }
  }
  const syncRepoll = (): void => {
    if (refused && !hearsHostSignal && !repoll) {
      repoll = setInterval(reaskFromPairedHost, REFUSED_BASE_REF_REPOLL_MS)
    } else if (!refused && repoll) {
      clearInterval(repoll)
      repoll = null
    }
  }
  function load(): void {
    inFlight = true
    ranDuringRead = new Set()
    getRuntimeRepoBaseRefDefault(hostId, repoId).then(
      (result) => {
        inFlight = false
        if (cancelled) {
          return
        }
        handlers.onResult(result)
        refused = result.refusedWslDistro?.toLowerCase() ?? null
        syncRepoll()
        if (refused && ranDuringRead.has(refused)) {
          load()
        }
      },
      (error: unknown) => {
        inFlight = false
        if (!cancelled) {
          handlers.onError(error)
        }
      }
    )
  }

  // Subscribed before the first read, so no running signal can fall between answer and listener.
  const stopListening =
    hearsHostSignal && onDistroRunning
      ? onDistroRunning((distro) => {
          const key = distro.toLowerCase()
          if (inFlight) {
            ranDuringRead.add(key)
          } else if (key === refused) {
            load()
          }
        })
      : null
  if (!hearsHostSignal) {
    window.addEventListener('focus', reaskFromPairedHost)
  }
  load()
  return () => {
    cancelled = true
    stopListening?.()
    if (!hearsHostSignal) {
      window.removeEventListener('focus', reaskFromPairedHost)
    }
    if (repoll) {
      clearInterval(repoll)
    }
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
