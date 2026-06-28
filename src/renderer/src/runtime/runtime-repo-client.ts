import type { BaseRefSearchResult, GlobalSettings } from '../../../shared/types'
import { legacyBaseRefSearchResult } from '../../../shared/base-ref-search-result'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { isRuntimeRepoRefSearchQueryWithinLimit } from './runtime-repo-search-bounds'

export type RuntimeRepoBaseRefDefault = {
  defaultBaseRef: string | null
  remoteCount: number
}

type RuntimeRepoLookupOptions = {
  repoPath?: string | null
  executionHostId?: string | null
}

export async function getRuntimeRepoBaseRefDefault(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  options: RuntimeRepoLookupOptions = {}
): Promise<RuntimeRepoBaseRefDefault> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.repos.getBaseRefDefault({
      repoId,
      ...(options.repoPath ? { repoPath: options.repoPath } : {}),
      ...(options.executionHostId ? { executionHostId: options.executionHostId } : {})
    })
  }
  return callRuntimeRpc<RuntimeRepoBaseRefDefault>(
    target,
    'repo.baseRefDefault',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function searchRuntimeRepoBaseRefs(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  query: string,
  limit: number,
  options: RuntimeRepoLookupOptions = {}
): Promise<string[]> {
  if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.repos.searchBaseRefs({
      repoId,
      ...(options.repoPath ? { repoPath: options.repoPath } : {}),
      ...(options.executionHostId ? { executionHostId: options.executionHostId } : {}),
      query,
      limit
    })
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
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  query: string,
  limit: number,
  options: RuntimeRepoLookupOptions = {}
): Promise<BaseRefSearchResult[]> {
  if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.repos.searchBaseRefDetails({
      repoId,
      ...(options.repoPath ? { repoPath: options.repoPath } : {}),
      ...(options.executionHostId ? { executionHostId: options.executionHostId } : {}),
      query,
      limit
    })
  }
  const result = await callRuntimeRpc<{
    refs: string[]
    refDetails?: BaseRefSearchResult[]
    truncated: boolean
  }>(target, 'repo.searchRefs', { repo: repoId, query, limit }, { timeoutMs: 15_000 })
  return result.refDetails ?? result.refs.map(legacyBaseRefSearchResult)
}
