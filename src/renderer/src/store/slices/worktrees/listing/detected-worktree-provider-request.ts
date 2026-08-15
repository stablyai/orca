import { callRuntimeRpc, getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { getEnvironmentSshStateGeneration } from '../../runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type { RuntimeWorktreeListResult } from '../../../../../../shared/runtime-types'
import type {
  HostQualifiedDetectedWorktreeResult,
  ListDetectedWorktreesArgs
} from '../../../../../../shared/detected-worktree-provider-contract'
import { REMOTE_WORKTREE_LIST_PARITY_LIMIT } from './worktree-slice-constants'
import type {
  BackgroundRuntimeRefreshOptions,
  DetectedWorktreeRefreshOptions
} from './worktree-slice-types'
import { isRuntimeMethodNotFoundError } from './runtime-worktree-rpc-errors'
import { toLegacyDetectedWorktreeResult } from './worktree-host-ownership'

export async function listDetectedWorktreesForRepo(
  settings: AppState['settings'],
  repoId: string,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<DetectedWorktreeListResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    throw new Error('Local detected-worktree reads require a provider lease')
  }
  try {
    return await callRuntimeRpc<DetectedWorktreeListResult>(
      target,
      'worktree.detectedList',
      { repo: repoId },
      {
        timeoutMs: 15_000,
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      }
    )
  } catch (error) {
    if (!isRuntimeMethodNotFoundError(error)) {
      throw error
    }
    const legacy = await callRuntimeRpc<RuntimeWorktreeListResult>(
      target,
      'worktree.list',
      { repo: repoId, limit: REMOTE_WORKTREE_LIST_PARITY_LIMIT },
      {
        timeoutMs: 15_000,
        reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
      }
    )
    return toLegacyDetectedWorktreeResult(repoId, legacy)
  }
}

export function detectedWorktreeRefreshKey(
  settings: AppState['settings'],
  repoId: string,
  options: DetectedWorktreeRefreshOptions
): string {
  const target = getActiveRuntimeTarget(settings)
  const targetKey = target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`
  const parts = [
    repoId,
    options.executionHostId,
    targetKey,
    options.requireAuthoritative === true ? 'authoritative' : 'best-effort'
  ]
  // Why: only remote targets run a compat preflight, so a foreground (reuse:false) refresh must re-probe not coalesce onto a stale-failure background scan; local targets have no preflight and stay coalesced.
  if (target.kind === 'environment') {
    parts.push(`connection:${getEnvironmentSshStateGeneration(target.environmentId)}`)
    parts.push(`runtime:${getRuntimeEnvironmentConnectionGeneration(target.environmentId)}`)
    parts.push(options.reuseRecentCompatibilityFailure === true ? 'reuse-failure' : 'reprobe')
  }
  return parts.join('\n')
}

export function isDetectedWorktreeListResult(value: unknown): value is DetectedWorktreeListResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const result = value as Partial<DetectedWorktreeListResult>
  return (
    typeof result.repoId === 'string' &&
    typeof result.authoritative === 'boolean' &&
    (result.source === 'git' ||
      result.source === 'metadata-fallback' ||
      result.source === 'session-fallback') &&
    Array.isArray(result.worktrees)
  )
}

export function rejectedDetectedWorktreeProviderResult(
  request: ListDetectedWorktreesArgs
): HostQualifiedDetectedWorktreeResult {
  return {
    providerRequestId: request.providerRequestId,
    executionHostId: request.executionHostId,
    status: 'rejected'
  }
}

export async function startDetectedWorktreeProviderRequest(
  request: ListDetectedWorktreesArgs
): Promise<HostQualifiedDetectedWorktreeResult> {
  const worktreesApi = window.api.worktrees as typeof window.api.worktrees & {
    listDetected?: typeof window.api.worktrees.listDetected
  }
  if (typeof worktreesApi.listDetected !== 'function') {
    if (request.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return rejectedDetectedWorktreeProviderResult(request)
    }
    const worktrees = await worktreesApi.list({ repoId: request.repoId })
    return {
      status: 'complete',
      providerRequestId: request.providerRequestId,
      repoId: request.repoId,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      result: toLegacyDetectedWorktreeResult(request.repoId, { worktrees })
    }
  }
  const result = await worktreesApi.listDetected(request)
  if (result && typeof result === 'object' && 'status' in result && 'providerRequestId' in result) {
    return result as unknown as HostQualifiedDetectedWorktreeResult
  }
  // Why: web and older preload implementations return the legacy local shape.
  if (request.executionHostId === LOCAL_EXECUTION_HOST_ID && isDetectedWorktreeListResult(result)) {
    return {
      status: result.authoritative ? 'complete' : 'non-authoritative',
      providerRequestId: request.providerRequestId,
      repoId: request.repoId,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      result
    }
  }
  return rejectedDetectedWorktreeProviderResult(request)
}
